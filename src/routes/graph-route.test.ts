/**
 * Graph-engine route integration tests (strict TDD - Slice B, task 2.6).
 *
 * Verifies through a real in-process Bun.serve mount of createApp that a
 * COMPLEX graph pipeline invoked via `/v1/chat/completions` (model
 * `gateway/<name>` = the graph's name) routes to the graph engine and streams
 * without buffering (exactly one terminal chunk, live ReadableStream body).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LlamaServeManager } from "../backend/manager.js";
import { createPipelineRegistry } from "../orchestrator/registry.js";
import type { AstExpr, GraphEdge, GraphNode, GraphPipeline } from "../orchestrator/graph.js";
import type { Provider } from "../providers/types.js";
import { createApp, type ServerDeps } from "./../server.js";

const dec = new TextDecoder();

interface Calls {
  chat: string[];
  stream: string[];
}

/** Fake provider: non-streaming chat yields a body, streaming yields one chunk. */
function fakeProvider(name: string, calls: Calls): Provider {
  return {
    name,
    async chat() {
      calls.chat.push(name);
      return {
        status: 200,
        choices: [{ message: { content: `out-${name}` } }],
      };
    },
    async *chatStream(_payload: Record<string, unknown>, _signal: AbortSignal) {
      calls.stream.push(name);
      yield JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: { content: `S-${name}` }, finish_reason: "stop" }],
      });
    },
  };
}

const node = (
  id: string,
  type: GraphNode["type"],
  extra: Partial<GraphNode> = {},
): GraphNode => ({ id, type, ...extra });
const llm = (id: string) => node(id, "llm_call", { model: "m", provider: "p" });
const edge = (from: string, to: string, guard?: "true" | "false"): GraphEdge => ({
  from,
  to,
  ...(guard ? { guard } : {}),
});

/** A complex graph: a `condition` with true/false branches. */
function conditionalGraph(): GraphPipeline {
  const cond: AstExpr = {
    op: "compare",
    field: "lastResponse.status",
    op2: "==",
    value: 200,
  };
  return {
    id: "graphy",
    name: "graphy",
    nodes: [
      node("start", "start"),
      llm("a"),
      node("cond", "condition", { condition: cond }),
      llm("t"),
      llm("f"),
      node("end", "end"),
    ],
    edges: [
      edge("start", "a"),
      edge("a", "cond"),
      edge("cond", "t", "true"),
      edge("cond", "f", "false"),
      edge("t", "end"),
      edge("f", "end"),
    ],
  };
}

function fakeManager(): LlamaServeManager {
  return {
    status: () => ({
      state: "running",
      pid: 1,
      models: ["real-model"],
      baseUrl: "http://127.0.0.1:8080",
    }),
  } as unknown as LlamaServeManager;
}

function deps(provider: Provider, _calls: Calls): ServerDeps {
  const registry = createPipelineRegistry({
    graphs: [conditionalGraph()],
  });
  return {
    config: {
      server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
    } as unknown as ServerDeps["config"],
    registry,
    providers: new Map<string, Provider>([
      ["p", provider],
      ["fake", provider],
    ]),
    manager: fakeManager(),
  } as ServerDeps;
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

let servers: ReturnType<typeof Bun.serve>[] = [];

function mount(
  app: (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response>,
) {
  const s = Bun.serve({ port: 0, idleTimeout: 1, fetch: app });
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

describe("graph pipeline via /v1/chat/completions (hybrid selector, 2.6)", () => {
  test("a complex graph routes to the graph engine and streams without buffering", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const provider = fakeProvider("p", calls);
    const app = createApp(deps(provider, calls));
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    });

    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gateway/graphy",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).toBeInstanceOf(ReadableStream);

    const out = await readAll(res);
    const dones = out.match(/data: \[DONE\]/g) ?? [];
    expect(dones.length).toBe(1);
    expect(calls.chat).toContain("p");
    expect(calls.stream).toContain("p");
  });

  test("X-Chain-ID header overrides the model field for chain resolution", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const provider = fakeProvider("p", calls);
    const app = createApp(deps(provider, calls));
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    });

    // model is a non-gateway model, but X-Chain-ID routes to "graphy"
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chain-ID": "graphy",
      },
      body: JSON.stringify({
        model: "gpt-4",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const out = await readAll(res);
    const dones = out.match(/data: \[DONE\]/g) ?? [];
    expect(dones.length).toBe(1);
    expect(calls.stream).toContain("p");
  });

  test("an unknown graph/chain name returns 404 through the selector", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const provider = fakeProvider("p", calls);
    const app = createApp(deps(provider, calls));
    const s = mount((req, server) => {
      server.timeout(req, 0);
      return app(req, server);
    });

    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gateway/nope",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(404);
  });
});
