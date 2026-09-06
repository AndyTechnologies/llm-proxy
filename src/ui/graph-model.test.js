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
  moveNode,
  deleteNode,
  connectNodes,
  NODE_W,
  NODE_H,
  socketPositions,
  conditionSockets,
  outSocketFor,
  loopBodyRect,
  loopContainsPoint,
  bezierEdge,
  stackLoopMembers,
  ownerLoopId,
  stripLoopInternalEdges,
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

  it("respects a node position fixed by the user (drag) and only lays out the rest", () => {
    const nodes = [
      { id: "a", type: "start", pos: { x: 999, y: 123 } },
      { id: "b", type: "end" },
    ];
    const pos = layoutGraph(nodes, [{ from: "a", to: "b" }]);
    expect(pos.get("a")).toEqual({ x: 999, y: 123 });
    // The end node (no pos) still gets laid out.
    expect(pos.has("b")).toBe(true);
  });

  it("returns existing positions verbatim when every node has one", () => {
    const nodes = [
      { id: "a", type: "start", pos: { x: 1, y: 2 } },
      { id: "b", type: "end", pos: { x: 3, y: 4 } },
    ];
    const pos = layoutGraph(nodes, []);
    expect(pos.get("a")).toEqual({ x: 1, y: 2 });
    expect(pos.get("b")).toEqual({ x: 3, y: 4 });
  });
});

describe("graph-model: node manipulation helpers", () => {
  it("moveNode returns an updated array with pos set", () => {
    const next = moveNode([{ id: "a", type: "start" }], "a", 50, 60);
    expect(next[0].pos).toEqual({ x: 50, y: 60 });
    expect(next[0].type).toBe("start");
  });

  it("deleteNode removes the node and any touching edges", () => {
    const nodes = [{ id: "a", type: "start" }, { id: "b", type: "end" }];
    const edges = [{ from: "a", to: "b" }];
    const { nodes: nn, edges: en } = deleteNode(nodes, edges, "a");
    expect(nn).toHaveLength(1);
    expect(en).toHaveLength(0);
  });

  it("deleteNode also removes a deleted id from every loop body", () => {
    const nodes = [
      { id: "loop", type: "loop", body: ["a", "b"] },
      { id: "a", type: "llm_call", model: "m" },
      { id: "b", type: "llm_call", model: "m" },
    ];
    const { nodes: nn } = deleteNode(nodes, [], "a");
    expect(nn.find((n) => n.id === "loop").body).toEqual(["b"]);
  });

  it("connectNodes adds an edge", () => {
    const next = connectNodes([], "a", "b");
    expect(next).toEqual([{ from: "a", to: "b" }]);
  });

  it("connectNodes adds a guarded edge", () => {
    const next = connectNodes([], "cond", "yes", "true");
    expect(next).toEqual([{ from: "cond", to: "yes", guard: "true" }]);
  });

  it("connectNodes replaces an existing from→to edge and rejects self-edges", () => {
    const edges = [{ from: "a", to: "b", guard: "true" }];
    expect(connectNodes(edges, "a", "b")).toEqual([{ from: "a", to: "b" }]);
    expect(connectNodes([], "a", "a")).toHaveLength(0);
  });
});

describe("graph-model: sockets and bezier edges", () => {
  it("socketPositions places out (right) and in (left) on the body midline", () => {
    const p = socketPositions({ x: 100, y: 200 });
    expect(p.out).toEqual({ x: 100 + NODE_W, y: 200 + NODE_H / 2 });
    expect(p.in).toEqual({ x: 100, y: 200 + NODE_H / 2 });
  });

  it("conditionSockets stacks outTrue above outFalse on the right", () => {
    const p = { x: 100, y: 200 };
    const cs = conditionSockets(p);
    expect(cs.in).toEqual({ x: 100, y: 200 + NODE_H / 2 });
    expect(cs.outTrue.x).toBe(100 + NODE_W);
    expect(cs.outFalse.x).toBe(100 + NODE_W);
    expect(cs.outTrue.y).toBeLessThan(cs.outFalse.y);
    expect(cs.outTrue.y).toBeGreaterThan(200);
  });

  it("outSocketFor picks the branch socket by guard for condition nodes", () => {
    const p = { x: 100, y: 200 };
    const cond = { id: "c", type: "condition" };
    const cs = conditionSockets(p);
    expect(outSocketFor(cond, p, "true")).toEqual(cs.outTrue);
    expect(outSocketFor(cond, p, "false")).toEqual(cs.outFalse);
    // Sin guard (arista legada) cae en la rama true (arriba).
    expect(outSocketFor(cond, p, null)).toEqual(cs.outTrue);
    // Nodos normales: un solo socket al medio.
    expect(outSocketFor({ id: "a", type: "llm_call" }, p, null)).toEqual(socketPositions(p).out);
  });

  it("bezierEdge produces a cubic path between two points", () => {
    const d = bezierEdge(0, 10, 300, 40);
    expect(d.startsWith("M 0 10 C ")).toBe(true);
    expect(d.endsWith(", 300 40")).toBe(true);
  });
});

