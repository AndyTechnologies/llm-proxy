/**
 * External provider routing integration tests (multi-provider-pipelines, 4.1).
 *
 * End-to-end through a real in-process Bun.serve mount of createApp AND a real
 * wire-mock upstream Bun.serve speaking the OpenAI wire format. The external
 * adapter (makeOpenAICompatibleProvider) is the REAL adapter — no fakes on the
 * external path — so this covers: direct external dispatch before the llama
 * passthrough/404 gate, buildStreamBody relay (one terminal chunk + one
 * `[DONE]`), the non-streaming envelope rewrite, and the unknown-model 404.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LlamaServeManager } from "../backend/manager.js";
import { createPipelineRegistry } from "../orchestrator/registry.js";
import type { GraphPipeline } from "../orchestrator/graph.js";
import type { Provider } from "../providers/types.js";
import { makeOpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { createApp, type ServerDeps } from "./../server.js";

const dec = new TextDecoder();

/** Fake llama-server provider — proves the external path never touches it. */
function fakeLlamaProvider(calls: { chat: string[]; stream: string[] }): Provider {
  return {
    name: "llama-server",
    async chat() {
      calls.chat.push("llama-server");
      return { status: 200, choices: [{ message: { content: "llama-out" } }] };
    },
    async *chatStream() {
      calls.stream.push("llama-server");
      yield JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: { content: "llama-s" }, finish_reason: "stop" }],
      });
    },
  };
}

function fakeManager(status: Partial<ReturnType<LlamaServeManager["status"]>> = {}): LlamaServeManager {
  return {
    status: () => ({
      state: "running",
      pid: 1,
      models: ["real-model"],
      baseUrl: "http://127.0.0.1:8080",
      ...status,
    }),
    // No registered model has a known context in this harness.
    modelContext: () => undefined,
  } as unknown as LlamaServeManager;
}

/** Wire-mock upstream: record incoming bodies and answer per scenario. */
let wireRequests: Array<Record<string, unknown>> = [];
let wireServers: ReturnType<typeof Bun.serve>[] = [];

function wireMock(
  handler: (req: Request) => Response | Promise<Response>,
): string {
  const s = Bun.serve({ port: 0, idleTimeout: 1, fetch: handler });
  wireServers.push(s);
  return `http://127.0.0.1:${s.port}/v1`;
}

