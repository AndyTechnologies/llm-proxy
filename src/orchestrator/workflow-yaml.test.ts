import { describe, expect, test } from "bun:test";
import type { GraphNode, GraphPipeline } from "./graph.js";
import { parseWorkflowGraph, serializeWorkflowGraph } from "./workflow-yaml.js";

const node = (
  id: string,
  type: GraphNode["type"],
  extra: Partial<GraphNode> = {},
): GraphNode => ({ id, type, ...extra });

/** Every node type + every optional field, to prove nothing is dropped. */
const FULL: GraphPipeline = {
  id: "full",
  name: "Full Pipeline",
  nodes: [
    node("start", "start"),
    node("end", "end"),
    node("a", "llm_call", {
      model: "gemma",
      provider: "local",
      mode: "refine",
      ctx: 4096,
      system: "you are terse",
      assistant: "ok",
      user: "reserved",
      on_429: "retry",
      tool_calls_route: "tools",
      parallel: true,
    }),
    node("retry", "llm_call", { model: "gemma" }),
    node("tools", "llm_call", { model: "gemma" }),
    node("c", "condition", { condition: { op: "exists", field: "lastResponse.status" } }),
    node("lp", "loop", { body: ["m"], iterations: 2 }),
    node("m", "llm_call", { model: "gemma" }),
    node("fan", "fan", { parallel: true }),
    node("d1", "llm_call", { model: "gemma" }),
    node("d2", "llm_call", { model: "gemma" }),
    node("j", "join"),
    node("rag", "rag_local", { model: "gemma", k: 3 }),
    node("cod", "data.code", { code: "return 1;" }),
    node("mem", "memory", { convId: "conv-1" }),
    node("emb", "embeddings", { text: "sample" }),
    node("pip", "pipeline", { pipeline: "sub", params: { topic: "x" } }),
    node("rt", "router", { condition: { op: "exists", field: "error" } }),
    node("out", "output"),
  ],
  edges: [
    { from: "start", to: "a" },
    { from: "a", to: "c" },
    { from: "c", to: "lp", guard: "true" },
    { from: "c", to: "end", guard: "false" },
    { from: "lp", to: "fan" },
    { from: "fan", to: "d1" },
    { from: "fan", to: "d2" },
    { from: "d1", to: "j" },
    { from: "d2", to: "j" },
    { from: "j", to: "rag" },
    { from: "rag", to: "cod" },
    { from: "cod", to: "mem" },
    { from: "mem", to: "emb" },
    { from: "emb", to: "pip" },
    { from: "pip", to: "rt" },
    { from: "rt", to: "out", guard: "true" },
    { from: "rt", to: "end", guard: "false" },
    { from: "out", to: "end" },
  ],
};

describe("workflow-yaml (6.8)", () => {
  test("serialize → parse round-trips the full graph and its version", () => {
    const yaml = serializeWorkflowGraph(FULL, 3);
    expect(typeof yaml).toBe("string");
    const doc = parseWorkflowGraph(yaml);
    expect(doc.version).toBe(3);
    expect(doc.graph).toEqual(FULL);
  });

  test("round-trips without a version (null)", () => {
    const doc = parseWorkflowGraph(serializeWorkflowGraph(FULL));
    expect(doc.version).toBeNull();
    expect(doc.graph).toEqual(FULL);
  });

  test("a doc without a name defaults the graph id to the name key", () => {
    const doc = parseWorkflowGraph("nodes: []\nedges: []\n");
    expect(doc.graph.id).toBe("workflow");
    expect(doc.graph.nodes).toEqual([]);
  });

  test("parse names the offending node for an unknown type", () => {
    const src = serializeWorkflowGraph(FULL).replace(
      "type: llm_call",
      "type: wat",
    );
    expect(() => parseWorkflowGraph(src)).toThrow(/node "a": unsupported node type "wat"/);
  });

  test("parse rejects duplicate ids naming the offender", () => {
    const src = `name: dup\nnodes:\n  - {id: a, type: start}\n  - {id: a, type: end}\nedges: []\n`;
    expect(() => parseWorkflowGraph(src)).toThrow(/duplicate id "a"/);
  });

  test("parse rejects a node missing its id naming the slot", () => {
    const src = `name: x\nnodes:\n  - {type: start}\nedges: []\n`;
    expect(() => parseWorkflowGraph(src)).toThrow(/node at index 0 is missing its "id"/);
  });

  test("parse rejects an edge to an unknown node naming the node", () => {
    const src = `name: x\nnodes:\n  - {id: start, type: start}\nedges:\n  - {from: start, to: ghost}\n`;
    expect(() => parseWorkflowGraph(src)).toThrow(/edge "start"→"ghost": unknown node "ghost"/);
  });

  test("parse rejects a node that is not an object", () => {
    const src = `name: x\nnodes:\n  - 42\nedges: []\n`;
    expect(() => parseWorkflowGraph(src)).toThrow(/node at index 0 must be an object/);
  });

  test("parse rejects malformed containers naming the workflow", () => {
    expect(() => parseWorkflowGraph("name: x\nnodes: nope\nedges: []\n")).toThrow(
      /workflow "x": "nodes" must be an array/,
    );
    expect(() => parseWorkflowGraph("name: x\nnodes: []\nedges: nope\n")).toThrow(
      /workflow "x": "edges" must be an array/,
    );
  });

  test("serialize omits undefined fields but keeps falsy-but-real ones", () => {
    const yaml = serializeWorkflowGraph({
      id: "min",
      nodes: [
        node("start", "start"),
        node("a", "llm_call", { model: "gemma", parallel: true, ctx: 0 }),
        node("fleeting", "join", { k: undefined }),
        node("end", "end"),
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "fleeting" },
        { from: "fleeting", to: "end" },
      ],
    });
    expect(yaml).not.toContain("k:");
    expect(yaml).toContain("parallel: true");
    expect(yaml).toContain("ctx: 0");
  });

  test("parse tolerates unknown node fields (forward compatibility)", () => {
    const src = `name: fwd\nnodes:\n  - {id: start, type: start, future_field: 1}\n  - {id: end, type: end}\nedges:\n  - {from: start, to: end, note: kept?}\n`;
    const doc = parseWorkflowGraph(src);
    expect(doc.graph.nodes).toEqual([
      { id: "start", type: "start" },
      { id: "end", type: "end" },
    ]);
    expect(doc.graph.edges).toEqual([{ from: "start", to: "end" }]);
  });
});