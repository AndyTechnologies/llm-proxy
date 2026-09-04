/**
 * Pure graph-model helpers for the dashboard editor (Slice D — task 4.2).
 *
 * These functions are intentionally side-effect free and importable so the
 * SVG/DOM layer (app.js) stays thin and the graph-building, layout, and
 * condition-AST logic is unit-testable with `bun test` (no browser DOM).
 *
 * The editor composes exactly the node types the graph engine understands
 * (start/end/llm_call/condition/loop/pipeline). The condition AST builder is
 * a closed set — only compare/logical/not/exists over the dashboard context
 * fields — so there is never a free-form code entry point (dashboard-ui Req
 * "Condition AST builder").
 */

/** The editable node types (the graph engine's types minus join/fan). */
export const nodeTypes = [
  "start",
  "llm_call",
  "condition",
  "loop",
  "pipeline",
  "end",
];

/** Valid context fields selectable in the condition AST builder. */
export const ctxFields = [
  "lastResponse.status",
  "lastResponse.content",
  "error",
];

/** Valid comparison operators for a `compare` expression. */
export const compareOps = ["==", "!=", "<", "<=", ">", ">="];

/** Valid condition operators (compare/logical/not/exists only). */
export const conditionOps = ["compare", "logical", "not", "exists"];

/**
 * Create a new node with type-appropriate default fields. The editor keeps
 * transient draft values (selected model, condition form) off the committed
 * node until the node is considered complete. Returns a plain object with the
 * committed `id`/`type` plus any type default. No `pos` is assigned here —
 * `layoutGraph` fills in initial positions for nodes without one at render
 * time (pure layout, never persisted to the graph payload).
 */
export function createNode(type, id) {
  const node = { id, type };
  return node;
}

/** Node body width in SVG units (used by layout, ports, and hit-testing). */
export const NODE_W = 160;
/** Node body height in SVG units. */
export const NODE_H = 56;

/**
 * Center-points of the output (right) and input (left) sockets for a node at
 * the given top-left position. The editor renders socket hit-areas here so
 * connections can be dragged socket→socket (Blender/Godot style).
 */
export function socketPositions(p) {
  return {
    out: { x: p.x + NODE_W, y: p.y + NODE_H / 2 },
    in: { x: p.x, y: p.y + NODE_H / 2 },
  };
}

/**
 * Cubic bezier path between two socket points, bowing horizontally so edges
 * read as free-form curves (node-editor style) rather than stacked verticals.
 */
