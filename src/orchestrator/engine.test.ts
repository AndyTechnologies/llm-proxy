/**
 * Graph engine tests (strict TDD — Phase 6.2).
 *
 * Task 6.2 — src/orchestrator/engine.ts: topo exec, fan/join, runChain,
 * logs. Covers pipeline-orchestration + graph-engine scenarios:
 *  - linear order + lastResponse propagation
 *  - node failure stops the graph, outputs kept
 *  - fan/join parallel execution and recombination
 *  - condition branches (guarded edges)
 *  - on_429 / tool_calls_route conditional rerouting
 *  - memory injection, data.code sandbox, rag_local, embeddings nodes
 *  - bounded loop execution
 *  - event log (step:*, reroute, run:start/complete)
 */
import { describe, expect, test } from "bun:test";
import { runChain, runGraphEngine, buildStepMessages, type EngineServices, type EngineEvent } from "./engine.js";
import type { GraphEdge, GraphNode, GraphPipeline } from "./graph.js";

function makeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  overrides: Partial<GraphPipeline> = {},
): GraphPipeline {
  return { id: "g1", name: "g1", nodes, edges, ...overrides };
}

function node(id: string, type: GraphNode["type"], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, ...extra };
}

const llm = (id: string, extra: Partial<GraphNode> = {}) => node(id, "llm_call", { model: "gemma", ...extra });

interface CallLog {
  nodeId: string;
  messages: Array<{ role: string; content: string }>;
}

function makeServices(overrides: Partial<EngineServices> = {}) {
  const callLog: CallLog[] = [];
  const runCodeLog: Array<{ code: string; input: unknown }> = [];
  const services: EngineServices = {
    call: async (n, messages) => {
      callLog.push({ nodeId: n.id, messages });
      return { status: 200, content: `out:${n.id}` };
    },
    runCode: async (code, input) => {
      runCodeLog.push({ code, input });
      return { ok: true, stdout: `ran:${code}` };
    },
    embed: async (_text) => new Float32Array([0.1, 0.2]),
    retrieve: async () => [{ doc: "guide-a", text: "cached chunk", score: 0.9 }],
    loadMemory: async () => [{ role: "user", content: "history-row" }],
    storeMemory: async () => {},
    graphMap: () => new Map(),
    ...overrides,
  };
  return { services, callLog, runCodeLog };
}

const INPUT = { messages: [{ role: "user" as const, content: "hello" }] };

const linearGraph = () =>
  makeGraph(
    [
      node("start", "start"),
      llm("a"),
      llm("b"),
      node("end", "end"),
    ],
    [
      { from: "start", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "end" },
    ],
  );

