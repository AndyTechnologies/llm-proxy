/**
 * RED→GREEN tests for the editor geometry helpers (svelte-ui task 3.4).
 *
 * All functions live in the framework-free `lib/` layer: they convert between
 * client and graph coordinates, resolve the nearest input socket for
 * port-to-port connections, re-bucket dropped nodes into loop bodies, reorder
 * loop members, and compute the animated flow order — all pure, with no DOM
 * or store access. `Editor.svelte` consumes these; graph-model.ts supplies
 * the socket/loop geometry primitives.
 */
import { describe, it, expect } from "bun:test";
import type { GraphNode, GraphEdge, Point } from "./graph-model.js";
import {
  MIN_ZOOM,
  MAX_ZOOM,
  SOCKET_HIT_RADIUS,
  clampZoom,
  clientToGraph,
  graphToClient,
  nearestInputSocket,
  bucketDroppedNode,
  reorderLoopMember,
  computeFlowOrder,
  type EditorView,
  type FlowStep,
} from "./editor-geometry.js";

function node(id: string, type: GraphNode["type"], pos?: Point): GraphNode {
  return pos ? { id, type, pos } : { id, type };
}

/** Bounding rect used by the coordinate conversion tests (client space). */
const RECT = { left: 40, top: 20, width: 800, height: 600 } as DOMRect;

const VIEW: EditorView = { zoom: 1.4, panX: 120, panY: 80 };

describe("clampZoom (0.2x–3x)", () => {
  it("clamps below the minimum to MIN_ZOOM", () => {
    expect(clampZoom(0.05)).toBe(MIN_ZOOM);
    expect(clampZoom(0.199)).toBe(MIN_ZOOM);
  });

  it("clamps above the maximum to MAX_ZOOM", () => {
    expect(clampZoom(4)).toBe(MAX_ZOOM);
    expect(clampZoom(3.001)).toBe(MAX_ZOOM);
  });

  it("keeps in-range values unchanged (boundaries inclusive)", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(clampZoom(MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM);
  });
});