export function bezierEdge(x1, y1, x2, y2, bow = NODE_W * 0.55) {
  const dx1 = Math.max(bow, (x2 - x1) * 0.5);
  const dx2 = Math.max(bow, (x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx1} ${y1}, ${x2 - dx2} ${y2}, ${x2} ${y2}`;
}

/**
 * Move a node (by id) to an absolute `x`/`y` top-left position, returning a
 * new nodes array (pure). Leaves the node's `pos` set so `layoutGraph` no
 * longer relocates it.
 */
export function moveNode(nodes, id, x, y) {
  return nodes.map((n) => (n.id === id ? { ...n, pos: { x, y } } : n));
}

/**
 * Add or replace an edge from `from` to `to` (with optional guard), returning
 * a new edges array (pure). Any existing outgoing edge from `from` is kept
 * unless it targets the same `to`; a self-edge is rejected.
 */
export function connectNodes(edges, from, to, guard) {
  if (from === to) return edges;
  const next = edges.filter((e) => !(e.from === from && e.to === to));
  next.push(guard ? { from, to, guard } : { from, to });
  return next;
}

/**
 * Remove a node (by id) together with every edge touching it, returning
 * `{ nodes, edges }` (pure). The caller uses this for both the delete button
 * and the Delete/Backspace shortcut.
 */
export function deleteNode(nodes, edges, id) {
  return {
    nodes: nodes.filter((n) => n.id !== id),
    edges: edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/**
 * Which required field is still missing for a complete node, or `null` when
 * the node is complete as-is.
 */
export function requiredField(node) {
  switch (node.type) {
    case "llm_call":
      return node.model ? null : "model";
    case "condition":
      return node.condition ? null : "condition";
    case "loop":
      return node.body && node.body.length > 0 ? null : "body";
    case "pipeline":
      return node.pipeline ? null : "pipeline";
    case "start":
    case "end":
    default:
      return null;
  }
}

/** Whether a node has all its required fields set. */
export function isCompleteNode(node) {
  return requiredField(node) === null;
}

/**
 * A simple layered layout for the SVG canvas: place nodes left-to-right by
 * topological layer, stacking several nodes at the same layer vertically.
 * Returns a Map<id, {x,y}> of pixel positions.
 *
 * Nodes that already carry a `pos` (moved by the user) are respected and never
 * relocated — the layout only fills in positions for nodes without one, so a
 * freshly added node or a just-loaded pipeline gets readable coordinates the
 * first time, after which the user's drags are the source of truth. This is
 * intentionally naive (no D3/xyflow) — it only needs to be readable for the
 * small graphs the editor targets (dashboard-ui Req "Vanilla frontend": native
 * SVG, no graph library).
 */
export function layoutGraph(nodes, edges) {
  const pos = new Map();
  // Any node with a fixed position is taken verbatim.
  for (const n of nodes) {
    if (n.pos) pos.set(n.id, { x: n.pos.x, y: n.pos.y });
  }

  // Only nodes without a position participate in the layered pass.
  const targets = nodes.filter((n) => !n.pos);
  if (targets.length === 0) return pos;

  const COL = NODE_W + 72;
  const ROW = NODE_H + 34;
  const margin = 40;
  const incoming = new Map(targets.map((n) => [n.id, []]));
  for (const e of edges) {
    if (incoming.has(e.to)) incoming.get(e.to).push(e.from);
  }

  // Assign layers: start layer 0; a node's layer = max(parent)+1; sinks
  // without parents default to layer 0. Fall back to 0 for anything unvisited.
  const layer = new Map();
  const visited = new Set();
  function assign(id, depth) {
    if (visited.has(id)) return;
    visited.add(id);
    layer.set(id, depth);
    for (const e of edges) {
      if (e.from === id) assign(e.to, depth + 1);
    }
  }
  for (const n of targets) {
    if (n.type === "start") assign(n.id, 0);
  }
  // Assign any remaining unvisited nodes (disconnected/end-only graphs).
  for (const n of targets) {
    if (!visited.has(n.id)) assign(n.id, 0);
  }

  // Group unfixed ids by layer and stack vertically.
  const byLayer = new Map();
  for (const n of targets) {
    const l = layer.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n.id);
  }

  for (const [l, ids] of byLayer) {
    const x = margin + l * COL;
    const n = ids.length;
    const baseY = margin + (n - 1) * (ROW / 2);
    ids.forEach((id, i) => {
      pos.set(id, { x, y: baseY + i * ROW });
    });
  }
  return pos;
}

/**
 * Serialize the editor's internal node/edge state into the validate/apply
 * payload (`{nodes, edges}`). Layout `pos` is preserved through the round-trip
 * (config-load Req "pos is preserved"), so the persisted graph keeps the
 * editor's layout positions.
 */
export function buildPayload(state) {
  const strip = (n) => {
    // Copy the node as-is — `pos` stays, matching the schema field, so the
    // layout survives config round-trips (apply does not lose positions).
    return { ...n };
  };
  return {
    nodes: state.nodes.map(strip),
    edges: state.edges.map((e) => ({ ...e })),
  };
}

/**
 * Build a condition AST from the AST-builder form fields. The allowed shapes
 * mirror the graph engine's `AstExpr` discriminated union:
 *   compare: {op:"compare", field, op2, value}
 *   exists:  {op:"exists", field}
 *   not:     {op:"not", child}
 *   logical: {op:"logical", and, args:[...]}
 * No other ops/code entry are possible — the builder only emits these.
 */
export function buildCondition(form) {
  switch (form.op) {
    case "exists":
      return { op: "exists", field: form.field };
    case "compare":
      return {
        op: "compare",
        field: form.field,
        op2: form.op2,
        value: form.value,
      };
    case "not":
      // Build a single child via recursion.
      return {
        op: "not",
        child: fieldChild(form.child) ?? buildCondition(form.childForm ?? { op: "exists", field: "error" }),
      };
    case "logical": {
      const args = (form.args ?? []).map((a) => buildCondition(a));
      if (args.length === 0) {
        args.push({ op: "exists", field: "error" });
      }
      return { op: "logical", and: form.and !== false, args };
    }
    default:
      return { op: "exists", field: form.field ?? "error" };
  }
}

/** Build a single leaf condition expression from a minimal form. */
function fieldChild(form) {
  if (!form) return null;
  return buildCondition({ op: form.op, field: form.field, op2: form.op2, value: form.value });
}