describe("runGraphEngine — linear execution", () => {
  test("executes nodes in edge order and propagates lastResponse forward", async () => {
    const { services, callLog } = makeServices();
    const result = await runGraphEngine({ graph: linearGraph(), services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(callLog.map((c) => c.nodeId)).toEqual(["a", "b"]);
    expect(result.output).toEqual({ status: 200, content: "out:b" });
  });

  test("node failure stops the graph and keeps prior outputs (RED)", async () => {
    const { services, callLog } = makeServices({
      call: async (n) => {
        callLog.push({ nodeId: n.id, messages: [] });
        if (n.id === "b") throw new Error("boom");
        return { status: 200, content: `out:${n.id}` };
      },
    });
    const graph = makeGraph(
      [node("start", "start"), llm("a"), llm("b"), llm("c"), node("end", "end")],
      [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    expect(callLog.map((c) => c.nodeId)).toEqual(["a", "b"]);
    expect(result.results.find((r) => r.nodeId === "a")?.status).toBe("ok");
    expect(result.results.find((r) => r.nodeId === "b")?.status).toBe("error");
  });
});

describe("runGraphEngine — fan/join", () => {
  test("parallel fan branches run concurrently and recombine at join", async () => {
    const { services, callLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        node("fan", "fan", { parallel: true }),
        llm("x"),
        llm("y"),
        node("join", "join"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "fan" },
        { from: "fan", to: "x" },
        { from: "fan", to: "y" },
        { from: "x", to: "join" },
        { from: "y", to: "join" },
        { from: "join", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    // Both branches executed.
    expect(callLog.map((c) => c.nodeId).sort()).toEqual(["x", "y"]);
    // Join completed → its successor end ran and output reflects join's last response.
    expect(result.output?.content).toBe("out:y");
    expect(result.results.map((r) => r.nodeId).sort()).toEqual(["fan", "join", "x", "y"].sort());
  });
});

describe("runGraphEngine — condition branches", () => {
  test("only the guarded matching branch executes", async () => {
    const { services, callLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        node("c", "condition", {
          condition: { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
        }),
        llm("t"),
        llm("f"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "c" },
        { from: "c", to: "t", guard: "true" },
        { from: "c", to: "f", guard: "false" },
        { from: "t", to: "end" },
        { from: "f", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(callLog.map((c) => c.nodeId)).toEqual(["t"]);
  });
});

describe("runGraphEngine — on_429 / tool_calls_route", () => {
  test("429 reroutes to the on_429 target, skipping the normal successor", async () => {
    const { services, callLog } = makeServices({
      call: async (n) => {
        callLog.push({ nodeId: n.id, messages: [] });
        if (n.id === "a") {
          const err = new Error("rate limited") as Error & { status?: number };
          err.status = 429;
          throw err;
        }
        return { status: 200, content: `out:${n.id}` };
      },
    });
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { on_429: "fallback" }),
        llm("fallback"),
        llm("b"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "fallback", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(callLog.map((c) => c.nodeId)).toEqual(["a", "fallback"]);
    expect(result.events.some((e) => e.type === "reroute" && (e as { reason?: string }).reason === "on_429")).toBe(true);
  });

  test("non-429 errors do NOT trigger the fallback", async () => {
    const { services, callLog } = makeServices({
      call: async (n) => {
        callLog.push({ nodeId: n.id, messages: [] });
        const err = new Error("server error") as Error & { status?: number };
        err.status = 500;
        throw err;
      },
    });
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { on_429: "fallback" }),
        llm("fallback"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "fallback", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(false);
    expect(callLog.map((c) => c.nodeId)).toEqual(["a"]);
  });

  test("tool_calls reroute executes the handler instead of the next node", async () => {
    const { services, callLog } = makeServices({
      call: async (n) => {
        callLog.push({ nodeId: n.id, messages: [] });
        if (n.id === "a") {
          return { status: 200, content: "tool time", toolCalls: [{ id: "t1", type: "function" }] };
        }
        return { status: 200, content: `out:${n.id}` };
      },
    });
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { tool_calls_route: "handler" }),
        llm("handler"),
        llm("b"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "handler", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(callLog.map((c) => c.nodeId)).toEqual(["a", "handler"]);
    expect(result.events.some((e) => e.type === "reroute" && (e as { reason?: string }).reason === "tool_calls")).toBe(true);
  });

  test("no tool_calls continues the normal edge", async () => {
    const { services, callLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { tool_calls_route: "handler" }),
        llm("handler"),
        llm("b"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "handler", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(callLog.map((c) => c.nodeId)).toEqual(["a", "b"]);
  });
});

describe("runGraphEngine — extended node types", () => {
  test("memory node injects history into the next generate payload", async () => {
    const { services, callLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        node("mem", "memory", { convId: "conv-1" }),
        llm("a", { mode: "generate" }),
        node("end", "end"),
      ],
      [
        { from: "start", to: "mem" },
        { from: "mem", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    const messages = callLog[0]?.messages ?? [];
    expect(messages.some((m) => m.content === "history-row")).toBe(true);
  });

  test("data.code node runs sandboxed code and uses stdout as output", async () => {
    const { services, runCodeLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        node("code1", "data.code", { code: "console.log(1 + 1)" }),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "code1" },
        { from: "code1", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(runCodeLog[0]?.code).toBe("console.log(1 + 1)");
    expect(result.output?.content).toBe("ran:console.log(1 + 1)");
  });

  test("rag_local node grounds the answer and exposes sources", async () => {
    const { services } = makeServices({
      call: async (_n, messages) => ({ status: 200, content: `grounded:${messages.length}` }),
    });
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        node("rag", "rag_local", { k: 2 }),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "rag" },
        { from: "rag", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    const rag = result.results.find((r) => r.nodeId === "rag");
    expect(rag?.status).toBe("ok");
    expect(result.variables.sources).toBeDefined();
  });

  test("embeddings node stores the vector in variables", async () => {
    const { services } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        node("emb", "embeddings", { text: "hello world" }),
        node("end", "end"),
      ],
      [
        { from: "start", to: "emb" },
        { from: "emb", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.variables.embedding)).toBe(true);
  });

  test("output node passes the input through", async () => {
    const { services } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        node("out", "output"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "out" },
        { from: "out", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(result.output?.content).toBe("out:a");
  });
});

describe("runGraphEngine — loop", () => {
  test("loop body runs the specified iterations then exits", async () => {
    const { services, callLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop", { body: ["ln"], iterations: 2 }),
        llm("ln"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "loop" },
        { from: "loop", to: "ln" },
        { from: "ln", to: "loop" },
        { from: "loop", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(callLog.filter((c) => c.nodeId === "ln")).toHaveLength(2);
  });
});

describe("runGraphEngine — events and result shape", () => {
  test("emits run:start, step:*, reroute and run:complete events in order", async () => {
    const { services } = makeServices();
    const collected: EngineEvent[] = [];
    const result = await runGraphEngine({
      graph: linearGraph(),
      services,
      input: INPUT,
      onEvent: (e) => collected.push(e),
    });
    expect(result.events).toEqual(collected);
    expect(collected[0]?.type).toBe("run:start");
    expect(collected[collected.length - 1]?.type).toBe("run:complete");
    const stepTypes = collected.filter((e) => e.type.startsWith("step:")).map((e) => e.type);
    expect(stepTypes.filter((t) => t === "step:start").length).toBeGreaterThan(0);
    expect(stepTypes.filter((t) => t === "step:complete").length).toBeGreaterThan(0);
  });

  test("runChain is the same function as runGraphEngine (no linear engine)", async () => {
    expect(runChain).toBe(runGraphEngine);
    const { services } = makeServices();
    const result = await runChain({ graph: linearGraph(), services, input: INPUT });
    expect(result.ok).toBe(true);
  });
});

describe("buildStepMessages", () => {
  test("generate sends full messages; refine refeeds lastContent; passthrough forwards unchanged", () => {
    const original = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "u1" },
    ];
    const state = {
      original,
      lastContent: "previous output",
      history: [] as Array<{ role: string; content: string }>,
    };
    const generate = buildStepMessages(node("n", "llm_call", { mode: "generate" }), state);
    expect(generate).toEqual(original);

    const refine = buildStepMessages(node("n", "llm_call", { mode: "refine" }), state);
    expect(refine).toEqual([...original, { role: "user", content: "previous output" }]);

    const passthrough = buildStepMessages(node("n", "llm_call", { mode: "passthrough" }), state);
    expect(passthrough).toEqual(original);

    // History (memory inject) is folded into generate payloads after scaffolds.
    const withHistory = buildStepMessages(node("n", "llm_call", { mode: "generate" }), {
      ...state,
      history: [{ role: "assistant", content: "hist" }],
    });
    expect(withHistory).toEqual([
      { role: "system", content: "sys" },
      { role: "assistant", content: "hist" },
      { role: "user", content: "u1" },
    ]);
  });

  test("drafts (join aggregation) fold as numbered user turns before the tail (generate)", () => {
    const original = [{ role: "user" as const, content: "final prompt" }];
    const messages = buildStepMessages(node("n", "llm_call", { mode: "generate" }), {
      original,
      lastContent: null,
      history: [],
      drafts: ["draft-a", "draft-b"],
    });
    expect(messages).toEqual([
      { role: "user", content: "Draft 1:\ndraft-a" },
      { role: "user", content: "Draft 2:\ndraft-b" },
      { role: "user", content: "final prompt" },
    ]);
  });

  test("drafts are ignored when absent or malformed (no join ran)", () => {
    const original = [{ role: "user" as const, content: "u1" }];
    const plain = buildStepMessages(node("n", "llm_call", { mode: "generate" }), {
      original,
      lastContent: null,
      history: [],
      drafts: undefined,
    });
    expect(plain).toEqual(original);
    const malformed = buildStepMessages(node("n", "llm_call", { mode: "generate" }), {
      original,
      lastContent: null,
      history: [],
      drafts: "not-an-array",
    });
    expect(malformed).toEqual(original);
  });
});

describe("runGraphEngine — pipeline composition (6.3)", () => {
  test("a pipeline node composes a registered sub-graph end-to-end", async () => {
    const sub = makeGraph(
      [node("s2", "start"), llm("b"), node("e2", "end")],
      [
        { from: "s2", to: "b" },
        { from: "b", to: "e2" },
      ],
      { id: "sub", name: "sub" },
    );
    const { services } = makeServices({
      graphMap: () => new Map([["sub", sub]]),
      call: async (n, _messages) => ({ status: 200, content: `out:${n.id}` }),
    });
    const graph = makeGraph(
      [node("start", "start"), llm("a"), node("pip", "pipeline", { pipeline: "sub" }), node("end", "end")],
      [
        { from: "start", to: "a" },
        { from: "a", to: "pip" },
        { from: "pip", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    // The sub-graph's llm ran during the composition.
    expect(result.results.find((r) => r.nodeId === "b")).toBeDefined();
    expect(result.output?.content).toBe("out:b");
  });

  test("self-referencing pipelines stop at the depth bound with a clear error", async () => {
    const graph = makeGraph(
      [node("start", "start"), node("pip", "pipeline", { pipeline: "self" }), node("end", "end")],
      [
        { from: "start", to: "pip" },
        { from: "pip", to: "end" },
      ],
    );
    const { services } = makeServices({
      graphMap: () => new Map([["self", graph]]),
    });
    const result = await runGraphEngine({
      graph,
      services,
      input: INPUT,
      maxDepth: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("depth exceeded");
  });
});

describe("runGraphEngine — full node taxonomy parity (6.3)", () => {
  test("every node type executes without an unknown-node error", async () => {
    const sub = makeGraph(
      [node("s2", "start"), llm("b"), node("e2", "end")],
      [
        { from: "s2", to: "b" },
        { from: "b", to: "e2" },
      ],
      { id: "sub", name: "sub" },
    );
    const truthy = { op: "exists" as const, field: "lastResponse.status" };
    const { services } = makeServices({
      graphMap: () => new Map([["sub", sub]]),
      call: async (n, _messages) => ({ status: 200, content: `out:${n.id}` }),
    });
    const graph = makeGraph(
      [
        node("start", "start"),
        node("c", "condition", { condition: truthy }),
        llm("llm"),
        llm("ref", { mode: "refine" }),
        llm("pas", { mode: "passthrough" }),
        node("fan", "fan", { parallel: true }),
        llm("d1"),
        llm("d2"),
        node("j", "join"),
        node("lp", "loop", { body: ["lpi"], iterations: 1 }),
        llm("lpi"),
        node("rag", "rag_local", { model: "gemma" }),
        node("cod", "data.code", { code: "console.log(1)" }),
        node("mem", "memory"),
        node("emb", "embeddings", { text: "sample" }),
        node("pip", "pipeline", { pipeline: "sub" }),
        node("rt", "router", { condition: truthy }),
        node("out", "output"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "c" },
        { from: "c", to: "llm", guard: "true" },
        { from: "c", to: "end", guard: "false" },
        { from: "llm", to: "ref" },
        { from: "ref", to: "pas" },
        { from: "pas", to: "fan" },
        { from: "fan", to: "d1" },
        { from: "fan", to: "d2" },
        { from: "d1", to: "j" },
        { from: "d2", to: "j" },
        { from: "j", to: "lp" },
        { from: "lp", to: "rag" },
        { from: "rag", to: "cod" },
        { from: "cod", to: "mem" },
        { from: "mem", to: "emb" },
        { from: "emb", to: "pip" },
        { from: "pip", to: "rt" },
        { from: "rt", to: "out", guard: "true" },
        { from: "rt", to: "end", guard: "false" },
        { from: "out", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]));
    // Composed sub-graph nodes (e.g. "b") flatten into the ledger too — they
    // are sub-scope, so only types known to THIS graph feed the parity set.
    const executedTypes = new Set(
      result.results
        .map((r) => typeOf.get(r.nodeId))
        .filter((t): t is NonNullable<typeof t> => t !== undefined),
    );
    expect(executedTypes).toEqual(
      new Set([
        "condition",
        "llm_call",
        "fan",
        "join",
        "loop",
        "rag_local",
        "data.code",
        "memory",
        "embeddings",
        "pipeline",
        "router",
        "output",
      ]),
    );
    expect(result.output?.content).toBe("out:b");
  });
});

describe("runGraphEngine — router guard (6.4)", () => {
  test("router follows only the guard-matching edge", async () => {
    const falseCond = { op: "compare" as const, field: "lastResponse.content", op2: "==" as const, value: "" };
    // After llm("a") ran, content is "out:a" — the == "" guard is FALSE.
    const { services, callLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        node("rt", "router", { condition: falseCond }),
        llm("yes"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "rt" },
        { from: "rt", to: "yes", guard: "true" },
        { from: "rt", to: "end", guard: "false" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    expect(callLog.map((c) => c.nodeId)).toEqual(["a"]);
    expect(result.results.some((r) => r.nodeId === "yes")).toBe(false);
    expect(result.output?.content).toBe("out:a");
  });
});

describe("runGraphEngine — MoA 3+1 drafts aggregation (6.4)", () => {
  test("fan runs 3 drafts; the join aggregates them; the synthesis consumes all 3", async () => {
    const { services, callLog } = makeServices();
    const graph = makeGraph(
      [
        node("start", "start"),
        node("fan", "fan", { parallel: true }),
        llm("d1"),
        llm("d2"),
        llm("d3"),
        node("j", "join"),
        llm("syn"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "fan" },
        { from: "fan", to: "d1" },
        { from: "fan", to: "d2" },
        { from: "fan", to: "d3" },
        { from: "d1", to: "j" },
        { from: "d2", to: "j" },
        { from: "d3", to: "j" },
        { from: "j", to: "syn" },
        { from: "syn", to: "end" },
      ],
    );
    const result = await runGraphEngine({ graph, services, input: INPUT });
    expect(result.ok).toBe(true);
    // All three drafts ran (parallel wave) and the synthesis ran LAST.
    const ids = callLog.map((c) => c.nodeId);
    expect(ids.slice(0, 3).sort()).toEqual(["d1", "d2", "d3"]);
    expect(ids[3]).toBe("syn");
    // The join aggregated the drafts into variables.
    expect(result.variables["drafts"]).toEqual(["out:d1", "out:d2", "out:d3"]);
    // The synthesis payload consumed every draft, in join order, then the tail.
    const synCall = callLog.find((c) => c.nodeId === "syn");
    expect(synCall?.messages).toEqual([
      { role: "user", content: "Draft 1:\nout:d1" },
      { role: "user", content: "Draft 2:\nout:d2" },
      { role: "user", content: "Draft 3:\nout:d3" },
      { role: "user", content: "hello" },
    ]);
    expect(result.output?.content).toBe("out:syn");
    expect(result.results.map((r) => r.nodeId).sort()).toEqual(["d1", "d2", "d3", "fan", "j", "syn"].sort());
  });
});