describe("graph-model: loop container", () => {
  const loopAt = (p, body = []) => ({ id: "l", type: "loop", body, pos: p });

  it("loopBodyRect wraps the header alone when the body is empty", () => {
    const rect = loopBodyRect(loopAt({ x: 100, y: 200 }), []);
    expect(rect.x).toBeLessThan(100);
    expect(rect.y).toBeLessThan(200);
    expect(rect.width).toBeGreaterThan(NODE_W);
    expect(rect.height).toBeGreaterThan(NODE_H);
  });

  it("loopBodyRect grows when a body member is positioned below the header", () => {
    const loop = loopAt({ x: 100, y: 200 }, ["m1"]);
    const member = { id: "m1", type: "llm_call", pos: { x: 120, y: 320 } };
    const rect = loopBodyRect(loop, [member]);
    // El contenedor alcanza el fondo del miembro (que esta mas abajo).
    expect(rect.y + rect.height).toBeGreaterThan(320 + NODE_H);
    expect(rect.x).toBeLessThanOrEqual(120);
  });

  it("loopContainsPoint is true inside the container, false outside", () => {
    const loop = loopAt({ x: 100, y: 200 }, []);
    const nearCenter = { x: 100 + 10, y: 200 + 40 };
    const far = { x: 900, y: 900 };
    expect(loopContainsPoint(loop, [], nearCenter)).toBe(true);
    expect(loopContainsPoint(loop, [], far)).toBe(false);
  });

  it("loopContainsPoint excludes the header strip (own position doesn't self-bucket)", () => {
    const loop = loopAt({ x: 100, y: 200 });
    const insideHeader = { x: 100 + 20, y: 200 - 5 };
    expect(loopContainsPoint(loop, [loop], insideHeader)).toBe(false);
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

  it("preserves node layout positions through round-trip (pos kept)", () => {
    const payload = buildPayload({
      nodes: [
        { id: "a", type: "start", pos: { x: 1, y: 2 } },
        { id: "b", type: "llm_call", model: "m", pos: { x: 30, y: 40 } },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(payload.nodes[0].pos).toEqual({ x: 1, y: 2 });
    expect(payload.nodes[1].pos).toEqual({ x: 30, y: 40 });
    // Other committed fields are still preserved.
    expect(payload.nodes[1].model).toBe("m");
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

describe("graph-model: stackLoopMembers (auto-chained loop body)", () => {
  it("stacks members vertically under the loop header, ignoring their pos", () => {
    const nodes = [
      { id: "loop", type: "loop", body: ["a", "b"], pos: { x: 100, y: 200 } },
      { id: "a", type: "llm_call", model: "m", pos: { x: 1, y: 1 } },
      { id: "b", type: "llm_call", model: "m", pos: { x: 2, y: 2 } },
    ];
    const out = stackLoopMembers(nodes);
    const a = out.find((n) => n.id === "a");
    const b = out.find((n) => n.id === "b");
    expect(a.pos).toEqual({ x: 100, y: 200 + NODE_H + 14 });
    expect(b.pos).toEqual({ x: 100, y: 200 + NODE_H + 14 + NODE_H + 14 });
  });

  it("returns the same array reference when nothing changes", () => {
    const nodes = [
      { id: "loop", type: "loop", body: ["a"], pos: { x: 10, y: 10 } },
      { id: "a", type: "llm_call", model: "m", pos: { x: 10, y: 10 + NODE_H + 14 } },
    ];
    expect(stackLoopMembers(nodes)).toBe(nodes);
  });

  it("leaves a loop without header pos untouched (layoutGraph places it)", () => {
    const nodes = [
      { id: "loop", type: "loop", body: ["a"] },
      { id: "a", type: "llm_call", model: "m", pos: { x: 5, y: 5 } },
    ];
    const out = stackLoopMembers(nodes);
    expect(out).toBe(nodes);
  });
});

describe("graph-model: ownerLoopId + stripLoopInternalEdges", () => {
  it("finds the owner loop of a body member", () => {
    const nodes = [
      { id: "loop", type: "loop", body: ["a"] },
      { id: "a", type: "llm_call" },
      { id: "b", type: "llm_call" },
    ];
    expect(ownerLoopId(nodes, "a")).toBe("loop");
    expect(ownerLoopId(nodes, "b")).toBeNull();
  });

  it("drops edges touching loop body members but keeps external edges", () => {
    const nodes = [
      { id: "start", type: "start" },
      { id: "loop", type: "loop", body: ["a"] },
      { id: "a", type: "llm_call" },
      { id: "end", type: "end" },
    ];
    const edges = [
      { from: "start", to: "loop" },
      { from: "loop", to: "a" }, // obsolete internal entry
      { from: "a", to: "loop" }, // obsolete internal back-edge
      { from: "loop", to: "end" },
    ];
    const kept = stripLoopInternalEdges(edges, nodes);
    expect(kept).toEqual([
      { from: "start", to: "loop" },
      { from: "loop", to: "end" },
    ]);
  });
});
