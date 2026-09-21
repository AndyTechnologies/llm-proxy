/**
 * Editor pure-helper tests (Task 6.7, workflow-editor spec): palette
 * completeness, cycle rejection, validation errors, and YAML round-trips.
 */
import { describe, expect, test } from "bun:test";
import type { GraphNode } from "../../../src/orchestrator/graph.js";
import {
  editorToYaml,
  flowEdgeFrom,
  graphEdgeFrom,
  makeEditorNode,
  paletteCoversTaxonomy,
  validateEditorGraph,
  wouldCreateCycle,
  yamlToEditor,
} from "./workflow-nodes.js";

const basic = (): { nodes: GraphNode[]; edges: ReturnType<typeof graphEdgeFrom>[] } => ({
  nodes: [
    { id: "start", type: "start" },
    { id: "a", type: "llm_call", model: "llama" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "a" },
    { from: "a", to: "end" },
  ],
});

describe("editor palette (6.7)", () => {
  test("palette covers the full node taxonomy (>= 10 types)", () => {
    expect(paletteCoversTaxonomy()).toBe(true);
    expect(makeEditorNode("start", new Map(), { x: 0, y: 0 }).type).toBe("start");
  });

  test("makeEditorNode applies palette defaults and increments ids per type", () => {
    const counter = new Map<string, number>();
    const first = makeEditorNode("llm_call", counter, { x: 10, y: 20 });
    const second = makeEditorNode("llm_call", counter, { x: 30, y: 40 });
    expect(first).toMatchObject({ id: "llm_call-1", model: "llama", mode: "generate" });
    expect(first.position).toEqual({ x: 10, y: 20 });
    expect(second.id).toBe("llm_call-2");
  });
});

describe("cycle rejection (6.7)", () => {
  test("back edge closes a cycle; a forward edge does not", () => {
    const graph = basic();
    expect(wouldCreateCycle(graph, "end", "start")).toBe(true);
    expect(wouldCreateCycle(graph, "start", "end")).toBe(false);
  });

  test("self edge is a cycle", () => {
    expect(wouldCreateCycle(basic(), "a", "a")).toBe(true);
  });

  test("transitive loop (c -> a when a -> b -> c) is detected", () => {
    const graph = {
      nodes: [
        { id: "a", type: "start" },
        { id: "b", type: "llm_call", model: "llama" },
        { id: "c", type: "end" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    expect(wouldCreateCycle(graph, "c", "a")).toBe(true);
    expect(wouldCreateCycle(graph, "c", "b")).toBe(true);
    expect(wouldCreateCycle(graph, "a", "c")).toBe(false);
  });
});

describe("validation (6.7)", () => {
  test("a valid acyclic graph has no errors", () => {
    const graph = basic();
    expect(validateEditorGraph(graph.nodes, graph.edges)).toEqual([]);
  });

  test("llm_call without a model is flagged by node", () => {
    const graph = basic();
    graph.nodes[1] = { id: "a", type: "llm_call" };
    const errors = validateEditorGraph(graph.nodes, graph.edges);
    expect(errors.some((e) => e.includes("a") && e.includes("model"))).toBe(true);
  });
});

describe("YAML import/export (6.7)", () => {
  const GOOD_YAML =
    "name: Demo\n" +
    "nodes:\n" +
    "  - {id: start, type: start}\n" +
    "  - {id: a, type: llm_call, model: llama}\n" +
    "  - {id: end, type: end}\n" +
    "edges:\n" +
    "  - {from: start, to: a}\n" +
    "  - {from: a, to: end}\n";

  test("import → export round-trips the graph", () => {
    const imported = yamlToEditor(GOOD_YAML);
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.nodes.map((n) => n.id)).toEqual(["start", "a", "end"]);
    expect(imported.edges).toHaveLength(2);
    const exported = editorToYaml(imported.nodes, imported.edges, imported.name);
    expect(exported).toContain("name: Demo");
    expect(exported).toContain("type: llm_call");
  });

  test("invalid YAML is rejected with a message naming the node", () => {
    const result = yamlToEditor(
      "name: broken\nnodes:\n  - {id: start, type: start}\n  - {id: x2, type: wat}\nedges: []\n",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("wat");
  });

  test("flow edge conversion carries the guard", () => {
    const flow = flowEdgeFrom({ from: "a", to: "b", guard: "true" });
    expect(flow).toEqual({ id: "a->b", source: "a", target: "b", guard: "true" });
    expect(graphEdgeFrom(flow)).toEqual({ from: "a", to: "b", guard: "true" });
    expect(graphEdgeFrom(flowEdgeFrom({ from: "a", to: "b" }))).toEqual({ from: "a", to: "b" });
  });
});