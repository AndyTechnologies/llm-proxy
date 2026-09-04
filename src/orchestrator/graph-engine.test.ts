/**
 * Graph engine tests (strict TDD — Slice B, task 2.4).
 *
 * graph-engine Req scenarios covered:
 *   - "Node types": start/end/llm_call/condition/loop/join all execute
 *   - "Sequential-guarded branch semantics": only the matching branch runs;
 *     the executed branch's output propagates forward
 *   - "Parallel opt-in with explicit join": marked subgraph runs branches
 *     concurrently and recombines at the join
 *   - "Loop execution": bounded loop runs within its boundary then exits
 *   - "Single-terminal streaming on the executed path": intermediates run
 *     non-streaming and emit step:* events; only the last executed-path step
 *     streams with exactly one terminal chunk
 */
import { describe, expect, test } from "bun:test";
import type { Provider } from "../providers/types.js";
import {
  runGraphEngine,
  type GraphEngineDeps,
  type GraphEngineOpts,
  type GraphRunResult,
} from "./graph-engine.js";
import type { AstExpr, GraphEdge, GraphNode, GraphPipeline } from "./graph.js";

interface Calls {
  chat: string[];
  stream: string[];
}

/** Fake provider: non-streaming returns a body; streaming yields one chunk. */
function fakeProvider(
  name: string,
  calls: Calls,
  out: { status?: number; content?: string } = {},
): Provider {
  return {
    name,
    async chat() {
      calls.chat.push(name);
      const content = out.content ?? `out-${name}`;
      return {
        status: out.status ?? 200,
        choices: [{ message: { content } }],
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
const llm = (id: string, extra: Partial<GraphNode> = {}) =>
  node(id, "llm_call", { model: "m", provider: "p", ...extra });
const edge = (from: string, to: string, guard?: "true" | "false"): GraphEdge => ({
  from,
  to,
  ...(guard ? { guard } : {}),
});

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphPipeline {
  return { id: "g", name: "g", nodes, edges };
}

function deps(
  _calls: Calls,
  ...providers: Array<{ name: string; provider: Provider }>
): GraphEngineDeps {
  const map = new Map<string, Provider>();
  for (const p of providers) map.set(p.name, p.provider);
  return { providers: map, getPipeline: () => undefined };
}

async function run(
  graph: GraphPipeline,
  d: GraphEngineDeps,
  opts: GraphEngineOpts = { streamRequested: false, payload: {} },
): Promise<GraphRunResult> {
  return runGraphEngine(graph, d, opts);
}

describe("sequential execution + condition branching", () => {
  test("a linear chain executes its llm_calls in order", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const g = makeGraph(
      [node("start", "start"), llm("a"), llm("b"), node("end", "end")],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")],
    );
    const res = await run(g, deps(calls, { name: "p", provider: fakeProvider("p", calls) }));
    expect(calls.chat).toEqual(["p", "p"]);
    expect(res.executedLlmNodes).toEqual(["a", "b"]);
    expect(res.lastContent).toBe("out-p");
    expect(res.lastStatus).toBe(200);
  });

  test("condition picks only the matching branch (sequential-guarded)", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const condAst: AstExpr = { op: "compare", field: "lastResponse.status", op2: "==", value: 200 };
    const a = fakeProvider("p", calls, { status: 200, content: "a-out" });
    const b = fakeProvider("p2", calls, { content: "b-out" });
    const g = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        node("cond", "condition", { condition: condAst }),
        llm("trueA"),
        llm("falseB"),
        node("end", "end"),
      ],
      [
        edge("start", "a"),
        edge("a", "cond"),
        edge("cond", "trueA", "true"),
        edge("cond", "falseB", "false"),
        edge("trueA", "end"),
        edge("falseB", "end"),
      ],
    );
    const d = deps(
      calls,
      { name: "p", provider: a },
      { name: "p2", provider: b },
    );
    const res = await run(g, d);

    expect(res.executedLlmNodes).toEqual(["a", "trueA"]);
    expect(calls.chat).toContain("p");
    expect(calls.chat).not.toContain("p2");
  });
});