/** OpenAI-wire streaming responder (terminating chunk + optional usage + DONE). */
async function streamWireHandler(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;
  wireRequests.push(body);
  const model = typeof body.model === "string" ? body.model : "gpt-4o";
  const chunks: Array<Record<string, unknown>> = [
    { id: "chatcmpl-wire", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl-wire", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
    { id: "chatcmpl-wire", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: " from the wire" }, finish_reason: null }] },
    { id: "chatcmpl-wire", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const usageAsked =
    (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
  if (usageAsked) {
    chunks.push({
      id: "chatcmpl-wire",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
    });
  }
  const frames =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(frames, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

interface GatewayFakes {
  llamaCalls: { chat: string[]; stream: string[] };
}

/** Wire-mock upstream: record incoming request headers per call (S5.1/S5.2). */
let wireHeaderCaptures: Headers[] = [];

function gatewayDeps(opts: {
  wireBaseURL: string;
  manager?: LlamaServeManager;
  graphs?: GraphPipeline[];
  apiKey?: string;
  headers?: Record<string, string>;
}): { deps: ServerDeps; fakes: GatewayFakes } {
  const llamaCalls = { chat: [] as string[], stream: [] as string[] };
  const registry = createPipelineRegistry({
    graphs: opts.graphs ?? [{ id: "thinker", name: "Thinker", nodes: [], edges: [] }],
  });
  const deps: ServerDeps = {
    config: {
      server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
    } as unknown as ServerDeps["config"],
    registry,
    providers: new Map<string, Provider>([
      ["llama-server", fakeLlamaProvider(llamaCalls)],
      [
        "openai",
        makeOpenAICompatibleProvider({
          name: "openai",
          baseURL: opts.wireBaseURL,
          models: ["gpt-4o"],
          ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
          ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        }),
      ],
    ]),
    externalModels: new Map([["gpt-4o", "openai"]]),
    manager: opts.manager ?? fakeManager(),
  };
  return { deps, fakes: { llamaCalls } };
}

let servers: ReturnType<typeof Bun.serve>[] = [];

function mount(
  app: (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response>,
) {
  const s = Bun.serve({ port: 0, idleTimeout: 1, fetch: app });
  servers.push(s);
  return s;
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

function chatReq(model: string, extra: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    }),
  };
}

afterEach(() => {
  for (const s of [...servers, ...wireServers]) s.stop(true);
  servers = [];
  wireServers = [];
  wireRequests = [];
  wireHeaderCaptures = [];
});

describe("external provider routing (4.1)", () => {
  test("/v1/models lists external + llama + gateway/* models", async () => {
    const { deps } = gatewayDeps({ wireBaseURL: wireMock(() => new Response("unused")) });
    const app = createApp(deps);
    const s = mount(app);

    const res = await fetch(`http://127.0.0.1:${s.port}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };

    const byId = new Map(body.data.map((m) => [m.id, m.owned_by]));
    expect(byId.get("gateway/thinker")).toBe("gateway");
    expect(byId.get("real-model")).toBe("llama-server");
    expect(byId.get("gpt-4o")).toBe("openai");
  });

  test("external streaming ends with one terminal chunk and exactly one [DONE]", async () => {
    const { deps, fakes } = gatewayDeps({ wireBaseURL: wireMock(streamWireHandler) });
    const app = createApp(deps);
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    });

    const res = await fetch(
      `http://127.0.0.1:${s.port}/v1/chat/completions`,
      chatReq("gpt-4o", { stream: true }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const out = await readAll(res);
    // exactly one terminal marker, exactly one [DONE]
    const chunkLines = out
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    const dones = chunkLines.filter((l) => l === "[DONE]");
    expect(dones.length).toBe(1);
    const chunks = chunkLines
      .filter((l) => l !== "[DONE]")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // a usage chunk with empty choices may follow the terminal chunk when the
    // adapter requested include_usage — the terminal is the chunk that carries
    // a finish_reason
    const terminalChunks = chunks.filter(
      (c) =>
        (c.choices as Array<{ finish_reason?: string }> | undefined)?.[0]
          ?.finish_reason,
    );
    expect(terminalChunks.length).toBe(1);
    const terminal = terminalChunks[0];
    expect(
      (terminal.choices as Array<{ finish_reason: string }>)[0].finish_reason,
    ).toBe("stop");
    // buildStreamBody rewrote the model to the gateway model name
    expect(terminal.model).toBe("gpt-4o");
    // the wire saw stream:true and the original messages
    expect(wireRequests).toHaveLength(1);
    expect(wireRequests[0].stream).toBe(true);
    expect(wireRequests[0].messages).toEqual([{ role: "user", content: "hi" }]);
    // the llama-server provider was never touched
    expect(fakes.llamaCalls.stream).toEqual([]);
  });

  test("external non-streaming request returns OpenAI-shaped JSON with rewritten id/model", async () => {
    const { deps, fakes } = gatewayDeps({
      wireBaseURL: wireMock(async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        wireRequests.push(body);
        return Response.json({
          id: "chatcmpl-wire",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "wire non-stream reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        });
      }),
    });
    const app = createApp(deps);
    const s = mount(app);

    const res = await fetch(
      `http://127.0.0.1:${s.port}/v1/chat/completions`,
      chatReq("gpt-4o"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-4o");
    expect(body.id.startsWith("chatcmpl-")).toBe(true);
    expect(body.choices[0].message.content).toBe("wire non-stream reply");
    expect(body.choices[0].finish_reason).toBe("stop");
    // non-stream wire call carries stream:false-ish payload (no stream flag)
    expect(wireRequests).toHaveLength(1);
    expect(wireRequests[0].messages).toEqual([{ role: "user", content: "hi" }]);
    expect(fakes.llamaCalls.chat).toEqual([]);
  });

  test("unknown model returns 404 with code model_not_found", async () => {
    const { deps } = gatewayDeps({ wireBaseURL: wireMock(() => new Response("unused")) });
    const app = createApp(deps);
    const s = mount(app);

    const res = await fetch(
      `http://127.0.0.1:${s.port}/v1/chat/completions`,
      chatReq("no-such-model"),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });

  test("external model is served even when the managed backend is unavailable", async () => {
    // External-mode edge: disable the llama backend; the external provider
    // must still be reachable (dispatch happens before the backend gate).
    const { deps, fakes } = gatewayDeps({
      wireBaseURL: wireMock(streamWireHandler),
      manager: fakeManager({ state: "stopped", baseUrl: "" }),
    });
    const app = createApp(deps);
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    });

    const res = await fetch(
      `http://127.0.0.1:${s.port}/v1/chat/completions`,
      chatReq("gpt-4o", { stream: true }),
    );

    expect(res.status).toBe(200);
    const out = await readAll(res);
    const dones = out.match(/data: \[DONE\]/g) ?? [];
    expect(dones.length).toBe(1);
    expect(fakes.llamaCalls.stream).toEqual([]);
  });

  test("the wire request carries Authorization: Bearer plus the configured static headers (S5.1)", async () => {
    const { deps, fakes } = gatewayDeps({
      wireBaseURL: wireMock(async (req) => {
        wireHeaderCaptures.push(req.headers);
        return Response.json({
          id: "chatcmpl-wire",
          object: "chat.completion",
          created: 1,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "authed reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }),
      apiKey: "sk-test-123",
      headers: { "X-Static-Header": "static-value", "X-Tenant": "acme" },
    });
    const app = createApp(deps);
    const s = mount(app);

    const res = await fetch(
      `http://127.0.0.1:${s.port}/v1/chat/completions`,
      chatReq("gpt-4o"),
    );

    expect(res.status).toBe(200);
    // the wire really saw the request: the adapter's HTTP call ran
    expect(wireHeaderCaptures).toHaveLength(1);
    const headers = wireHeaderCaptures[0];
    expect(headers.get("authorization")).toBe("Bearer sk-test-123");
    expect(headers.get("x-static-header")).toBe("static-value");
    expect(headers.get("x-tenant")).toBe("acme");
    expect(fakes.llamaCalls.chat).toEqual([]);
  });

  test("a provider without apiKey sends NO Authorization header on the wire (S5.2)", async () => {
    // gatewayDeps builds the provider WITHOUT apiKey/headers (default).
    const { deps, fakes } = gatewayDeps({
      wireBaseURL: wireMock(async (req) => {
        wireHeaderCaptures.push(req.headers);
        return Response.json({
          id: "chatcmpl-wire",
          object: "chat.completion",
          created: 1,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "unauthed reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }),
    });
    const app = createApp(deps);
    const s = mount(app);

    const res = await fetch(
      `http://127.0.0.1:${s.port}/v1/chat/completions`,
      chatReq("gpt-4o"),
    );

    expect(res.status).toBe(200);
    // the round trip completed against the real adapter
    expect(wireHeaderCaptures).toHaveLength(1);
    expect(wireHeaderCaptures[0].get("authorization")).toBeNull();
    expect(fakes.llamaCalls.chat).toEqual([]);
  });
});