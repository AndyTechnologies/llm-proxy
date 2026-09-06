/**
 * Editor geometry helpers (svelte-ui task 3.4, framework-free lib layer).
 *
 * Everything here is **pure**: coordinate conversion (client ↔ graph space),
 * connection hit-testing (nearest input socket within the screen hit radius),
 * loop membership re-bucketing after a drop/drag, loop-body reordering, and
 * the `computeFlowOrder` walk used by the "Ver flujo" animation. No DOM, no
 * stores — `Editor.svelte` composes these with the graph-model port.
 */
import {
  NODE_W,
  NODE_H,
  socketPositions,
  loopContainsPoint,
  type GraphNode,
  type GraphEdge,
  type Point,
} from "./graph-model.js";

/** Zoom limits (0.2×–3×) applied by wheel/gesture zoom. */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;

/** Max distance (graph units) for a port-to-port connection drop. */
export const SOCKET_HIT_RADIUS = 24;

/** Camera state of the editor canvas: zoom and pan offsets. */
export interface EditorView {
  zoom: number;
  panX: number;
  panY: number;
}

/** One step of the flow-order animation. */
export interface FlowStep {
  nodeId: string;
  kind: "node" | "loop" | "member";
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Map a client (viewport) point into graph coordinates. */
export function clientToGraph(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  view: EditorView,
): Point {
  return {
    x: (clientX - rect.left - view.panX) / view.zoom,
    y: (clientY - rect.top - view.panY) / view.zoom,
  };
}

/** Map a graph point into client (viewport) coordinates. */
export function graphToClient(p: Point, rect: DOMRect, view: EditorView): Point {
  return {
    x: p.x * view.zoom + rect.left + view.panX,
    y: p.y * view.zoom + rect.top + view.panY,
  };
}

/**
 * Id of the node whose input socket is nearest to `p` (graph coordinates)
 * within `maxDist` (graph units), or null. Start blocks have no input port
 * and are never targeted. The caller converts the screen hit radius by the
 * zoom: `SOCKET_HIT_RADIUS / view.zoom`.
 */
export function nearestInputSocket(
  nodes: GraphNode[],
  p: Point,
  maxDist: number,
): string | null {
  let best: string | null = null;
  let bestD = maxDist;
  for (const n of nodes) {
    if (n.type === "start" || !n.pos) continue; // sin puerto de entrada
    const sp = socketPositions(n.pos);
    const d = Math.hypot(sp.in.x - p.x, sp.in.y - p.y);
    if (d <= bestD) {
      best = n.id;
      bestD = d;
    }
  }
  return best;
}

/**
 * After dragging/dropping a node: if its center now falls inside a loop
 * container it becomes a member of that loop's body (and leaves every other
 * body); if it falls outside all containers it leaves every loop body. Pure —
 * returns a new nodes array, never mutates the input. Loop and start blocks
 * are never bucketed.
 */
export function bucketDroppedNode(nodes: GraphNode[], id: string): GraphNode[] {
  const node = nodes.find((n) => n.id === id);
  if (!node || node.type === "loop" || node.type === "start") return nodes;
  const cx = (node.pos?.x ?? 0) + NODE_W / 2;
  const cy = (node.pos?.y ?? 0) + NODE_H / 2;
  const host = nodes.find(
    (n) => n.type === "loop" && loopContainsPoint(n, nodes, { x: cx, y: cy }),
  );
  let changed = false;
  const out = nodes.map((n) => {
    if (n.type !== "loop") return n;
    const body = n.body ?? [];
    let next = body;
    if (host && n.id === host.id) {
      if (!body.includes(id)) {
        next = [...body, id];
        changed = true;
      }
    } else if (body.includes(id)) {
      next = body.filter((b) => b !== id);
      changed = true;
    }
    return next === body ? n : { ...n, body: next };
  });
  // Return the input reference for no-ops (callers rely on it to detect
  // unchanged graphs and skip history entries).
  return changed ? out : nodes;
}

/**
 * Swap one loop member one position up (−1) or down (+1) in its body array,
 * ignoring out-of-bounds moves. Returns a new nodes array only when something
 * actually changed (callers rely on the reference to detect no-ops); pure.
 */
export function reorderLoopMember(
  nodes: GraphNode[],
  loopId: string,
  memberId: string,
  dir: -1 | 1,
): GraphNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (n.type !== "loop" || n.id !== loopId || !Array.isArray(n.body)) return n;
    const i = n.body.indexOf(memberId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= n.body.length) return n;
    const body = [...n.body];
    [body[i], body[j]] = [body[j], body[i]];
    changed = true;
    return { ...n, body };
  });
  return changed ? out : nodes;
}

/**
 * Walk the graph the way the engine does, for the "Ver flujo" animation: start
 * at the start block, follow the first available edge; a condition takes its
 * true-branch edge (or falls back to the first); a loop emits a loop step
 * followed by its body members in order and exits through the first edge that
 * leaves the body. Never executes providers — a local preview only. Cycles
 * break via a seen-guard (plus a 100-step safety).
 */
export function computeFlowOrder(nodes: GraphNode[], edges: GraphEdge[]): FlowStep[] {
  const steps: FlowStep[] = [];
  const seen = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nextEdges = (n: GraphNode): GraphEdge[] => {
    const direct = edges.filter((e) => e.from === n.id);
    if (n.type === "condition") {
      const t = direct.find((e) => e.guard === "true");
      return t ? [t] : direct.slice(0, 1);
    }
    return direct.slice(0, 1);
  };
  let cur = nodes.find((n) => n.type === "start") ?? null;
  let guard = 0;
  while (cur && guard++ < 100) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    if (cur.type === "loop") {
      steps.push({ nodeId: cur.id, kind: "loop" });
      for (const m of cur.body ?? []) steps.push({ nodeId: m, kind: "member" });
      const exit = nextEdges(cur).find((e) => !(cur.body ?? []).includes(e.to));
      if (!exit) break;
      cur = byId.get(exit.to) ?? null;
      continue;
    }
    steps.push({ nodeId: cur.id, kind: "node" });
    if (cur.type === "end") break;
    const next = nextEdges(cur)[0];
    if (!next) break;
    cur = byId.get(next.to) ?? null;
  }
  return steps;
}