describe("loop execution is bounded", () => {
  test("a loop iterates its body up to the bound then exits", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const g = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop", { body: ["a"] }),
        llm("a"),
        node("end", "end"),
      ],
      [
        edge("start", "loop"),
        edge("loop", "a"),
        edge("a", "loop"),
        edge("loop", "end"),
      ],
    );
    const d: GraphEngineDeps = {
      ...deps(calls, { name: "p", provider: fakeProvider("p", calls) }),
      maxLoopIterations: 3,
    };
    const res = await run(g, d);
    expect(calls.chat).toEqual(["p", "p", "p"]);
    expect(res.executedLlmNodes).toEqual(["a", "a", "a"]);
    expect(res.lastStatus).toBe(200);
  });
});

describe("parallel opt-in with explicit join", () => {
  test("a marked subgraph runs its branches and recombines at the join", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const pa = fakeProvider("pa", calls, { content: "A" });
    const pb = fakeProvider("pb", calls, { content: "B" });
    const g = makeGraph(
      [
        node("start", "start"),
        node("fan", "fan", { parallel: true }),
        llm("branchA", { provider: "pa" }),
        llm("branchB", { provider: "pb" }),
        node("join", "join"),
        node("end", "end"),
      ],
      [
        edge("start", "fan"),
        edge("fan", "branchA"),
        edge("fan", "branchB"),
        edge("branchA", "join"),
        edge("branchB", "join"),
        edge("join", "end"),
      ],
    );
    const d = deps(
      calls,
      { name: "pa", provider: pa },
      { name: "pb", provider: pb },
    );
    const res = await run(g, d);
    expect(res.executedLlmNodes).toContain("branchA");
    expect(res.executedLlmNodes).toContain("branchB");
    expect(calls.chat).toContain("pa");
    expect(calls.chat).toContain("pb");
  });
});

describe("on_429 fallback routing", () => {
  test("a 429 from the provider reroutes to the on_429 target node", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const primary = {
      name: "p",
      async chat() {
        calls.chat.push("p");
        const err = new Error("rate limited") as Error & { status: number };
        err.status = 429;
        throw err;
      },
      async *chatStream() { /* noop */ },
    } satisfies Provider;
    const fallback = fakeProvider("fb", calls, { content: "fallback-out" });
    const g = makeGraph(
      [
        node("start", "start"),
        llm("a", { provider: "p", on_429: "fb" }),
        llm("fb", { provider: "fb" }),
        node("end", "end"),
      ],
      [
        edge("start", "a"),
        edge("a", "fb"),
        edge("fb", "end"),
      ],
    );
    const d = deps(calls, { name: "p", provider: primary }, { name: "fb", provider: fallback });
    const res = await run(g, d);
    // primary threw 429 → rerouted to fb
    expect(calls.chat).toContain("p");
    expect(calls.chat).toContain("fb");
    expect(res.executedLlmNodes).toContain("a");
    expect(res.executedLlmNodes).toContain("fb");
    expect(res.lastContent).toBe("fallback-out");
  });

  test("a non-429 error does NOT trigger the on_429 fallback", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const primary = {
      name: "p",
      async chat() {
        calls.chat.push("p");
        const err = new Error("server error") as Error & { status: number };
        err.status = 500;
        throw err;
      },
      async *chatStream() { /* noop */ },
    } satisfies Provider;
    const fallback = fakeProvider("fb", calls);
    const g = makeGraph(
      [
        node("start", "start"),
        llm("a", { provider: "p", on_429: "fb" }),
        llm("fb", { provider: "fb" }),
        node("end", "end"),
      ],
      [
        edge("start", "a"),
        edge("a", "fb"),
        edge("fb", "end"),
      ],
    );
    const d = deps(calls, { name: "p", provider: primary }, { name: "fb", provider: fallback });
    const res = await run(g, d);
    // primary threw 500 → no fallback, execution stops; node not in executedLlmNodes
    expect(res.executedLlmNodes).toEqual([]);
    expect(calls.chat).not.toContain("fb");
    expect(res.lastContent).toBe("");
  });
});

