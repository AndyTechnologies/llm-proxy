/**
 * Unit tests for the UI graph model pure helpers (Slice D — task 4.2).
 *
 * The editor split keeps logic in pure, importable modules (graph-model.js)
 * so the SVG/DOM layer (app.js) stays thin and the graph-building, layout,
 * and condition-AST logic is unit-testable with `bun test` — no browser DOM
 * required. This is the same "pure functions + injected deps" convention the
 * rest of the repo follows.
 *
 * These tests reference production code (src/ui/graph-model.js) that does not
 * exist yet → RED.
 */
import { describe, it, expect } from "bun:test";
import {
  createNode,
  nodeTypes,
  conditionOps,
  layoutGraph,
  buildPayload,
  buildCondition,
  requiredField,
  isCompleteNode,
} from "./graph-model.js";

describe("graph-model: createNode defaults", () => {
  it("creates a start node with no extra fields", () => {
    const n = createNode("start", "n1");
    expect(n).toEqual({ id: "n1", type: "start" });
  });

  it("creates an llm_call node that needs a model", () => {
    const n = createNode("llm_call", "n2");
    expect(n.type).toBe("llm_call");
    expect(requiredField(n)).toBe("model");
  });

  it("creates a condition node that needs a condition", () => {
    const n = createNode("condition", "n3");
    expect(requiredField(n)).toBe("condition");
  });

  it("nodeTypes exposes the six editable types", () => {
    expect(nodeTypes).toEqual([
      "start",
      "llm_call",
      "condition",
      "loop",
      "pipeline",
      "end",
    ]);
  });
});

describe("graph-model: layoutGraph", () => {
  it("layers start first, end last for a simple chain", () => {
    const nodes = [
      { id: "a", type: "start" },
      { id: "b", type: "llm_call" },
      { id: "c", type: "end" },
    ];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    const pos = layoutGraph(nodes, edges);
    expect(pos.get("a").x).toBeLessThan(pos.get("b").x);
    expect(pos.get("b").x).toBeLessThan(pos.get("c").x);
  });

  it("exists for every node id", () => {
    const nodes = [
      { id: "a", type: "start" },
      { id: "b", type: "end" },
    ];
    const pos = layoutGraph(nodes, []);
    expect(pos.has("a")).toBe(true);
    expect(pos.has("b")).toBe(true);
  });
});

describe("graph-model: buildPayload", () => {
  it("serializes nodes and edges, omitting guard when absent", () => {
    const payload = buildPayload({
      nodes: [
        { id: "a", type: "start" },
        { id: "b", type: "llm_call", model: "m" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(payload.nodes).toHaveLength(2);
    expect(payload.edges).toEqual([{ from: "a", to: "b" }]);
  });
});

describe("graph-model: buildCondition (condition AST builder / no free-form code)", () => {
  it("builds a compare expression from field/op/value", () => {
    const ast = buildCondition({
      op: "compare",
      field: "lastResponse.status",
      op2: "==",
      value: 200,
    });
    expect(ast).toEqual({
      op: "compare",
      field: "lastResponse.status",
      op2: "==",
      value: 200,
    });
  });

  it("builds a logical AND over child expressions", () => {
    const ast = buildCondition({
      op: "logical",
      and: true,
      args: [
        { op: "exists", field: "error" },
        { op: "compare", field: "lastResponse.status", op2: "==", value: 500 },
      ],
    });
    expect(ast.op).toBe("logical");
    expect(ast.and).toBe(true);
    expect(ast.args).toHaveLength(2);
  });

  it("does not allow a code/free-form operator", () => {
    expect(conditionOps).not.toContain("eval");
    expect(conditionOps).not.toContain("function");
    expect(nodeTypes).not.toContain("eval");
    expect(buildCondition.length).toBeGreaterThan(0);
  });
});

describe("graph-model: isCompleteNode", () => {
  it("start and end are complete with no required fields", () => {
    expect(isCompleteNode({ id: "a", type: "start" })).toBe(true);
    expect(isCompleteNode({ id: "b", type: "end" })).toBe(true);
  });

  it("an llm_call without a model is incomplete", () => {
    expect(isCompleteNode({ id: "a", type: "llm_call" })).toBe(false);
    expect(isCompleteNode({ id: "a", type: "llm_call", model: "m" })).toBe(true);
  });

  it("a condition without a condition expression is incomplete", () => {
    expect(isCompleteNode({ id: "a", type: "condition" })).toBe(false);
    expect(
      isCompleteNode({
        id: "a",
        type: "condition",
        condition: { op: "exists", field: "error" },
      }),
    ).toBe(true);
  });
});
