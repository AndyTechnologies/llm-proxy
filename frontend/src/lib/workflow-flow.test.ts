import { describe, expect, test } from "bun:test";
import {
  NODE_GROUPS,
  astSummary,
  flowToGraph,
  graphToFlow,
  nodeGroupOf,
  nodeSummaryLines,
  parseWorkflowYamlToGraph,
  serializeGraphToYaml,
  uniqueEdgeId,
  type FlowNode,
} from "./workflow-flow.js";
import { NODE_TYPES } from "./workflow-nodes.js";
import type { GraphNode, GraphPipeline } from "./workflow-nodes.js";

/** Minimal valid engine graph: start → llm → end (store-contract shape). */
function demoGraph(): GraphPipeline {
  return {
    id: "demo",
    name: "demo",
    nodes: [
      { id: "start", type: "start" },
      { id: "llm", type: "llm_call", model: "SmolLM3", mode: "generate" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "llm" },
      { from: "llm", to: "end" },
    ],
  };
}

describe("nodeGroupOf", () => {
  test("maps all 14 engine types to the 6 groups", () => {
    const byGroup = new Map<string, number>();
    for (const id of NODE_TYPES) {
      const group = nodeGroupOf(id);
      expect(NODE_GROUPS).toContain(group);
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    }
    expect(byGroup.get("wf-start-end")).toBe(2); // start, end
    expect(byGroup.get("wf-llm")).toBe(1); // llm_call
    expect(byGroup.get("wf-branch")).toBe(5); // condition, loop, fan, join, router
    expect(byGroup.get("wf-data")).toBe(4); // rag_local, data.code, memory, embeddings
    expect(byGroup.get("wf-pipeline")).toBe(1); // pipeline
    expect(byGroup.get("wf-output")).toBe(1); // output
  });
});