describe("tool_calls_route routing", () => {
  test("a response with tool_calls reroutes to the tool_calls_route node", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const toolProvider = {
      name: "tp",
      async chat() {
        calls.chat.push("tp");
        return {
          status: 200,
          choices: [{ message: { content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "search", arguments: "{}" } }] } }],
        };
      },
      async *chatStream() { /* noop */ },
    } satisfies Provider;
    const handler = fakeProvider("th", calls, { content: "handled" });
    const g = makeGraph(
      [
        node("start", "start"),
        llm("a", { provider: "tp", tool_calls_route: "th" }),
        llm("th", { provider: "th" }),
        node("end", "end"),
      ],
      [
        edge("start", "a"),
        edge("a", "th"),
        edge("th", "end"),
      ],
    );
    const d = deps(calls, { name: "tp", provider: toolProvider }, { name: "th", provider: handler });
    const res = await run(g, d);
    expect(calls.chat).toContain("tp");
    expect(calls.chat).toContain("th");
    expect(res.executedLlmNodes).toEqual(["a", "th"]);
    expect(res.lastContent).toBe("handled");
  });

  test("a response without tool_calls continues the normal path", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const normal = fakeProvider("p", calls, { content: "normal-out" });
    const handler = fakeProvider("th", calls);
    const g = makeGraph(
      [
        node("start", "start"),
        llm("a", { provider: "p", tool_calls_route: "th" }),
        llm("th", { provider: "th" }),
        node("end", "end"),
      ],
      [
        edge("start", "a"),
        edge("a", "th"),
        edge("th", "end"),
      ],
    );
    const d = deps(calls, { name: "p", provider: normal }, { name: "th", provider: handler });
    const res = await run(g, d);
    // no tool_calls in response → normal path, both execute sequentially
    expect(res.executedLlmNodes).toEqual(["a", "th"]);
    expect(calls.chat).toContain("p");
  });
});

describe("ctx per-node override", () => {
  test("ctx is passed as params.ctx on the payload", async () => {
    const calls: Calls = { chat: [], stream: [] };
    let capturedPayload: Record<string, unknown> | null = null;
    const spy = {
      name: "spy",
      async chat(payload: Record<string, unknown>) {
        capturedPayload = payload;
        calls.chat.push("spy");
        return { status: 200, choices: [{ message: { content: "ok" } }] };
      },
      async *chatStream() { /* noop */ },
    } satisfies Provider;
    const g = makeGraph(
      [
        node("start", "start"),
        llm("a", { provider: "spy", ctx: 4096 }),
        node("end", "end"),
      ],
      [edge("start", "a"), edge("a", "end")],
    );
    const d = deps(calls, { name: "spy", provider: spy });
    await run(g, d);
    expect(capturedPayload).not.toBeNull();
    expect((capturedPayload!.params as Record<string, unknown>)?.ctx).toBe(4096);
  });
});

describe("single-terminal streaming on the executed path", () => {
  test("only the LAST executed step streams; intermediates run non-streaming + step events", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const p = fakeProvider("p", calls);
    const g = makeGraph(
      [node("start", "start"), llm("a"), llm("b"), llm("c"), node("end", "end")],
      [edge("start", "a"), edge("a", "b"), edge("b", "c"), edge("c", "end")],
    );
    const d = deps(calls, { name: "p", provider: p });
    const res = await run(g, d, {
      streamRequested: true,
      signal: new AbortController().signal,
      payload: {},
    });

    // a and b ran non-streaming; only c streamed once.
    expect(calls.chat).toEqual(["p", "p"]);
    expect(calls.stream).toEqual(["p"]);
    expect(res.executedLlmNodes).toEqual(["a", "b", "c"]);
    // Intermediates emitted step events; the single terminal step is marked.
    const stepEvents = res.events.filter((e) => e.type === "step");
    expect(stepEvents.length).toBe(2);
    const terminals = res.events.filter((e) => e.type === "terminal");
    expect(terminals.length).toBe(1);
  });

  test("a streamed complex graph returns an SSE response with exactly one terminal chunk", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const p = fakeProvider("p", calls);
    const g = makeGraph(
      [node("start", "start"), llm("a"), llm("b"), node("end", "end")],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")],
    );
    const d = deps(calls, { name: "p", provider: p });
    const res = await run(g, d, {
      streamRequested: true,
      signal: new AbortController().signal,
      payload: {},
    });

    expect(res.response.status).toBe(200);
    expect(res.response.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.response.text();
    const dones = (body.match(/data: \[DONE\]/g) ?? []).length;
    expect(dones).toBe(1);
  });
});

