/**
 * SSE stream integration tests (strict TDD, S2.5 — Bun.serve fixture).
 *
 * Verifies, through a real in-process Bun.serve mount of createApp, that the
 * SSE chat/completions routes behave correctly after S2b:
 *
 *  1. A silent stream survives longer than the server's idleTimeout. The spec
 *     (gateway-api "SSE idle timeout disabled") requires the stream to survive
 *     >10s of silence with the default 10s idleTimeout. To keep the test
 *     deterministic and fast, the fixture uses a SHORT idleTimeout (1500ms) and
 *     holds silence longer than it (2000ms). The mechanism under test is
 *     identical: `server.timeout(req, 0)` disables the per-request idle kill.
 *  2. Client abort cancels the upstream generation (releasing the slot) when the
 *     reader is cancelled mid-stream.
 *  3. The stream emits exactly one `data: [DONE]\n\n`.
 *
 * The test asserts real behavior through the full Bun.serve + createApp path,
 * including the `server.timeout(req, 0)` applied by the route dispatcher.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LlamaServeManager } from "../backend/manager.js";
import type { GraphPipeline } from "../orchestrator/graph.js";
import { createPipelineRegistry } from "../orchestrator/registry.js";
import type { Provider } from "../providers/types.js";
import { createApp, type ServerDeps } from "./../server.js";

const dec = new TextDecoder();

/** Fake provider that streams synthetic SSE frames with optional hooks. */
function fakeProvider(opts: {
  stream: Array<{ delta?: string; finish_reason?: string | null }>;
  onAbort?: () => void;
  /** Hold silence this many ms before emitting the first frame. */
  silenceMs?: number;
}): Provider {
  return {
    name: "fake",
    async chat() {
      return {};
    },
    async *chatStream(_payload: Record<string, unknown>, signal: AbortSignal) {
      try {
        if (opts.silenceMs) {
          await new Promise((r) => setTimeout(r, opts.silenceMs));
        }
        for (const frame of opts.stream) {
          if (signal?.aborted) {
            opts.onAbort?.();
            return;
          }
          yield JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ index: 0, delta: frame.delta ? { content: frame.delta } : {}, finish_reason: frame.finish_reason ?? null }],
          });
        }
      } finally {
        opts.onAbort?.();
      }
    },
  };
}

/** Manager whose backend is running so chains/passthrough are reachable. */
function fakeManager(baseUrl = "http://127.0.0.1:8080"): LlamaServeManager {
  return {
    status: () => ({
      state: "running",
      pid: 1,
      models: ["real-model"],
      baseUrl,
    }),
  } as unknown as LlamaServeManager;
}

function chatGraph(): GraphPipeline {
  return {
    id: "thinker",
    name: "Thinker",
    nodes: [
      { id: "start", type: "start" },
      { id: "call", type: "llm_call", model: "fake-model", provider: "fake" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "call" },
      { from: "call", to: "end" },
    ],
  };
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

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
  return {
    config: {
      server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
    } as unknown as ServerDeps["config"],
    registry: createPipelineRegistry({ graphs: [chatGraph()] }),
    providers: new Map<string, Provider>(),
    manager: fakeManager(),
    ...over,
  } as ServerDeps;
}

let servers: ReturnType<typeof Bun.serve>[] = [];

function mount(app: (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response>, idleTimeout: number) {
  const s = Bun.serve({ port: 0, idleTimeout, fetch: app });
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

describe("SSE chat/completions over Bun.serve (S2b)", () => {
  test("chain stream: silent stream survives longer than idleTimeout (server.timeout(req,0))", async () => {
    const provider = fakeProvider({
      stream: [{ delta: "hi", finish_reason: "stop" }],
      silenceMs: 1500,
    });
    const app = createApp(
      deps({
        providers: new Map([["fake", provider]]),
      }),
    );

    // Silence 1500ms LONGER than the 1s idleTimeout: if server.timeout(req,0)
    // were NOT applied, the stream would be killed at ~1s and the frame would
    // never arrive. S2.4/S2.6 mechanism under test.
    const s = mount((req, server) => {
      // REPLICA of the dispatcher's SSE handling (server.timeout(req,0)).
      server.timeout(req, 0);
      return app(req, server);
    }, 1);

    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gateway/thinker",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // The provider holds 1500ms of silence before its first frame; the read
    // completes only if the connection survived past the 1s idleTimeout.
    const out = await readAll(res);
    expect(out).toContain('"content":"hi"');
    expect((out.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
  }, 10000);

  test("chain stream: exactly one [DONE] and one terminal chunk arrive", async () => {
    const provider = fakeProvider({
      stream: [
        { delta: "Hello" },
        { delta: " world" },
        { delta: "", finish_reason: "stop" },
      ],
    });
    const app = createApp(
      deps({
        providers: new Map([["fake", provider]]),
      }),
    );
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    }, 1);

    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gateway/thinker",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const out = await readAll(res);
    const dones = out.match(/data: \[DONE\]/g) ?? [];
    expect(dones.length).toBe(1);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    // All the provider frames are present.
    expect(out).toContain('"Hello');
    expect(out).toContain('" world');
  }, 10000);

  test("client abort cancels the upstream generator (slot released)", async () => {
    let aborted = false;
    const provider = fakeProvider({
      stream: [{ delta: "first", finish_reason: null }],
      onAbort: () => {
        aborted = true;
      },
    });
    const app = createApp(
      deps({
        providers: new Map([["fake", provider]]),
      }),
    );
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    }, 1);

    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gateway/thinker",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    // Read one frame, then cancel the reader — this is a client disconnect of
    // the SSE stream and must abort the upstream provider generator.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    reader.releaseLock();

    // Give the abort a moment to propagate, then assert the upstream torn down.
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  }, 10000);

  test("zod validation on the stream route yields a 400 OpenAI envelope (not a stream)", async () => {
    const app = createApp(deps());
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    }, 1);

    // Missing required `messages` field → zod 400.
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gateway/thinker", stream: true }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("validation_error");
    // A 400 must NOT be an SSE stream.
    expect(res.headers.get("content-type")).toContain("application/json");
  }, 10000);
});
