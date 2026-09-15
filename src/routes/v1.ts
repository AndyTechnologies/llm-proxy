/**
 * OpenAI-compatible /v1 surface (external-proxy + gateway-security specs):
 * POST /v1/chat/completions, POST /v1/completions, GET /v1/models — served
 * on port 4317 (wired as an optional dispatcher behind the app server).
 *
 * Routing: model ids resolve to an external provider adapter (OpenAI wire),
 * to the managed local backend, or to a virtual chain model. Unmapped models
 * get the OpenAI unknown-model 404 envelope. Streaming relays OpenAI-wire
 * SSE with exactly one terminal `data: [DONE]` and aborts the upstream call
 * when the client disconnects. The legacy /v1/completions API is a thin
 * prompt→chat wrapper over the same routing.
 *
 * Auth (gateway-security) is injected as an optional gate — off by default.
 */
import type { Provider } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  chatStreamWithFallback,
  chatWithFallback,
} from "../providers/fallback.js";
import { makeCompletionId } from "../utils/ids.js";
import { sseResponse } from "./relay.js";
import type { Embedder } from "../providers/embeddings.js";

export interface V1HandlerDeps {
  /** External provider adapters (keychain-backed, with fallback links). */
  registry: ProviderRegistry;
  /** The managed llama-server backend provider, or null when unavailable. */
  localProvider: () => Provider | null;
  /** Model ids the managed backend currently serves. */
  localModels: () => string[];
  /** Virtual chain model ids (gateway/<chain>) to advertise. */
  virtualModels?: () => string[];
  /** Embedder over the local backend (/v1/embeddings), or null when absent. */
  embeddings?: () => Embedder | null;
  /**
   * Optional request gate (gateway-security): returns true to admit the
   * request. When absent, auth is disabled (default) and all /v1 requests
   * proceed.
   */
  auth?: (req: Request) => Promise<boolean>;
}

/** Handler returns null when the path is not a /v1 surface it owns. */
export type V1Dispatcher = (req: Request) => Promise<Response | null>;

function unknownModelError(model: string): Response {
  return Response.json(
    {
      error: {
        message: `The model '${model}' does not exist`,
        type: "invalid_request_error",
        param: null,
        code: "model_not_found",
      },
    },
    { status: 404 },
  );
}

function badRequest(message: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", param: null, code: null } },
    { status: 400 },
  );
}

function providerError(err: unknown): Response {
  const status = (err as { status?: unknown } | null)?.status;
  let resStatus = 502;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    resStatus = status;
  }
  const message = err instanceof Error ? err.message : "upstream provider error";
  const type =
    resStatus === 429 ? "rate_limit_error" : resStatus >= 500 ? "api_error" : "invalid_request_error";
  return Response.json(
    { error: { message, type, param: null, code: null } },
    { status: resStatus },
  );
}

type ModelTarget =
  | { kind: "external"; adapterKind: string }
  | { kind: "local"; provider: Provider };

function resolveModel(deps: V1HandlerDeps, model: string): ModelTarget | null {
  for (const adapter of deps.registry.adapters.values()) {
    if (adapter.models.includes(model)) {
      return { kind: "external", adapterKind: adapter.kind };
    }
  }
  const local = deps.localProvider();
  if (local !== null && deps.localModels().includes(model)) {
    return { kind: "local", provider: local };
  }
  return null;
}

/** Convert one chat completion into the legacy text_completion shape. */
function toTextCompletion(
  completion: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choices = completion.choices;
  const first =
    Array.isArray(choices) && choices.length > 0
      ? (choices[0] as { message?: { content?: unknown }; finish_reason?: unknown })
      : undefined;
  const content = first?.message?.content;
  return {
    id: typeof completion.id === "string" ? completion.id : makeCompletionId(),
    object: "text_completion",
    created: completion.created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        text: typeof content === "string" ? content : "",
        index: 0,
        logprobs: null,
        finish_reason: first?.finish_reason ?? null,
      },
    ],
    usage: completion.usage ?? null,
  };
}

/** Translate a chat SSE payload stream into text_completion chunk payloads. */
async function* toTextChunks(
  chatSource: AsyncIterable<string>,
  model: string,
): AsyncIterable<string> {
  for await (const payload of chatSource) {
    let chunk: {
      id?: unknown;
      created?: unknown;
      choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
    };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    const text = typeof choice?.delta?.content === "string" ? choice.delta.content : "";
    yield JSON.stringify({
      id: typeof chunk.id === "string" ? chunk.id : makeCompletionId(),
      object: "text_completion",
      created: chunk.created ?? Math.floor(Date.now() / 1000),
      model,
      choices: [
        { text, index: 0, logprobs: null, finish_reason: choice?.finish_reason ?? null },
      ],
    });
  }
}