// ── pipeline composition node (pipeline-composition spec) ──

describe("pipeline composition node", () => {
  /**
   * Helper: create a simple child pipeline (graph) with one llm_call and an end.
   * The child graph is what `getPipeline` resolves to at runtime.
   */
  function childPipeline(
    id: string,
    providerName: string,
  ): GraphPipeline {
    return graphWithId(
      id,
      [node("start", "start"), llm("llm", { provider: providerName }), node("end", "end")],
      [edge("start", "llm"), edge("llm", "end")],
    );
  }

  function depsWithPipelines(
    _calls: Calls,
    pipelines: GraphPipeline[],
    ...providers: Array<{ name: string; provider: Provider }>
  ): GraphEngineDeps {
    const map = new Map<string, Provider>();
    for (const p of providers) map.set(p.name, p.provider);
    const pipelineMap = new Map<string, GraphPipeline>();
    for (const pg of pipelines) pipelineMap.set(pg.id, pg);
    return {
      providers: map,
      getPipeline: (name: string) => pipelineMap.get(name),
    };
  }

  /** Build a pipeline with a specific id and name (makeGraph ignores overrides). */
  function graphWithId(id: string, nodes: GraphNode[], edges: GraphEdge[]): GraphPipeline {
    return { id, name: id, nodes, edges };
  }

  test("simple pipeline resolves and executes, output feeds parent lastResponse", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const child = childPipeline("child1", "cp");

    // Parent graph: start → pipeline(child1) → end
    const parent = graphWithId("parent",
      [
        node("start", "start"),
        node("invoke", "pipeline", { pipeline: "child1" }),
        node("end", "end"),
      ],
      [edge("start", "invoke"), edge("invoke", "end")],
    );

    const d = depsWithPipelines(calls, [child], { name: "cp", provider: fakeProvider("cp", calls, { content: "child-output" }) });
    const res = await runGraphEngine(parent, d);
    // The child pipeline's llm_call was invoked
    expect(calls.chat).toContain("cp");
    // The parent's lastContent should reflect the child's output
    expect(res.lastContent).toBe("child-output");
  });

  test("unregistered pipeline name fails with a clear error", async () => {
    const calls: Calls = { chat: [], stream: [] };

    const parent = graphWithId("parent",
      [
        node("start", "start"),
        node("invoke", "pipeline", { pipeline: "nonexistent" }),
        node("end", "end"),
      ],
      [edge("start", "invoke"), edge("invoke", "end")],
    );

    const d = depsWithPipelines(calls, [], { name: "p", provider: fakeProvider("p", calls) });
    const res = await runGraphEngine(parent, d);
    // The child was never invoked (the pipeline ref didn't resolve) → no llm calls.
    expect(res.executedLlmNodes).toEqual([]);
    expect(calls.chat).toEqual([]);
    // Execution produced no response because the pipeline resolution failed.
    expect(res.lastContent).toBe("");
    expect(res.lastResponse).toBeNull();
  });

  test("params are merged into the invoked pipeline's input variables", async () => {
    const calls: Calls = { chat: [], stream: [] };
    // Child pipeline that captures the received payload via the provider.
    let capturedPayload: Record<string, unknown> | null = null;
    const spyProvider: Provider = {
      name: "spy",
      async chat(payload: Record<string, unknown>) {
        capturedPayload = payload;
        calls.chat.push("spy");
        return { status: 200, choices: [{ message: { content: "ok" } }] };
      },
      async *chatStream() { /* noop */ },
    };

    const child = graphWithId(
      "child",
      [node("start", "start"), llm("llm", { provider: "spy" }), node("end", "end")],
      [edge("start", "llm"), edge("llm", "end")],
    );

    const parent = graphWithId(
      "parent",
      [
        node("start", "start"),
        node("invoke", "pipeline", { pipeline: "child", params: { topic: "science" } }),
        node("end", "end"),
      ],
      [edge("start", "invoke"), edge("invoke", "end")],
    );

    const d = depsWithPipelines(calls, [child], { name: "spy", provider: spyProvider });
    const res = await runGraphEngine(parent, d);
    // The child pipeline ran and received the parent's payload.
    expect(calls.chat).toEqual(["spy"]);
    expect(capturedPayload).not.toBeNull();
    // The params passed on the pipeline node reach the child's input variables.
    const childParams = (capturedPayload!.params as Record<string, unknown>) ?? {};
    expect(childParams).toMatchObject({ topic: "science" });
    // The child's output feeds back to the parent.
    expect(res.lastContent).toBe("ok");
  });

  test("nested pipeline invocation within depth limit runs successfully", async () => {
    const calls: Calls = { chat: [], stream: [] };
    const p3 = fakeProvider("p3", calls, { content: "deep-out" });

    // leaf pipeline: start → llm → end
    const leaf = graphWithId("leaf",
      [node("start", "start"), llm("llm", { provider: "p3" }), node("end", "end")],
      [edge("start", "llm"), edge("llm", "end")],
    );

    // mid pipeline: start → pipeline(leaf) → end
    const mid = graphWithId("mid",
      [
        node("start", "start"),
        node("invoke", "pipeline", { pipeline: "leaf" }),
        node("end", "end"),
      ],
      [edge("start", "invoke"), edge("invoke", "end")],
    );

    // top pipeline: start → pipeline(mid) → end (depth 2, within default max 5)
    const top = graphWithId("top",
      [
        node("start", "start"),
        node("invoke", "pipeline", { pipeline: "mid" }),
        node("end", "end"),
      ],
      [edge("start", "invoke"), edge("invoke", "end")],
    );

    const d = depsWithPipelines(calls, [leaf, mid], { name: "p3", provider: p3 });
    const res = await runGraphEngine(top, d);
    expect(calls.chat).toContain("p3");
    expect(res.lastContent).toBe("deep-out");
  });

  test("composition exceeding depth limit fails with a clear error", async () => {
    const calls: Calls = { chat: [], stream: [] };

    // Build a chain of pipelines deeper than the default max of 5.
    // Each pipeline calls the next: p5→p4→p3→p2→p1→leaf (depth 6 from p5).
    const leaf = graphWithId("leaf",
      [node("start", "start"), llm("llm", { provider: "p" }), node("end", "end")],
      [edge("start", "llm"), edge("llm", "end")],
    );

    const pipelines: GraphPipeline[] = [leaf];
    let currentTarget = "leaf";
    for (let i = 1; i <= 6; i++) {
      const id = `depth-${i}`;
      const pg = graphWithId(id,
        [
          node("start", "start"),
          node("invoke", "pipeline", { pipeline: currentTarget }),
          node("end", "end"),
        ],
        [edge("start", "invoke"), edge("invoke", "end")],
      );
      pipelines.push(pg);
      currentTarget = id;
    }

    // The top-level pipeline is depth-6, which nests 7 levels deep (6 + leaf)
    const top = graphWithId("top",
      [
        node("start", "start"),
        node("invoke", "pipeline", { pipeline: "depth-6" }),
        node("end", "end"),
      ],
      [edge("start", "invoke"), edge("invoke", "end")],
    );

    const d = depsWithPipelines(
      calls,
      [...pipelines, top],
      { name: "p", provider: fakeProvider("p", calls) },
    );
    // Should NOT throw but should surface a depth error
    const res = await runGraphEngine(top, d);
    // The error state should indicate depth exceeded
    expect(res.lastResponse).toBeNull();
  });
});