describe("graphToFlow", () => {
  test("converts nodes with group type and whitelisted values", () => {
    const { nodes } = graphToFlow(demoGraph());
    expect(nodes.map((node) => node.id)).toEqual(["start", "llm", "end"]);
    const llm = nodes.find((node) => node.id === "llm");
    expect(llm?.type).toBe("wf-llm");
    expect(llm?.data.wNodeType).toBe("llm_call");
    expect(llm?.data.values).toEqual({ model: "SmolLM3", mode: "generate" });
  });

  test("positions are deterministic for the same graph", () => {
    const first = graphToFlow(demoGraph());
    const second = graphToFlow(demoGraph());
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });

  test("layers advance along edges from start nodes", () => {
    const { nodes } = graphToFlow(demoGraph());
    const start = nodes.find((node) => node.id === "start")!;
    const llm = nodes.find((node) => node.id === "llm")!;
    const end = nodes.find((node) => node.id === "end")!;
    expect(start.position.x).toBeLessThan(llm.position.x);
    expect(llm.position.x).toBeLessThan(end.position.x);
    expect(start.position.y).toBe(llm.position.y); // single chain: same row
  });

  test("siblings stack on the same layer column", () => {
    const graph: GraphPipeline = {
      id: "fan-out",
      name: "fan-out",
      nodes: [
        { id: "start", type: "start" },
        { id: "fan", type: "fan", parallel: true },
        { id: "a", type: "llm_call", model: "m1", mode: "generate" },
        { id: "b", type: "llm_call", model: "m2", mode: "generate" },
        { id: "join", type: "join" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "fan" },
        { from: "fan", to: "a" },
        { from: "fan", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const { nodes } = graphToFlow(graph);
    const a = nodes.find((node) => node.id === "a")!;
    const b = nodes.find((node) => node.id === "b")!;
    expect(a.position.x).toBe(b.position.x); // same layer
    expect(a.position.y).not.toBe(b.position.y); // stacked
  });

  test("cycles do not hang and stay deterministic", () => {
    const cyclic: GraphPipeline = {
      id: "c",
      name: "c",
      nodes: [
        { id: "a", type: "start" },
        { id: "b", type: "fan" },
        { id: "c", type: "end" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" }, // back edge
        { from: "b", to: "c" },
      ],
    };
    const first = graphToFlow(cyclic);
    const second = graphToFlow(cyclic);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });

  test("duplicate edges get unique deterministic ids, guards are preserved", () => {
    const graph: GraphPipeline = {
      id: "dup",
      name: "dup",
      nodes: [
        { id: "start", type: "start" },
        { id: "cond", type: "condition", condition: { op: "exists", field: "lastResponse.content" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "cond" },
        { from: "cond", to: "end", guard: "true" },
        { from: "cond", to: "end", guard: "false" },
      ],
    };
    const { edges } = graphToFlow(graph);
    expect(edges.map((edge) => edge.id)).toEqual(["start->cond", "cond->end", "cond->end#2"]);
    expect(edges[1].guard).toBe("true");
    expect(edges[2].guard).toBe("false");
  });
});

describe("uniqueEdgeId", () => {
  test("canonical form then #n suffixes", () => {
    const taken = new Set<string>();
    expect(uniqueEdgeId("a", "b", taken)).toBe("a->b");
    taken.add("a->b");
    expect(uniqueEdgeId("a", "b", taken)).toBe("a->b#2");
    taken.add("a->b#2");
    expect(uniqueEdgeId("a", "b", taken)).toBe("a->b#3");
  });
});

describe("flowToGraph", () => {
  test("admits only whitelisted fields — unknown values are dropped", () => {
    const nodes: FlowNode[] = [
      {
        id: "llm",
        type: "wf-llm",
        position: { x: 0, y: 0 },
        data: {
          wNodeType: "llm_call",
          label: "LLM call",
          values: { model: "SmolLM3", mode: "generate", bogus: "nope" },
        },
      },
    ];
    const graph = flowToGraph(nodes, []);
    expect(graph.nodes[0]).toEqual({ id: "llm", type: "llm_call", model: "SmolLM3", mode: "generate" });
  });

  test("preserves the universal parallel flag", () => {
    const graph = flowToGraph(
      [
        {
          id: "fan",
          type: "wf-branch",
          position: { x: 0, y: 0 },
          data: { wNodeType: "fan", label: "Fan", values: { parallel: true } },
        },
      ],
      [],
    );
    expect(graph.nodes[0]).toEqual({ id: "fan", type: "fan", parallel: true });
  });

  test("round-trips condition/router AST through the opaque slot", () => {
    const condition: GraphNode = {
      id: "cond",
      type: "condition",
      condition: { op: "exists", field: "lastResponse.content" },
    };
    const graph: GraphPipeline = {
      id: "rt",
      name: "rt",
      nodes: [{ id: "start", type: "start" }, condition, { id: "end", type: "end" }],
      edges: [
        { from: "start", to: "cond" },
        { from: "cond", to: "end", guard: "true" },
      ],
    };
    // flowToGraph emits a working-graph placeholder id — nodes/edges must match.
    const converted = graphToFlow(graph);
    const roundTripped = flowToGraph(converted.nodes, converted.edges);
    expect(roundTripped).toEqual({ id: "workflow", nodes: graph.nodes, edges: graph.edges });
  });

  test("round-trips pipeline params through the opaque slot", () => {
    const graph: GraphPipeline = {
      id: "pipe",
      name: "pipe",
      nodes: [
        { id: "start", type: "start" },
        { id: "sub", type: "pipeline", pipeline: "summary", params: { topic: "io" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "sub" },
        { from: "sub", to: "end" },
      ],
    };
    const converted = graphToFlow(graph);
    const roundTripped = flowToGraph(converted.nodes, converted.edges);
    expect(roundTripped).toEqual({ id: "workflow", nodes: graph.nodes, edges: graph.edges });
  });

  test("full canvas round-trip is stable (nodes + edges + guards)", () => {
    const graph = demoGraph();
    const converted = graphToFlow(graph);
    const back = flowToGraph(converted.nodes, converted.edges);
    expect(back).toEqual({ id: "workflow", nodes: graph.nodes, edges: graph.edges });
    // And converting the round-tripped graph reproduces the same canvas.
    expect(graphToFlow(back)).toEqual(converted);
  });
});

describe("workflow YAML helpers", () => {
  const DEMO_YAML = [
    "name: demo",
    "nodes:",
    "  - id: start",
    "    type: start",
    "  - id: llm",
    "    type: llm_call",
    "    model: SmolLM3",
    "    mode: generate",
    "  - id: end",
    "    type: end",
    "edges:",
    "  - from: start",
    "    to: llm",
    "  - from: llm",
    "    to: end",
    "",
  ].join("\n");

  test("parses valid YAML into the engine graph", () => {
    const result = parseWorkflowYamlToGraph(DEMO_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.id).toBe("demo");
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["start", "llm", "end"]);
    expect(result.graph.edges).toEqual([
      { from: "start", to: "llm" },
      { from: "llm", to: "end" },
    ]);
  });

  test("returns a friendly error envelope on malformed YAML", () => {
    const result = parseWorkflowYamlToGraph("name: broken\nnodes: 42\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  test("unknown node types and edge targets are rejected by the backend parser", () => {
    const unknownType = parseWorkflowYamlToGraph(
      "name: x\nnodes:\n  - id: start\n    type: nope\nedges: []\n",
    );
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) expect(unknownType.error).toMatch(/unknown type|nope/i);

    const unknownTarget = parseWorkflowYamlToGraph(
      "name: x\nnodes:\n  - id: start\n    type: start\nedges:\n  - from: start\n    to: ghost\n",
    );
    expect(unknownTarget.ok).toBe(false);
    if (!unknownTarget.ok) expect(unknownTarget.error).toMatch(/ghost/i);
  });

  test("serialize → parse round-trip deep-equals the graph", () => {
    const graph = demoGraph();
    const yaml = serializeGraphToYaml(graph);
    const reparsed = parseWorkflowYamlToGraph(yaml);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.graph).toEqual(graph);
  });

  test("serialized field order follows the engine NODE_FIELDS contract", () => {
    const graph: GraphPipeline = {
      id: "order",
      nodes: [
        {
          id: "llm",
          type: "llm_call",
          model: "SmolLM3",
          mode: "generate",
          system: "Be brief",
          on_429: "end",
          provider: "openai",
        },
      ],
      edges: [],
    };
    const yaml = serializeGraphToYaml(graph);
    const idx = (needle: string): number => yaml.indexOf(needle);
    // NODE_FIELDS order: id, type, parallel, model, provider, …, mode, …, system, …, on_429, …
    expect(idx("type:")).not.toBe(-1);
    expect(idx("type:")).toBeLessThan(idx("model:"));
    expect(idx("model:")).toBeLessThan(idx("provider:"));
    expect(idx("provider:")).toBeLessThan(idx("mode:"));
    expect(idx("mode:")).toBeLessThan(idx("system:"));
    expect(idx("system:")).toBeLessThan(idx("on_429:"));
  });

  test("round-trips guard expressions and duplicated edges through YAML", () => {
    const graph: GraphPipeline = {
      id: "guards",
      name: "guards",
      nodes: [
        { id: "start", type: "start" },
        { id: "cond", type: "condition", condition: { op: "exists", field: "lastResponse.content" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "cond" },
        { from: "cond", to: "end", guard: "true" },
        { from: "cond", to: "end", guard: "false" },
      ],
    };
    const yaml = serializeGraphToYaml(graph);
    const reparsed = parseWorkflowYamlToGraph(yaml);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.graph).toEqual(graph);
  });
});

describe("display helpers", () => {
  test("astSummary renders every SAFE AST shape", () => {
    expect(astSummary({ op: "exists", field: "lastResponse.content" })).toBe(
      "has lastResponse.content",
    );
    expect(
      astSummary({ op: "compare", field: "lastResponse.status", op2: "==", value: 200 }),
    ).toBe('lastResponse.status == 200');
    expect(astSummary({ op: "not", child: { op: "exists", field: "x" } })).toBe("not (has x)");
    expect(
      astSummary({
        op: "logical",
        and: false,
        args: [
          { op: "exists", field: "a" },
          { op: "exists", field: "b" },
        ],
      }),
    ).toBe("any(has a, has b)");
  });

  test("nodeSummaryLines is honest per type", () => {
    expect(
      nodeSummaryLines({
        wNodeType: "llm_call",
        label: "LLM call",
        values: { model: "SmolLM3", mode: "generate" },
      }),
    ).toEqual([
      { key: "model", value: "SmolLM3" },
      { key: "mode", value: "generate" },
    ]);

    expect(
      nodeSummaryLines({
        wNodeType: "llm_call",
        label: "LLM call",
        values: {},
      }),
    ).toEqual([{ key: "model", value: "unset" }]);

    expect(
      nodeSummaryLines({
        wNodeType: "condition",
        label: "Condition",
        values: {},
        condition: { op: "exists", field: "lastResponse.content" },
      }),
    ).toEqual([{ key: "condition", value: "has lastResponse.content" }]);

    expect(
      nodeSummaryLines({ wNodeType: "loop", label: "Loop", values: { body: ["a", "b"], iterations: 2 } }),
    ).toEqual([
      { key: "iterations", value: "2" },
      { key: "body", value: "2 nodes" },
    ]);

    expect(nodeSummaryLines({ wNodeType: "start", label: "Start", values: {} })).toEqual([]);
  });
});