describe("clientToGraph / graphToClient", () => {
  it("round-trips: graphToClient(clientToGraph(p)) returns p", () => {
    const p: Point = { x: 210, y: 97 };
    const back = graphToClient(clientToGraph(p.x, p.y, RECT, VIEW), RECT, VIEW);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it("maps a client point into graph space (minus rect origin and pan, divided by zoom)", () => {
    // client (120, 100) − rect (40, 20) − pan (120, 80) = (−40, 0); / 1.4
    expect(clientToGraph(120, 100, RECT, VIEW)).toEqual({ x: -40 / 1.4, y: 0 });
  });

  it("maps a graph point into client space (times zoom, plus rect origin and pan)", () => {
    // graph (50, 30) × 1.4 = (70, 42); + rect (40, 20) + pan (120, 80)
    expect(graphToClient({ x: 50, y: 30 }, RECT, VIEW)).toEqual({ x: 230, y: 142 });
  });

  it("handles zoom 1 and zero pan as the identity offset by the rect origin", () => {
    const identity: EditorView = { zoom: 1, panX: 0, panY: 0 };
    expect(clientToGraph(340, 220, RECT, identity)).toEqual({ x: 300, y: 200 });
    expect(graphToClient({ x: 300, y: 200 }, RECT, identity)).toEqual({ x: 340, y: 220 });
  });
});

describe("nearestInputSocket (24px screen hit radius)", () => {
  it("returns the node whose input socket is closest to the point, within maxDist", () => {
    // a at (100,100): input socket {100, 128}; b at (300,100): input {300, 128}
    const nodes = [node("a", "llm_call", { x: 100, y: 100 }), node("b", "llm_call", { x: 300, y: 100 })];
    expect(nearestInputSocket(nodes, { x: 96, y: 128 }, SOCKET_HIT_RADIUS)).toBe("a");
    expect(nearestInputSocket(nodes, { x: 304, y: 128 }, SOCKET_HIT_RADIUS)).toBe("b");
  });

  it("returns null when no input socket is within maxDist", () => {
    const nodes = [node("a", "llm_call", { x: 100, y: 100 })];
    // input socket {100, 128}; probe 30px away on the x axis
    expect(nearestInputSocket(nodes, { x: 131, y: 128 }, SOCKET_HIT_RADIUS)).toBeNull();
    expect(nearestInputSocket(nodes, { x: 100, y: 300 }, SOCKET_HIT_RADIUS)).toBeNull();
  });

  it("never targets start nodes (no input port)", () => {
    // probe sits within the hit radius of BOTH the start block's (excluded)
    // socket position and b's — only b can win.
    const nodes = [node("start", "start", { x: 100, y: 100 }), node("b", "llm_call", { x: 110, y: 100 })];
    expect(nearestInputSocket(nodes, { x: 104, y: 128 }, SOCKET_HIT_RADIUS)).toBe("b");
  });

  it("picks the nearest socket among several candidates", () => {
    const nodes = [
      node("a", "llm_call", { x: 100, y: 100 }),
      node("c", "condition", { x: 200, y: 100 }),
      node("b", "llm_call", { x: 300, y: 100 }),
    ];
    // probe closer to b (304 vs 204 vs 404) — prefers b even though c exists
    expect(nearestInputSocket(nodes, { x: 300, y: 128 }, SOCKET_HIT_RADIUS)).toBe("b");
  });
});

describe("bucketDroppedNode (loop membership by position)", () => {
  // loop at (0,0) with one member at (0, 70) → body rect spans the header
  // and stack; a node dropped at (40, 200) lands inside the container.
  const loopAt = (body: string[] = []): GraphNode =>
    node("loop", "loop", { x: 0, y: 0 }) as GraphNode & { body?: string[] };

  it("adds a node whose center falls inside a loop container to its body", () => {
    const loop = { ...loopAt(), body: [] as string[] };
    const inner = node("inner", "llm_call", { x: 40, y: 80 });
    const next = bucketDroppedNode([loop, inner], "inner");
    expect(next.find((n) => n.id === "loop")?.body).toContain("inner");
  });

  it("keeps a node out of every loop body when its center lands outside all containers", () => {
    const loop = { ...loopAt(), body: [] as string[] };
    // dropped far from the container — center never intersects any loop rect
    const inner = node("inner", "llm_call", { x: 600, y: 600 });
    const next = bucketDroppedNode([loop, inner], "inner");
    expect(next.find((n) => n.id === "loop")?.body).toEqual([]);
  });

  it("enforces the single-body invariant when loop containers overlap", () => {
    // Two overlapping containers both list the node; the first in node order
    // owns it and the other sheds it (position alone cannot re-home a node
    // out of its own container — its rect always wraps its members).
    const loopA = { ...node("a", "loop", { x: 0, y: 0 }), body: ["inner"] as string[] };
    const loopB = { ...node("b", "loop", { x: 0, y: 0 }), body: ["inner"] as string[] };
    const inner = node("inner", "llm_call", { x: 0, y: 70 });
    const next = bucketDroppedNode([loopA, loopB, inner], "inner");
    expect(next.find((n) => n.id === "a")?.body).toContain("inner");
    expect(next.find((n) => n.id === "b")?.body).toEqual([]);
  });

  it("never buckets loop or start nodes", () => {
    const loopA = { ...node("a", "loop", { x: 0, y: 0 }), body: [] as string[] };
    const loopB = { ...node("b", "loop", { x: 100, y: 0 }), body: [] as string[] };
    const start = node("s", "start", { x: 150, y: 60 });
    const next = bucketDroppedNode([loopA, loopB, start], "b");
    expect(next.find((n) => n.id === "a")?.body).toEqual([]);
    expect(next.find((n) => n.id === "b")?.body).toEqual([]);
  });

  it("is pure: returns a new array and never mutates the input", () => {
    const loop = { ...loopAt(), body: [] as string[] };
    const inner = node("inner", "llm_call", { x: 40, y: 80 });
    const copy = [loop, inner];
    const next = bucketDroppedNode(copy, "inner");
    expect(next).not.toBe(copy);
    expect(loop.body).toEqual([]);
  });
});

describe("reorderLoopMember (inspector/loop body up-down)", () => {
  const body = ["m1", "m2", "m3"];

  it("moves a member one position up", () => {
    const loop = { ...node("loop", "loop", { x: 0, y: 0 }), body: [...body] };
    const next = reorderLoopMember([loop], "loop", "m2", -1);
    expect(next[0]?.body).toEqual(["m2", "m1", "m3"]);
  });

  it("moves a member one position down", () => {
    const loop = { ...node("loop", "loop", { x: 0, y: 0 }), body: [...body] };
    const next = reorderLoopMember([loop], "loop", "m2", 1);
    expect(next[0]?.body).toEqual(["m1", "m3", "m2"]);
  });

  it("is a no-op at array boundaries", () => {
    const loop = { ...node("loop", "loop", { x: 0, y: 0 }), body: [...body] };
    expect(reorderLoopMember([loop], "loop", "m1", -1)[0]?.body).toEqual(body);
    expect(reorderLoopMember([loop], "loop", "m3", 1)[0]?.body).toEqual(body);
  });

  it("leaves the graph untouched for unknown loop or member ids", () => {
    const loop = { ...node("loop", "loop", { x: 0, y: 0 }), body: [...body] };
    expect(reorderLoopMember([loop], "ghost", "m1", -1)[0]?.body).toEqual(body);
    expect(reorderLoopMember([loop], "loop", "ghost", -1)[0]?.body).toEqual(body);
  });
});

describe("computeFlowOrder (Ver flujo animation)", () => {
  const chain = (ids: string[], extra?: Partial<GraphNode>): GraphNode[] =>
    ids.map((id, i) => {
      const base = node(id, (["start", "llm_call", "condition", "loop", "pipeline", "end"] as const)[i % 6]);
      return { ...base, ...extra };
    });

  it("walks a linear start→a→b→end chain with kind 'node'", () => {
    const nodes = [node("start", "start"), node("a", "llm_call"), node("b", "llm_call"), node("end", "end")];
    const edges: GraphEdge[] = [
      { from: "start", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "end" },
    ];
    expect(computeFlowOrder(nodes, edges)).toEqual([
      { nodeId: "start", kind: "node" },
      { nodeId: "a", kind: "node" },
      { nodeId: "b", kind: "node" },
      { nodeId: "end", kind: "node" },
    ]);
  });

  it("a condition follows its true-branch edge", () => {
    const nodes = [node("start", "start"), node("c", "condition"), node("yes", "llm_call"), node("no", "llm_call"), node("end", "end")];
    const edges: GraphEdge[] = [
      { from: "start", to: "c" },
      { from: "c", to: "yes", guard: "true" },
      { from: "c", to: "no", guard: "false" },
      { from: "yes", to: "end" },
    ];
    const order = computeFlowOrder(nodes, edges);
    expect(order.map((s) => s.nodeId)).toEqual(["start", "c", "yes", "end"]);
  });

  it("a condition without a true edge falls back to its first edge", () => {
    const nodes = [node("start", "start"), node("c", "condition"), node("a", "llm_call"), node("end", "end")];
    const edges: GraphEdge[] = [
      { from: "start", to: "c" },
      { from: "c", to: "a", guard: "false" },
      { from: "a", to: "end" },
    ];
    const order = computeFlowOrder(nodes, edges);
    expect(order.map((s) => s.nodeId)).toEqual(["start", "c", "a", "end"]);
  });

  it("a loop emits the loop step, then its body members, then exits", () => {
    const loop = { ...node("loop", "loop"), body: ["m1", "m2"] };
    const nodes = [node("start", "start"), loop, node("m1", "llm_call"), node("m2", "llm_call"), node("end", "end")];
    const edges: GraphEdge[] = [
      { from: "start", to: "loop" },
      { from: "loop", to: "end" },
    ];
    expect(computeFlowOrder(nodes, edges)).toEqual([
      { nodeId: "start", kind: "node" },
      { nodeId: "loop", kind: "loop" },
      { nodeId: "m1", kind: "member" },
      { nodeId: "m2", kind: "member" },
      { nodeId: "end", kind: "node" },
    ]);
  });

  it("a loop with no exit edge stops after its members", () => {
    const loop = { ...node("loop", "loop"), body: ["m1"] };
    const nodes = [node("start", "start"), loop, node("m1", "llm_call")];
    const edges: GraphEdge[] = [{ from: "start", to: "loop" }];
    expect(computeFlowOrder(nodes, edges)).toEqual([
      { nodeId: "start", kind: "node" },
      { nodeId: "loop", kind: "loop" },
      { nodeId: "m1", kind: "member" },
    ]);
  });

  it("stops at an end node (does not follow further edges)", () => {
    const nodes = [node("start", "start"), node("end", "end"), node("tail", "llm_call")];
    const edges: GraphEdge[] = [
      { from: "start", to: "end" },
      { from: "end", to: "tail" },
    ];
    expect(computeFlowOrder(nodes, edges)).toEqual([
      { nodeId: "start", kind: "node" },
      { nodeId: "end", kind: "node" },
    ]);
  });

  it("breaks cycles via the seen guard instead of looping forever", () => {
    const nodes = [node("start", "start"), node("a", "llm_call")];
    const edges: GraphEdge[] = [
      { from: "start", to: "a" },
      { from: "a", to: "start" },
    ];
    const order = computeFlowOrder(nodes, edges);
    expect(order.length).toBeLessThanOrEqual(3);
    expect(order[0]?.nodeId).toBe("start");
  });

  it("returns an empty list when there is no start node", () => {
    const nodes = [node("a", "llm_call"), node("end", "end")];
    const edges: GraphEdge[] = [{ from: "a", to: "end" }];
    expect(computeFlowOrder(nodes, edges)).toEqual([]);
  });
});