/** Wire client-disconnect to an upstream AbortController and relay as SSE. */
async function streamResponse(
  source: AsyncIterable<string>,
  req: Request,
): Promise<Response> {
  const upstreamAbort = new AbortController();
  const onAbort = () => upstreamAbort.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  // sseResponse waits for the generator to unwind; the generator awaits the
  // upstream fetch read, which rejects when upstreamAbort fires.
  return sseResponse(source, req.signal);
}

/** Build the /v1 OpenAI-compatible dispatcher (null = decline the path). */
export function makeV1Handler(deps: V1HandlerDeps): V1Dispatcher {
  const { registry } = deps;

  const handleChat = async (
    req: Request,
    model: string,
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const stream = body.stream === true;
    const target = resolveModel(deps, model);
    if (target === null) return unknownModelError(model);

    try {
      if (target.kind === "local") {
        const local = target.provider;
        if (stream) {
          return streamResponse(
            local.chatStream({ ...body, stream: true }, new AbortController().signal),
            req,
          );
        }
        return Response.json(await local.chat({ ...body, stream: false }));
      }
      if (stream) {
        const source = chatStreamWithFallback(registry, target.adapterKind, body, new AbortController().signal);
        return streamResponse(source, req);
      }
      return Response.json(
        await chatWithFallback(registry, target.adapterKind, { ...body, stream: false }),
      );
    } catch (err) {
      return providerError(err);
    }
  };

  const handleEmbeddings = async (body: Record<string, unknown>): Promise<Response> => {
    const embedder = deps.embeddings?.() ?? null;
    const model = typeof body.model === "string" ? body.model : "local";
    if (embedder === null) return unknownModelError(model);
    const input = body.input;
    if (typeof input !== "string" && !Array.isArray(input)) {
      return badRequest("The 'input' field is required (string or array of strings)");
    }
    if (Array.isArray(input) && input.some((i) => typeof i !== "string")) {
      return badRequest("The 'input' array must contain only strings");
    }
    try {
      return Response.json(await embedder.embed(input as string | string[]));
    } catch (err) {
      return providerError(err);
    }
  };

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);

    if (deps.auth !== undefined && !(await deps.auth(req))) {
      return Response.json(
        {
          error: {
            message: "Unauthorized",
            type: "authentication_error",
            param: null,
            code: null,
          },
        },
        { status: 401 },
      );
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data: Array<Record<string, unknown>> = [];
      for (const adapter of registry.adapters.values()) {
        for (const id of adapter.models) {
          data.push({ id, object: "model", created: 0, owned_by: adapter.kind });
        }
      }
      if (deps.localProvider() !== null) {
        for (const id of deps.localModels()) {
          data.push({ id, object: "model", created: 0, owned_by: "local" });
        }
      }
      for (const id of deps.virtualModels?.() ?? []) {
        data.push({ id, object: "model", created: 0, owned_by: "gateway" });
      }
      return Response.json({ object: "list", data });
    }

    if (req.method !== "POST") return null;
    if (
      url.pathname !== "/v1/chat/completions" &&
      url.pathname !== "/v1/completions" &&
      url.pathname !== "/v1/embeddings"
    ) {
      return null;
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return badRequest("Invalid JSON body");
    }

    // /v1/embeddings needs no `model` requirement — route it first.
    if (url.pathname === "/v1/embeddings") {
      return handleEmbeddings(body);
    }

    const model = typeof body.model === "string" ? body.model : null;
    if (model === null) return badRequest("The 'model' field is required");

    if (url.pathname === "/v1/chat/completions") {
      return handleChat(req, model, body);
    }

    // Legacy /v1/completions: wrap prompt as a single user chat message.
    const prompt = body.prompt;
    if (typeof prompt !== "string" && !Array.isArray(prompt)) {
      return badRequest("The 'prompt' field is required");
    }
    const content = Array.isArray(prompt)
      ? prompt.map((p) => (typeof p === "string" ? p : "")).join("")
      : prompt;
    const chatBody: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content }],
    };
    for (const key of ["max_tokens", "temperature", "top_p", "stop", "user", "stream"] as const) {
      if (body[key] !== undefined) chatBody[key] = body[key];
    }

    const stream = body.stream === true;
    const target = resolveModel(deps, model);
    if (target === null) return unknownModelError(model);

    try {
      let chatResult: Record<string, unknown>;
      if (target.kind === "local") {
        const local = target.provider;
        if (stream) {
          return streamResponse(
            toTextChunks(
              local.chatStream({ ...chatBody, stream: true }, new AbortController().signal),
              model,
            ),
            req,
          );
        }
        chatResult = await local.chat({ ...chatBody, stream: false });
      } else if (stream) {
        return streamResponse(
          toTextChunks(
            chatStreamWithFallback(registry, target.adapterKind, chatBody, new AbortController().signal),
            model,
          ),
          req,
        );
      } else {
        chatResult = await chatWithFallback(registry, target.adapterKind, {
          ...chatBody,
          stream: false,
        });
      }
      return Response.json(toTextCompletion(chatResult, model));
    } catch (err) {
      return providerError(err);
    }
  };
}