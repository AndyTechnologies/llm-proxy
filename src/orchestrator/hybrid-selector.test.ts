/**
 * Hybrid selector tests (strict TDD — Slice B, task 2.5).
 *
 * pipeline-orchestration (modified) scenarios covered:
 *   - "Linear-compatible graph routes to the linear engine": a single-path
 *     graph is served as a `ParsedChain` for `runChain`.
 *   - "Complex graph with a condition routes to the graph engine": a graph
 *     with a `condition` + branches dispatches to the graph engine.
 *
 * The selector is pure + dependency-injected: it decides the runtime by shape
 * (`selectEngine`) and resolves a dispatch for a pipeline name (`resolve`).
 */
import { describe, expect, test } from "bun:test";
import type { ParsedChain } from "./parser.js";
import {
  createHybridSelector,
  graphToParsedChain,
  selectEngine,
  type HybridSelectorDeps,
} from "./hybrid-selector.js";
import type { AstExpr, GraphEdge, GraphNode, GraphPipeline } from "./graph.js";

const node = (
  id: string,
  type: GraphNode["type"],
  extra: Partial<GraphNode> = {},
): GraphNode => ({ id, type, ...extra });

const llm = (id: string, extra: Partial<GraphNode> = {}) =>
  node(id, "llm_call", { model: "m", ...extra });

const edge = (from: string, to: string, guard?: "true" | "false"): GraphEdge => ({
  from,
  to,
  ...(guard ? { guard } : {}),
});

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphPipeline {
  return { id: "g", name: "g", nodes, edges };
}

function linearGraph(): GraphPipeline {
  return makeGraph(
    [node("start", "start"), llm("a", { model: "model-a" }), llm("b", { model: "model-b" }), node("end", "end")],
    [edge("start", "a"), edge("a", "b"), edge("b", "end")],
  );
}

function conditionalGraph(): GraphPipeline {
  const cond: AstExpr = { op: "compare", field: "lastResponse.status", op2: "==", value: 200 };
  return makeGraph(
    [
      node("start", "start"),
      llm("a"),
      node("cond", "condition", { condition: cond }),
      llm("t"),
      llm("f"),
      node("end", "end"),
    ],
    [
      edge("start", "a"),
      edge("a", "cond"),
      edge("cond", "t", "true"),
      edge("cond", "f", "false"),
      edge("t", "end"),
      edge("f", "end"),
    ],
  );
}

function graphOnlyDeps(graph: GraphPipeline): HybridSelectorDeps {
  const chains = new Map<string, ParsedChain>();
  const graphs = new Map<string, GraphPipeline>();
  graphs.set(graph.name ?? graph.id, graph);
  return {
    getChain: (name) => chains.get(name),
    getGraph: (name) => graphs.get(name),
  };
}

function mixedDeps(graphs: GraphPipeline[], chains: ParsedChain[]): HybridSelectorDeps {
  const gmap = new Map(graphs.map((g) => [g.name ?? g.id, g]));
  const cmap = new Map(chains.map((c) => [c.name, c]));
  return {
    getChain: (name) => cmap.get(name),
    getGraph: (name) => gmap.get(name),
  };
}

describe("selectEngine — pick runtime by graph shape", () => {
  test("a single-path linear graph selects the linear engine", () => {
    expect(selectEngine(linearGraph())).toBe("linear");
  });

  test("a graph with a condition selects the graph engine", () => {
    expect(selectEngine(conditionalGraph())).toBe("graph");
  });

  test("a branched (fan) graph selects the graph engine", () => {
    const g = makeGraph(
      [
        node("start", "start"),
        node("fan", "fan", { parallel: true }),
        llm("pa"),
        llm("pb"),
        node("end", "end"),
      ],
      [edge("start", "fan"), edge("fan", "pa"), edge("fan", "pb"), edge("pa", "end"), edge("pb", "end")],
    );
    expect(selectEngine(g)).toBe("graph");
  });
});

describe("graphToParsedChain — linear graph as a ParsedChain", () => {
  test("a linear graph converts to an ordered ParsedChain of steps", () => {
    const chain = graphToParsedChain(linearGraph());
    expect(chain).not.toBeNull();
    expect(chain!.name).toBe("g");
    expect(chain!.steps.map((s) => s.model)).toEqual(["model-a", "model-b"]);
  });

  test("llm providers default to the graph default provider on each step", () => {
    const graph = makeGraph(
      [
        node("start", "start"),
        llm("a", { model: "ma", provider: "prov-a" }),
        llm("b", { model: "mb" }),
        node("end", "end"),
      ],
      [edge("start", "a"), edge("a", "b"), edge("b", "end")],
    );
    const chain = graphToParsedChain(graph, { defaultProvider: "prov-default" });
    expect(chain!.steps.map((s) => s.provider)).toEqual(["prov-a", "prov-default"]);
  });

  test("a non-linear graph conversion returns null", () => {
    expect(graphToParsedChain(conditionalGraph())).toBeNull();
  });
});

describe("createHybridSelector — runtime dispatch by pipeline name", () => {
  test("a name held as a chain dispatches to the linear engine", () => {
    const chain: ParsedChain = {
      name: "linearp",
      steps: [{ type: "generate", model: "model-a", provider: "llama-server" }],
    };
    const sel = createHybridSelector(mixedDeps([], [chain]));
    const d = sel.resolve("linearp");
    expect(d).toEqual({ kind: "linear", chain });
  });

  test("a complex graph dispatches to the graph engine", () => {
    const graph = conditionalGraph();
    const sel = createHybridSelector(graphOnlyDeps(graph));
    const d = sel.resolve("g");
    expect(d).toEqual({ kind: "graph", graph });
  });

  test("a linear graph held as a graph is served to the linear engine as a chain", () => {
    const graph = linearGraph();
    const sel = createHybridSelector(graphOnlyDeps(graph));
    const d = sel.resolve("g");
    expect(d!.kind).toBe("linear");
    if (d!.kind === "linear") {
      expect(d!.chain.steps.map((s) => s.model)).toEqual(["model-a", "model-b"]);
    }
  });

  test("an unknown pipeline name resolves to undefined", () => {
    const sel = createHybridSelector(mixedDeps([], []));
    expect(sel.resolve("nope")).toBeUndefined();
  });
});
