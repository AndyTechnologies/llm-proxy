/**
 * Graph validation + SAFE AST interpreter tests (strict TDD — Slice B).
 *
 * Task 2.1 — node/edge validation (dashboard-api validate scenarios):
 *  - acyclic except `loop` boundaries
 *  - exactly one `start` and ≥1 `end`
 *  - model existence for `llm_call` nodes
 *  - required fields (start/end ids exist, edges reference real nodes)
 *
 * Task 2.2 — SAFE AST (graph-engine Req "Safe AST condition evaluation"):
 *  - typed walker over compare/logical/not/exists using
 *    lastResponse.status/content, error, variables
 *  - unsafe input (eval/new Function/URL/file/network) rejected
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateAst,
  sanitizeAst,
  validateGraph,
  type AstContext,
  type AstExpr,
  type GraphEdge,
  type GraphNode,
  type GraphPipeline,
} from "./graph.js";

/** Helper to build a minimal graph. */
function makeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  overrides: Partial<GraphPipeline> = {},
): GraphPipeline {
  return { id: "g1", name: "g1", nodes, edges, ...overrides };
}

/** Convenience node factory. */
function node(
  id: string,
  type: GraphNode["type"],
  extra: Partial<GraphNode> = {},
): GraphNode {
  return { id, type, ...extra };
}

const MODEL = { model: "gemma" };
const llm = (id: string, extra: Partial<GraphNode> = {}) =>
  node(id, "llm_call", { ...MODEL, ...extra });

// ── Task 2.1: graph validation ──

describe("validateGraph — structural invariants", () => {
  test("accepts a valid acyclic graph with one start and one end", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects a graph with zero start nodes (RED: zero-start)", () => {
    const graph = makeGraph(
      [llm("a"), node("end", "end")],
      [{ from: "a", to: "end" }],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /start/i.test(e))).toBe(true);
  });

  test("rejects a graph with zero end nodes (needs ≥1 end)", () => {
    const graph = makeGraph(
      [node("start", "start"), llm("a")],
      [{ from: "start", to: "a" }],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /end/i.test(e))).toBe(true);
  });

  test("rejects a cyclic graph outside loop boundaries (RED: cyclic)", () => {
    const graph = makeGraph(
      [node("start", "start"), llm("a"), node("end", "end")],
      [
        { from: "start", to: "a" },
        { from: "a", to: "a" }, // self-cycle outside a loop boundary
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /ciclo/i.test(e))).toBe(true);
  });

  test("allows a cycle when it is a loop boundary (loop node with body)", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop", { body: ["a"] }),
        llm("a"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "loop" },
        { from: "loop", to: "a" },
        { from: "a", to: "loop" }, // back edge — valid only because 'a' is loop body
        { from: "loop", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(true);
  });

  test("rejects a back edge that is not enclosed by a loop body (escape)", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop", { body: ["a"] }),
        llm("a"),
        llm("b"), // NOT in the loop body — an edge back to 'a' is illegal
        node("end", "end"),
      ],
      [
        { from: "start", to: "loop" },
        { from: "loop", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" }, // b->a crosses the loop boundary illegally
        { from: "loop", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
  });

  test("rejects an edge referencing a nonexistent node", () => {
    const graph = makeGraph(
      [node("start", "start"), llm("a"), node("end", "end")],
      [{ from: "start", to: "missing" }],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /inexistente/i.test(e))).toBe(true);
  });

  test("rejects an llm_call whose model does not exist (RED: model existence)", () => {
    const graph = makeGraph(
      [node("start", "start"), llm("a", { model: "nope-model" }), node("end", "end")],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /nope-model/.test(e))).toBe(true);
  });

  test("model existence is ignored when knownModels is omitted", () => {
    const graph = makeGraph(
      [node("start", "start"), llm("a", { model: "any" }), node("end", "end")],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph);
    expect(result.ok).toBe(true);
  });

  test("rejects a node disconnected from the graph", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        llm("b"), // isolated: no edges at all
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /no es alcanzable|desconectado/.test(e))).toBe(true);
  });

  test("rejects a reachable node with no path to an end (dead end)", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        llm("b"), // reachable via a, but b has no outgoing edge
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "a", to: "b" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /camino hacia un nodo end/.test(e))).toBe(true);
  });

  test("accepts a loop whose members are chained only by body (auto-chain)", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop", { body: ["m1", "m2"] }),
        llm("m1"),
        llm("m2"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "loop" },
        { from: "loop", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(true);
  });

  test("accepts an on_429 fallback target that has no incoming edge", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { on_429: "retry" }),
        llm("retry"), // reached only via the virtual on_429 edge from a
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "retry", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(true);
  });

  test("rejects an on_429 target that does not exist", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { on_429: "ghost" }),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /on_429/.test(e) && /inexistente/.test(e))).toBe(true);
  });

  test("rejects a tool_calls_route target that does not exist", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { tool_calls_route: "ghost" }),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /tool_calls_route/.test(e) && /inexistente/.test(e))).toBe(true);
  });

  test("rejects a start with no outgoing edge (nothing reachable)", () => {
    const graph = makeGraph(
      [node("start", "start"), node("end", "end")],
      [],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /no es alcanzable|camino/.test(e))).toBe(true);
  });

  test("rejects a loop whose exit never reaches an end", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop", { body: ["m1"] }),
        llm("m1"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "loop" },
        { from: "loop", to: "m1" },
        { from: "m1", to: "loop" }, // valid loop boundary, but no exit toward end
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /camino hacia un nodo end/.test(e))).toBe(true);
  });
});

