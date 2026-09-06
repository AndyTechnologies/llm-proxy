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
 * Socket center-points for a condition block: the input on the left, and two
 * outputs stacked on the right — `outTrue` above, `outFalse` below — so the
 * branch meaning is conveyed by position (and the renderer colors them), not
 * by a manual guard selector.
 */
export function conditionSockets(p) {
  const branchDy = 16;
  return {
    in: { x: p.x, y: p.y + NODE_H / 2 },
    outTrue: { x: p.x + NODE_W, y: p.y + NODE_H / 2 - branchDy },
    outFalse: { x: p.x + NODE_W, y: p.y + NODE_H / 2 + branchDy },
  };
}

/**
 * The output socket a drawn edge should leave from, given the node and its
 * guard (or null). Condition blocks branch by guard; every other type has a
 * single output on the midline.
 */
export function outSocketFor(node, p, guard) {
  if (node.type === "condition") {
    const cs = conditionSockets(p);
    return guard === "false" ? cs.outFalse : cs.outTrue;
  }
  return socketPositions(p).out;
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
    nodes: nodes
      .filter((n) => n.id !== id)
      .map((n) =>
        n.body ? { ...n, body: n.body.filter((b) => b !== id) } : n,
      ),
    edges: edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/**
 * Bounding box of a loop's container in SVG units: wraps the loop header
 * itself plus every body member that has a position, with padding and room
 * for the container label above. Returns `null` when nothing is positioned.
 * The loop renders as a container block, so the body is visually grouped and
 * the container grows downward as members are added.
 */
export function loopBodyRect(loopNode, nodes) {
  const pad = 18;
  const headerPad = 30;
  const members = [loopNode];
  for (const id of loopNode.body ?? []) {
    const m = nodes.find((n) => n.id === id);
    if (m) members.push(m);
  }
  const positioned = members.filter((n) => n.pos);
  if (positioned.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of positioned) {
    minX = Math.min(minX, n.pos.x);
    minY = Math.min(minY, n.pos.y);
    maxX = Math.max(maxX, n.pos.x + NODE_W);
    maxY = Math.max(maxY, n.pos.y + NODE_H);
  }
  return {
    x: minX - pad,
    y: minY - headerPad,
    width: maxX - minX + pad * 2,
    // Pie extra (36px) para el boton "+ Agregar bloque" del contenedor.
    height: maxY - minY + headerPad + pad + 36,
  };
}

/**
 * True when the given point (graph coords) falls inside a loop container
 * (excluding the loop's own header — dragging a body member under its parent
 * loop should not re-bucket it). Used by the drop-to-bucket interaction.
 */
export function loopContainsPoint(loopNode, nodes, pt) {
  const rect = loopBodyRect(loopNode, nodes);
  if (!rect) return false;
  const loopPad = loopNode.pos ? 30 : 0;
  return (
    pt.x >= rect.x &&
    pt.x <= rect.x + rect.width &&
    pt.y >= rect.y + loopPad &&
    pt.y <= rect.y + rect.height
  );
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
 * Stack loop body members vertically under their loop header. Loop members are
 * NOT user-movable (the loop is an auto-chained sequence, see graph-engine),
 * so their `pos` is always recomputed: member i sits one row below member
 * i-1, sharing the loop header's x. The loop header keeps its own `pos` (or
 * stays undefined so layoutGraph fills it in). Returns new node objects so the
 * editor state stays immutable during rendering.
 */
export function stackLoopMembers(nodes) {
  const STACK_GAP = 14;
  let changed = false;
  const out = nodes.map((n) => ({ ...n }));
  for (const n of out) {
    if (n.type !== "loop" || !Array.isArray(n.body) || n.body.length === 0) continue;
    const header = n.pos ? { x: n.pos.x, y: n.pos.y } : null;
    if (!header) continue; // layoutGraph will place the header first pass
    let y = header.y + NODE_H + STACK_GAP;
    for (const memberId of n.body) {
      const m = out.find((x) => x.id === memberId);
      if (!m) continue;
      const want = { x: header.x, y };
      if (!m.pos || m.pos.x !== want.x || m.pos.y !== want.y) {
        m.pos = want;
        changed = true;
      }
      y += NODE_H + STACK_GAP;
    }
  }
  return changed ? out : nodes;
}

/** Id of the loop that owns `nodeId`, or null when the node is not in a body. */
export function ownerLoopId(nodes, nodeId) {
  for (const n of nodes) {
    if (n.type === "loop" && Array.isArray(n.body) && n.body.includes(nodeId)) return n.id;
  }
  return null;
}

/** Drop edges that connect into/out of loop body members (obsolete auto-chain). */
export function stripLoopInternalEdges(edges, nodes) {
  const members = new Set();
  for (const n of nodes) {
    if (n.type === "loop" && Array.isArray(n.body)) {
      for (const m of n.body) members.add(m);
    }
  }
  return edges.filter((e) => !members.has(e.from) && !members.has(e.to));
}

/** Human-readable Spanish label for a dashboard context field. */
export function campoLegible(field) {
  const labels = {
    "lastResponse.status": "Estado de la última respuesta",
    "lastResponse.content": "Contenido de la última respuesta",
    error: "Error",
  };
  return labels[field] ?? field;
}

/** Human-readable Spanish phrase for a comparison operator. */
export function operadorLegible(op) {
  const labels = {
    "==": "es igual a",
    "!=": "es distinto de",
    "<": "es menor que",
    "<=": "es menor o igual que",
    ">": "es mayor que",
    ">=": "es mayor o igual que",
  };
  return labels[op] ?? op;
}

/**
 * Serialize a condition AST into a readable Spanish sentence (used by the
 * node preview and the inspector's live phrase). Safe deserialization: any
 * shape outside the closed compare/exists/not/logical set — or an incomplete
 * leaf (missing field/op2/value) — yields "", never throws.
 */
export function describeCondition(ast) {
  if (!ast || typeof ast !== "object") return "";
  switch (ast.op) {
    case "compare": {
      const valid =
        typeof ast.field === "string" &&
        ast.field !== "" &&
        typeof ast.op2 === "string" &&
        ast.op2 !== "" &&
        ast.value !== undefined &&
        ast.value !== null &&
        ast.value !== "";
      return valid
        ? `${campoLegible(ast.field)} ${operadorLegible(ast.op2)} ${String(ast.value)}`
        : "";
    }
    case "exists": {
      if (typeof ast.field !== "string" || ast.field === "") return "";
      // "Existe error" (no "Existe Error"): la frase suena natural en espanol
      // con el label del campo en minuscula inicial.
      const label = campoLegible(ast.field);
      return `Existe ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
    }
    case "not": {
      const child = describeCondition(ast.child);
      return child === "" ? "" : `No (${child})`;
    }
    case "logical": {
      if (!Array.isArray(ast.args) || ast.args.length === 0) return "";
      const parts = ast.args.map((a) => describeCondition(a)).filter((p) => p !== "");
      return parts.length === 0
        ? ""
        : `(${parts.join(ast.and === false ? " o " : " y ")})`;
    }
    default:
      return "";
  }
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

/**
 * Human-readable Spanish label for an llm_call mode. The engine defaults an
 * absent mode to "generate" (payloadFor), so a missing/empty mode reads as
 * "Generar"; unknown values fall back to their raw string.
 */
export function llmModeLegible(mode) {
  const labels = {
    generate: "Generar",
    refine: "Refinar",
    passthrough: "Pasar",
  };
  if (mode == null || mode === "") return "Generar";
  return labels[mode] ?? String(mode);
}

/** Max preview length for the system-prompt snippet inside `describeLlmCall`. */
const SYS_PREVIEW_MAX = 24;

/** Collapse whitespace and truncate a system prompt to a readable snippet. */
function truncateSys(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SYS_PREVIEW_MAX
    ? `${flat.slice(0, SYS_PREVIEW_MAX).trimEnd()}\u2026`
    : flat;
}

/**
 * Living-language preview for an llm_call node: "model · mode · ctx N
 * [· sys "…"]". `ctx` reads either the schema-level `ctx` field (legacy load
 * path) or the editor's `params.ctx` override. Pure — the SVG renderer
 * truncates further to fit the node body.
 */
export function describeLlmCall(node) {
  if (!node || typeof node !== "object") return "";
  const parts = [node.model ?? "sin modelo"];
  const modeWord = llmModeLegible(node.mode);
  parts.push(`${modeWord.charAt(0).toLowerCase()}${modeWord.slice(1)}`);
  const ctx = node.params?.ctx ?? node.ctx;
  if (ctx != null && ctx !== "") parts.push(`ctx ${ctx}`);
  if (typeof node.system === "string" && node.system.trim() !== "") {
    parts.push(`sys "${truncateSys(node.system)}"`);
  }
  return parts.join(" \u00b7 ");
}

/**
 * Living-language preview for a pipeline node: "pipeline → name [· N params]".
 * The param count covers the node's own keys (a pipeline may carry none).
 */
export function describePipeline(node) {
  if (!node || typeof node !== "object") return "";
  let text = `pipeline \u2192 ${node.pipeline ?? "sin pipeline"}`;
  const p = node.params;
  if (p && typeof p === "object") {
    const count = Object.keys(p).length;
    if (count > 0) text += ` \u00b7 ${count} params`;
  }
  return text;
}

/**
 * Split a params record into editable key/value rows. Absent or non-object
 * params yield []. Values are stringified — the schema types params as
 * `Record<string, string>`.
 */
export function paramsToRows(params) {
  if (!params || typeof params !== "object") return [];
  return Object.entries(params).map(([key, value]) => ({ key, value: String(value) }));
}

/**
 * Serialize key/value rows back into a params record, dropping rows whose key
 * is empty or whitespace-only (the UI flags those rows as invalid). Keys are
 * trimmed; values are kept stringified. Round-trips stably with `paramsToRows`.
 */
export function rowsToParams(rows) {
  if (!Array.isArray(rows)) return {};
  const out = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (key === "") continue;
    out[key] = String(row.value ?? "");
  }
  return out;
}

/**
 * Living-language preview for a loop's exit condition: `describeCondition`'s
 * sentence, or "" when the loop has none. The engine runs the body and exits
 * once the condition holds (do-while, see graph-engine), so the phrase states
 * the exit predicate directly — no "while" prefix that would read inverted.
 */
export function describeLoop(node) {
  if (!node || typeof node !== "object") return "";
  return describeCondition(node.condition);
}
