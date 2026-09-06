/**
 * POST /v1/completions route handler (Bun.serve fetch handler).
 *
 * Legacy text completions endpoint. Converts the prompt-based request into
 * a chat-formatted request internally (prompt → messages[{role:"user"}]),
 * then dispatches to chain or provider using the same logic as chat.ts.
 *
 * Converted from an Express handler to a plain fetch handler returning
 * `Promise<Response>` (S2b). The SSE idle-timeout disable
 * (`server.timeout(req, 0)`) is applied by the Bun.serve dispatcher in
 * server.ts.
 *
 * For passthrough (non-chain) requests, the payload is forwarded to the
 * backend via the passthrough forwarder, which re-serializes the parsed
 * body and streams the upstream response back (see middleware/proxy.ts).
 */
import { completionRequestSchema } from "../types/zod.js";
import { createPassthroughProxy } from "../middleware/proxy.js";
import type { ProviderMap } from "../orchestrator/engine.js";
import { runGraphEngine } from "../orchestrator/graph-engine.js";
import { buildStreamBody } from "../orchestrator/engine.js";
import type { GraphPipeline } from "../orchestrator/graph.js";
import { makeChatCompletionId } from "../utils/ids.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface CompletionsRouteDeps {
  providers: ProviderMap;
  manager: LlamaServeManager;
  requestTimeoutMs: number;
  /** Graph pipeline lookup — resolves chain name to graph for dispatch. */
  getGraph: (id: string) => GraphPipeline | undefined;
  /** F2 lifecycle hook forwarded to the passthrough proxy. */
  noteActivity?: (model: string) => (() => void) | void;
  /**
   * External provider model registry (model id → provider name). Requests for
   * these models are dispatched to the external provider (see chat.ts).
   */
  externalModels?: Map<string, string>;
}

const CHAIN_PREFIX = "gateway/";
const JSON_HEADERS = { "Content-Type": "application/json" };

/** SSE headers for streamed responses (mirrors graph-engine.ts). */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function jsonError(
  message: string,
  type: string,
  param: string | null,
  code: string | null,
  status: number,
): Response {
  return new Response(JSON.stringify({ error: { message, type, param, code } }), {
    status,
    headers: JSON_HEADERS,
  });
}

export function createCompletionsHandler(deps: CompletionsRouteDeps) {
  const passthroughProxy = createPassthroughProxy(
    () => deps.manager,
    deps.requestTimeoutMs,
    { noteActivity: deps.noteActivity },
  );
  const externalModels = deps.externalModels ?? new Map();

  return async (req: Request): Promise<Response> => {
    // ── Read + Zod validation ──
    let rawBody: Record<string, unknown>;
    let parsed;
    try {
      rawBody = (await req.json()) as Record<string, unknown>;
      parsed = completionRequestSchema.parse(rawBody);
    } catch (err) {
      throw err;
    }

    // ── Convert prompt → messages for chain routing ──
    const prompt =
      typeof parsed.prompt === "string"
        ? parsed.prompt
        : Array.isArray(parsed.prompt)
          ? parsed.prompt.join("\n")
          : "";

    const chatPayload: Record<string, unknown> = {
      // Raw validated body (see chat.ts): zod strips unknown keys, and
      // OpenAI-compatible extras must survive for chain steps.
      ...rawBody,
      messages: [{ role: "user", content: prompt }],
    };

    // ── Resolve chain vs provider ──
    const chainId = resolveChainId(
      parsed.model,
      req.headers.get("x-chain-id") ?? undefined,
    );

    if (chainId) {
      // Graph-only dispatch: resolve the chain name to a GraphPipeline.
      const graph = deps.getGraph(chainId);
      if (!graph) {
        return jsonError(
          `Chain "${chainId}" not found`,
          "invalid_request_error",
          "model",
          "model_not_found",
          404,
        );
      }

      // Backend availability gate for chains (external-mode: must 503 like
      // passthrough, not surface a raw fetch TypeError as a 500).
      if (!backendAvailable(deps.manager)) {
        return jsonError(
          "Backend not available",
          "server_error",
          null,
          "backend_unavailable",
          503,
        );
      }

      const result = await runGraphEngine(
        graph,
        { providers: deps.providers, getPipeline: deps.getGraph },
        {
          streamRequested: chatPayload.stream === true,
          payload: chatPayload,
          signal: req.signal,
        },
      );
      return result.response;
    }

    // ── External provider dispatch (external-providers spec) ──
    // Same routing as chat.ts, reusing the prompt → messages conversion. The
    // legacy `prompt` field itself is dropped — it was already converted into
    // `messages`, and a remote chat endpoint must not receive both.
    const externalProviderName = externalModels.get(parsed.model);
    if (externalProviderName) {
      const externalProvider = deps.providers.get(externalProviderName);
      if (!externalProvider) {
        return jsonError(
          `Provider "${externalProviderName}" not found`,
          "invalid_request_error",
          "model",
          "model_not_found",
          404,
        );
      }

      const externalPayload = { ...chatPayload };
      delete externalPayload.prompt;

      if (chatPayload.stream === true) {
        const created = Math.floor(Date.now() / 1000);
        return new Response(
          buildStreamBody(
            externalProvider,
            externalPayload,
            req.signal,
            makeChatCompletionId(),
            created,
            parsed.model,
          ),
          { status: 200, headers: SSE_HEADERS },
        );
      }

      const body = await externalProvider.chat(externalPayload, parsed.model);
      const { status: _status, ...wire } = body;
      const created = Math.floor(Date.now() / 1000);
      return new Response(
        JSON.stringify({
          ...wire,
          id: makeChatCompletionId(),
          created,
          model: parsed.model,
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }

    // ── Unknown real model → 404 (gateway-api "Unknown model returns 404") ──
    if (
      !externalModels.has(parsed.model) &&
      !modelExists(deps.manager, parsed.model) &&
      backendAvailable(deps.manager)
    ) {
      return jsonError(
        `Model "${parsed.model}" not found`,
        "invalid_request_error",
        "model",
        "model_not_found",
        404,
      );
    }

    // ── Direct provider passthrough ──
    console.log(`[completions] passthrough → ${parsed.model}`);
    const passthroughReq = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body:
        req.method !== "GET" && req.method !== "HEAD"
          ? JSON.stringify(chatPayload)
          : undefined,
    });
    return await passthroughProxy(passthroughReq);
  };
}

function resolveChainId(
  model: string,
  headerChainId: string | undefined,
): string | undefined {
  if (headerChainId) return headerChainId;
  if (model.startsWith(CHAIN_PREFIX)) return model.slice(CHAIN_PREFIX.length);
  return undefined;
}

/** Whether the managed backend is currently serving traffic. */
function backendAvailable(manager: LlamaServeManager): boolean {
  return manager.status().state === "running" && manager.status().baseUrl !== "";
}

/** Whether a real (non-chain) model is registered on the managed backend. */
function modelExists(manager: LlamaServeManager, model: string): boolean {
  return manager.status().models.includes(model);
}