describe("validateGraph — readable node labels in errors", () => {
  test("names a disconnected llm_call with its model", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        llm("b"), // isolated: no edges at all
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    const hit = result.errors.find((e) => /no es alcanzable/.test(e)) ?? "";
    expect(hit).toContain("LLM_CALL de modelo gemma (b)");
  });

  test("names a dead-end llm_call with its model", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a"),
        llm("b"), // reachable via a, but b has no outgoing edge
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "a", to: "b" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    const hit = result.errors.find((e) => /camino hacia un nodo end/.test(e)) ?? "";
    expect(hit).toContain("LLM_CALL de modelo gemma (b)");
  });

  test("uses the plain type label when an llm_call has no model", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("a", "llm_call"), // missing model
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    const hit = result.errors.find((e) => /campo obligatorio/.test(e)) ?? "";
    expect(hit).toContain("LLM_CALL (a)");
    expect(hit).not.toContain("de modelo");
  });

  test("does not duplicate the model in the unknown-model error", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { model: "nope" }),
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    const hit = result.errors.find((e) => /modelo desconocido/.test(e)) ?? "";
    expect(hit).toContain("LLM_CALL (a)");
    expect(hit).toContain('"nope"');
  });

  test("labels non-llm node types with their upper-cased type", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop"), // missing body
        llm("a"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "loop" },
        { from: "loop", to: "a" },
        { from: "loop", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    const hit = result.errors.find((e) => /campo obligatorio/.test(e)) ?? "";
    expect(hit).toContain("LOOP (loop)");
  });
});

describe("validateGraph — required fields per node type", () => {
  test("an llm_call without a model fails required-field validation", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("a", "llm_call"), // missing model
        node("end", "end"),
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /model/i.test(e))).toBe(true);
  });

  test("a loop node without a body fails", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("loop", "loop"), // missing body
        llm("a"),
        node("end", "end"),
      ],
      [
        { from: "start", to: "loop" },
        { from: "loop", to: "a" },
        { from: "loop", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /loop/i.test(e))).toBe(true);
  });

  test("a pipeline/composition node without a pipeline ref fails", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        node("p", "pipeline"), // missing pipeline ref
        node("end", "end"),
      ],
      [
        { from: "start", to: "p" },
        { from: "p", to: "end" },
      ],
    );
    const result = validateGraph(graph, { knownModels: ["gemma"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /pipeline/i.test(e))).toBe(true);
  });
});

// ── Task 2.2: SAFE AST ──

describe("safe AST — evaluateAst over context", () => {
  const ctx: AstContext = {
    lastResponse: { status: 200, content: "hello world" },
    error: null,
    variables: { topic: "x" },
  };

  test("compare lastResponse.status == 200 is true", () => {
    expect(
      evaluateAst({ op: "compare", field: "lastResponse.status", op2: "==", value: 200 }, ctx),
    ).toBe(true);
  });

  test("compare lastResponse.content contains a substring via == is false (string equality)", () => {
    expect(
      evaluateAst({ op: "compare", field: "lastResponse.content", op2: "==", value: "hello world" }, ctx),
    ).toBe(true);
    expect(
      evaluateAst({ op: "compare", field: "lastResponse.content", op2: "!=", value: "goodbye" }, ctx),
    ).toBe(true);
  });

  test("exists(error) is false when error is null and true when set", () => {
    expect(evaluateAst({ op: "exists", field: "error" }, ctx)).toBe(false);
    expect(
      evaluateAst(
        { op: "exists", field: "error" },
        { ...ctx, error: "boom" },
      ),
    ).toBe(true);
  });

  test("logical AND with compare + not(exists(error)) evaluates true", () => {
    const expr: AstExpr = {
      op: "logical",
      and: true,
      args: [
        { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
        { op: "not", child: { op: "exists", field: "error" } },
      ],
    };
    expect(evaluateAst(expr, ctx)).toBe(true);
  });

  test("logical OR with a false AND a true branch evaluates true", () => {
    const expr: AstExpr = {
      op: "logical",
      and: false,
      args: [
        { op: "compare", field: "lastResponse.status", op2: "==", value: 500 },
        { op: "exists", field: "variables.topic" },
      ],
    };
    expect(evaluateAst(expr, ctx)).toBe(true);
  });

  test("not inverts a sub-expression", () => {
    expect(
      evaluateAst({ op: "not", child: { op: "compare", field: "lastResponse.status", op2: "==", value: 200 } }, ctx),
    ).toBe(false);
  });
});

describe("safe AST — sanitizeAst rejects unsafe input (RED: unsafe-input-rejected)", () => {
  test("rejects an unknown op (would-be eval/new Function style)", () => {
    expect(
      sanitizeAst({ op: "eval", code: "1+1" }),
    ).toBeNull();
    expect(
      sanitizeAst({ op: "Function", code: "return 1" }),
    ).toBeNull();
  });

  test("rejects field names referencing URL/file/network targets", () => {
    // A compare field that smuggles a URL/file/network reference is unsafe.
    expect(
      sanitizeAst({ op: "compare", field: "http://evil/x", op2: "==", value: 1 }),
    ).toBeNull();
    expect(
      sanitizeAst({ op: "exists", field: "file:///etc/passwd" }),
    ).toBeNull();
  });

  test("rejects opaque code strings on any node (no eval/new Function literals)", () => {
    // Guard: even if a future arg carries code text, it must be rejected.
    expect(sanitizeAst({ op: "eval", code: ":; rm -rf /" })).toBeNull();
  });

  test("accepts a well-formed compare/logical/not/exists AST", () => {
    const ok: AstExpr = {
      op: "logical",
      and: true,
      args: [
        { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
        { op: "not", child: { op: "exists", field: "error" } },
      ],
    };
    expect(sanitizeAst(ok)).toEqual(ok);
  });
});
