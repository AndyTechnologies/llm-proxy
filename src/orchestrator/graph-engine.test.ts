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
