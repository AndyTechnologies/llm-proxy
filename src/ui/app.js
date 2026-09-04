/**
 * Dashboard SPA controller (Slice D — task 4.2, dashboard-ui spec).
 *
 * A vanilla (no framework, no D3/xyflow) browser app that:
 *   - loads pipelines/models/executions from the `/api/ui/*` endpoints
 *   - renders the pipeline graph as native SVG DOM elements
 *   - provides an HTML5 drag-and-drop node palette + keyboard node insertion
 *   - builds condition expressions with a closed-set AST builder (compare /
 *     logical / not / exists only — no free-form code entry)
 *   - validates and hot-applies the composed graph
 *   - subscribes to the SSE `/api/ui/events` bus for live updates
 *   - surfaces apply errors while retaining the previous editor state
 *
 * All hard logic lives in graph-model.js (pure, unit-tested); this file wires
 * it to the DOM.
 */
import {
  createNode,
  layoutGraph,
  buildPayload,
  buildCondition,
  ctxFields,
  compareOps,
  isCompleteNode,
  moveNode,
  deleteNode,
  connectNodes,
  NODE_W,
  NODE_H,
  socketPositions,
  bezierEdge,
} from "./graph-model.js";

// ── State ────────────────────────────────────────────────────────────────
const state = {
  nodes: [],      // committed nodes {id,type,model?,condition?,body?,pipeline?,pos?}
  edges: [],      // committed edges {from,to,guard?}
  selectedId: null,
  nextId: 1,
  models: [],     // {id,file,loaded,ctx?,temp?}
  applyError: null,
  // Live drag/connect interaction state.
  drag: null,     // {id, startX, startY, baseX, baseY} when moving a node
  connect: null,  // {from, x, y} while drawing a temporary connection
  // Pan/zoom viewport (node-editor style). `x`,`y` is the SVG→screen origin
  // translation, `scale` the zoom factor. Transform = translate(x,y) scale(s).
  view: { x: 40, y: 40, scale: 1 },
  // Panning the empty canvas (pointer captured; not a node drag).
  pan: null,      // {startScreenX, startScreenY, baseViewX, baseViewY}
};

const NS = "http://www.w3.org/2000/svg";

// ── DOM references ───────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const svg = $("#graph-svg");
const canvas = $("#graph-canvas");
const canvasEmpty = $("#canvas-empty");

// ── Node palette drag + drop ─────────────────────────────────────────────
const paletteItems = [...document.querySelectorAll(".palette-item")];
paletteItems.forEach((item) => {
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", item.dataset.nodeType);
    e.dataTransfer.effectAllowed = "copy";
  });
});

canvas.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

canvas.addEventListener("drop", (e) => {
  e.preventDefault();
  const type = e.dataTransfer.getData("text/plain");
  if (!type) return;
  // Place the new node where it was dropped, converted from screen to graph
  // coordinates so the drop lands correctly under the current pan/zoom.
  addNode(type, screenToGraph(e.clientX, e.clientY));
});

// ── Viewport (pan/zoom) helpers ──────────────────────────────────────────
// The SVG content lives in a <g data-viewport> with contentUnder transform
// translate(view.x, view.y) scale(view.scale). Node/edge coordinates are in
// GRAPH space; these helpers map between that and on-screen (client) coords.
function graphTransform() {
  return `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`;
}

function screenToGraph(cx, cy) {
  const rect = svg.getBoundingClientRect();
  const sx = cx - rect.left;
  const sy = cy - rect.top;
  return {
    x: (sx - state.view.x) / state.view.scale,
    y: (sy - state.view.y) / state.view.scale,
  };
}

// Zoom anchored at the pointer (Excalidraw/Blender style): the graph point
// under the cursor stays put as the scale changes.
function zoomAt(cx, cy, factor) {
  const p = screenToGraph(cx, cy);
  const next = Math.min(3, Math.max(0.2, state.view.scale * factor));
  const rect = svg.getBoundingClientRect();
  const sx = cx - rect.left;
  const sy = cy - rect.top;
  state.view.scale = next;
  state.view.x = sx - p.x * next;
  state.view.y = sy - p.y * next;
  render();
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

// Pan the whole canvas by dragging on the empty background (not a node/socket).
svg.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest?.(".graph-node") || ev.target.closest?.(".socket") || ev.target.closest?.(".edge-delete")) return;
  ev.preventDefault();
  state.pan = {
    startScreenX: ev.clientX,
    startScreenY: ev.clientY,
    baseViewX: state.view.x,
    baseViewY: state.view.y,
  };
  svg.setPointerCapture(ev.pointerId);
  svg.classList.add("panning");
});

// Global pointer handling for node dragging + temporary connections.
// Capture on the SVG root so pointer moves/ups are tracked even when the
// cursor leaves a node's bounds mid-gesture.
svg.addEventListener("pointermove", onPointerMove);
svg.addEventListener("pointerup", onPointerUp);
svg.addEventListener("pointercancel", onPointerUp);

// Accessibility: keyboard node insertion. With the canvas focused, keys 1–6
// add each palette node type (see index.html palette ordering).
canvas.addEventListener("keydown", (e) => {
  const map = { "1": "start", "2": "llm_call", "3": "condition", "4": "loop", "5": "pipeline", "6": "end" };
  if (map[e.key]) {
    e.preventDefault();
    addNode(map[e.key]);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selectedId) {
      removeNode(state.selectedId);
      e.preventDefault();
    }
  }
});

function addNode(type, at) {
  const id = `n${state.nextId++}`;
  const node = createNode(type, id);
  if (at) node.pos = { x: at.x, y: at.y };
  state.nodes.push(node);
  state.selectedId = id;
  render();
  // Keep the empty-state hint hidden once nodes exist.
  if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
  openInspector(node);
}

function removeNode(id) {
  const { nodes, edges } = deleteNode(state.nodes, state.edges, id);
  state.nodes = nodes;
  state.edges = edges;
  if (state.selectedId === id) state.selectedId = null;
  render();
  if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
  $("#inspector-empty").hidden = false;
  $("#inspector-body").hidden = true;
}

// ── SVG graph render ─────────────────────────────────────────────────────
// Which of a node's two sockets exist. Start nodes have no meaningful input and
// end nodes no meaningful output, so we hide the irrelevant port and forbid
// connecting into/out of it — Blender-style rather than showing a dead socket.
function socketRoles(node) {
  return {
    input: node.type !== "start",
    output: node.type !== "end",
  };
}

// Can we legally create an edge from a `from` node to a `to` node? Mirrors the
// socket roles: never into a start, never out of an end, never self-loops.
function canConnect(fromNode, toNode) {
  if (!fromNode || !toNode) return false;
  if (fromNode.id === toNode.id) return false;
  if (fromNode.type === "end") return false;
  if (toNode.type === "start") return false;
  return true;
}

function render() {
  svg.replaceChildren();
  const pos = layoutGraph(state.nodes, state.edges);
  // Persist laid-out positions back onto nodes for nodes that still lack one,
  // so a subsequent drag starts from a real coordinate AND the editor can be
  // re-rendered without jumping.
  state.nodes = state.nodes.map((n) => (n.pos ? n : { ...n, pos: pos.get(n.id) ?? { x: 40, y: 40 } }));

  // Everything (grid + nodes + edges) lives inside one transformed group.
  const vp = document.createElementNS(NS, "g");
  vp.setAttribute("data-viewport", "true");
  vp.setAttribute("transform", graphTransform());
  svg.appendChild(vp);

  // Edges (under nodes), as free-form bezier curves between sockets.
  const byFrom = new Map();
  for (const e of state.edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e);
  }
  for (const e of state.edges) {
    const an = state.nodes.find((n) => n.id === e.from);
    const bn = state.nodes.find((n) => n.id === e.to);
    if (!an?.pos || !bn?.pos) continue;
    const a = socketPositions(an.pos).out;
    const b = socketPositions(bn.pos).in;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "edge-line");
    path.setAttribute("d", bezierEdge(a.x, a.y, b.x, b.y));
    path.setAttribute("data-from", e.from);
    path.setAttribute("data-to", e.to);
    vp.appendChild(path);
    if (e.guard) {
      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("class", "edge-label");
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - 8;
      lbl.setAttribute("x", String(mx));
      lbl.setAttribute("y", String(my));
      lbl.textContent = e.guard;
      vp.appendChild(lbl);
    }
    // A small delete affordance at each edge's midpoint makes connections easy
    // to sever with the mouse (hover the dot, then click).
    const del = document.createElementNS(NS, "circle");
    del.setAttribute("class", "edge-delete");
    del.setAttribute("cx", String((a.x + b.x) / 2));
    del.setAttribute("cy", String((a.y + b.y) / 2));
    del.setAttribute("r", "6");
    del.setAttribute("data-from", e.from);
    del.setAttribute("data-to", e.to);
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.edges = state.edges.filter(
        (x) => !(x.from === e.from && x.to === e.to),
      );
      render();
    });
    vp.appendChild(del);
  }

  for (const n of state.nodes) {
    const p = n.pos ?? { x: 40, y: 40 };
    const roles = socketRoles(n);
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "graph-node");
    g.setAttribute("data-id", n.id);
    g.setAttribute("data-type", n.type);
    if (state.selectedId === n.id) g.setAttribute("class", "graph-node selected");

    const box = document.createElementNS(NS, "rect");
    box.setAttribute("class", "node-box");
    box.setAttribute("data-type", n.type);
    box.setAttribute("x", String(p.x));
    box.setAttribute("y", String(p.y));
    box.setAttribute("width", String(NODE_W));
    box.setAttribute("height", String(NODE_H));
    box.setAttribute("rx", "8");

    const lbl = document.createElementNS(NS, "text");
    lbl.setAttribute("class", "node-label");
    lbl.setAttribute("x", String(p.x + NODE_W / 2));
    lbl.setAttribute("y", String(p.y + 24));
    lbl.setAttribute("text-anchor", "middle");
    const missing = isCompleteNode(n) ? "" : " ·";
    lbl.textContent = `${n.type}${missing}`;

    // Model/pipeline subtitle when present (keeps the node informative).
    const sub = n.model ?? n.pipeline;
    if (sub) {
      const subLbl = document.createElementNS(NS, "text");
      subLbl.setAttribute("class", "node-sub");
      subLbl.setAttribute("x", String(p.x + NODE_W / 2));
      subLbl.setAttribute("y", String(p.y + NODE_H - 14));
      subLbl.setAttribute("text-anchor", "middle");
      subLbl.textContent = sub;
      g.appendChild(subLbl);
    }

    // Connection sockets (Blender/Godot-style). Input = green, output = red;
    // hidden entirely where the node type has no such port.
    const sp = socketPositions(p);
    if (roles.input) {
      const inSock = document.createElementNS(NS, "circle");
      inSock.setAttribute("class", "socket socket-in");
      inSock.setAttribute("cx", String(sp.in.x));
      inSock.setAttribute("cy", String(sp.in.y));
      inSock.setAttribute("r", "7");
      inSock.setAttribute("data-role", "input");
      g.appendChild(inSock);
    }
    if (roles.output) {
      const outSock = document.createElementNS(NS, "circle");
      outSock.setAttribute("class", "socket socket-out");
      outSock.setAttribute("cx", String(sp.out.x));
      outSock.setAttribute("cy", String(sp.out.y));
      outSock.setAttribute("r", "7");
      outSock.setAttribute("data-role", "output");
      outSock.addEventListener("pointerdown", (ev) => startConnect(ev, n.id));
      g.appendChild(outSock);
    }

    // Delete button on the node body (mouse path; keyboard Delete also works).
    const delBtn = document.createElementNS(NS, "circle");
    delBtn.setAttribute("class", "node-delete");
    delBtn.setAttribute("cx", String(p.x + NODE_W - 12));
    delBtn.setAttribute("cy", String(p.y + 12));
    delBtn.setAttribute("r", "8");
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeNode(n.id);
    });
    g.appendChild(delBtn);

    // Click on the body selects the node.
    g.addEventListener("click", (ev) => {
      if (ev.target !== box && ev.target.closest(".socket")) return;
      state.selectedId = n.id;
      render();
      openInspector(n);
    });

    // Drag the body to move the node.
    g.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".socket") || ev.target.closest(".node-delete")) return;
      startDragNode(ev, n);
    });

    g.appendChild(box);
    g.appendChild(lbl);
    vp.appendChild(g);
  }

  // The in-progress connection follows the pointer during a socket drag.
  if (state.connect) {
    const from = state.nodes.find((n) => n.id === state.connect.from);
    if (from?.pos) {
      const a = socketPositions(from.pos).out;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", "edge-line edge-draft");
      path.setAttribute("d", bezierEdge(a.x, a.y, state.connect.x, state.connect.y));
      vp.appendChild(path);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("class", "edge-dot");
      dot.setAttribute("cx", String(state.connect.x));
      dot.setAttribute("cy", String(state.connect.y));
      dot.setAttribute("r", "5");
      vp.appendChild(dot);
    }
  }
}


// ── Node dragging (move) ─────────────────────────────────────────────────
function startDragNode(ev, n) {
  ev.preventDefault();
  const rect = svg.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  state.drag = { id: n.id, startX: sx, startY: sy, baseX: n.pos?.x ?? 0, baseY: n.pos?.y ?? 0 };
  svg.setPointerCapture(ev.pointerId);
  svg.classList.add("dragging");
}

function onPointerMove(ev) {
  // Pan the whole viewport when dragging the empty canvas.
  if (state.pan) {
    ev.preventDefault();
    state.view.x = state.pan.baseViewX + (ev.clientX - state.pan.startScreenX);
    state.view.y = state.pan.baseViewY + (ev.clientY - state.pan.startScreenY);
    render();
    return;
  }
  // Move a dragged node: deltas are in screen px, so divide by scale to move
  // in graph coordinates (which the transform then projects back).
  if (state.drag) {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const dx = (ev.clientX - rect.left - state.drag.startX) / state.view.scale;
    const dy = (ev.clientY - rect.top - state.drag.startY) / state.view.scale;
    const nx = Math.max(0, state.drag.baseX + dx);
    const ny = Math.max(0, state.drag.baseY + dy);
    state.nodes = moveNode(state.nodes, state.drag.id, nx, ny);
    render();
    return;
  }
  // Follow the pointer (in graph coordinates) while drawing a connection.
  if (state.connect) {
    const p = screenToGraph(ev.clientX, ev.clientY);
    state.connect.x = p.x;
    state.connect.y = p.y;
    render();
  }
}

function onPointerUp(ev) {
  if (state.pan) {
    state.pan = null;
    svg.classList.remove("panning");
  }
  if (state.drag) {
    state.drag = null;
    svg.classList.remove("dragging");
  }
  // While drawing a connection, resolve the drop target by hit-testing the
  // point under the pointer: the pointer is captured on the svg root, so the
  // element that "received" the pointerup is the svg, not the target socket.
  // elementFromPoint tells us which node's input socket was actually released
  // onto, which is what finalizes the edge.
  if (state.connect && !state.connect.done) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const sock = el?.closest?.(".socket-in");
    const nodeId = sock?.closest?.("[data-id]")?.getAttribute("data-id");
    if (nodeId) {
      finishConnect(nodeId);
    } else {
      state.connect = null;
      render();
    }
  }
}

// ── Socket → socket connection (Blender/Godot-style) ─────────────────────
function startConnect(ev, fromId) {
  ev.preventDefault();
  ev.stopPropagation();
  const p = screenToGraph(ev.clientX, ev.clientY);
  state.connect = { from: fromId, x: p.x, y: p.y, done: false };
  svg.setPointerCapture(ev.pointerId);
  svg.classList.add("dragging");
}

function finishConnect(toId) {
  if (!state.connect || state.connect.from === toId) return;
  // Refuse connections the node roles forbid (never out of `end`, never into
  // a `start`).
  const fromNode = state.nodes.find((n) => n.id === state.connect.from);
  const toNode = state.nodes.find((n) => n.id === toId);
  if (!canConnect(fromNode, toNode)) {
    state.connect = null;
    svg.classList.remove("dragging");
    render();
    return;
  }
  state.connect.done = true;
  // Preserve any existing guard on this edge when re-connecting.
  const existing = state.edges.find((e) => e.from === state.connect.from && e.to === toId);
  state.edges = connectNodes(state.edges, state.connect.from, toId, existing?.guard);
  state.connect = null;
  svg.classList.remove("dragging");
  // If reconnecting the same from→to, the inspector guard is still shown.
  render();
}

// ── Inspector ────────────────────────────────────────────────────────────
// Standard context windows offered by the selector (tokens).
const CONTEXT_STANDARDS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

// The currently configured context for a model id (from /api/ui/models), or 0
// when unknown / not registered.
function modelCtx(id) {
  const m = state.models.find((x) => x.id === id);
  return typeof m?.ctx === "number" ? m.ctx : null;
}

// Build the context-window selector for an llm_call node. Shows the model's
// configured ctx as the highlighted "current" and persists a per-node override
// in params.ctx. A value outside the standard set becomes a "custom" free input.
function contextEditorHtml(node) {
  const current = modelCtx(node.model);
  const override = node.params?.ctx;
  const standards = CONTEXT_STANDARDS.map((c) => String(c));

  let selected = override;
  let isCustom = false;
  if (!selected && current) {
    selected = String(current);
  }
  if (selected && !standards.includes(selected)) {
    isCustom = true;
  }

  const opts = standards
    .map((c) => `<option value="${c}" ${selected === c ? "selected" : ""}>${c.toLocaleString()}</option>`)
    .join("");
  const currentNote =
    current != null
      ? `<div class="hint">Current for <strong>${esc(node.model ?? "")}</strong>: ${current.toLocaleString()} tokens.</div>`
      : `<div class="hint">Context window (tokens). The model's configured value isn't reported; the maximum physical window is unknown.</div>`;

  return `<div class="field"><label for="node-ctx">Context window</label>
    <select id="node-ctx">
      <option value="" ${selected ? "" : "selected"}>— inherit / unset —</option>
      <option value="custom" ${isCustom ? "selected" : ""}>Custom…</option>
      ${opts}
    </select>
    <input id="node-ctx-custom" class="text-input ${isCustom ? "" : "hidden"}" type="number" min="1" step="1" value="${isCustom ? esc(selected) : ""}" aria-label="Custom context window" />
    ${currentNote}
  </div>`;
}
function openInspector(node) {
  const empty = $("#inspector-empty");
  const body = $("#inspector-body");
  empty.hidden = true;
  body.hidden = false;

  const modelOpts = state.models
    .map((m) => `<option value="${m.id}" ${node.model === m.id ? "selected" : ""}>${m.id}</option>`)
    .join("");

  const conditionArea =
    node.type === "condition"
      ? `<div class="field">
           <span class="field-label" id="cond-label-${node.id}">Condition</span>
           <div class="ast-builder" id="cond-builder-${node.id}" aria-labelledby="cond-label-${node.id}">
             ${conditionBuilderHtml(node)}
           </div>
         </div>`
      : "";

  // Context-window selector for llm_call nodes: standard values with the
  // model's configured ctx (from config.llama.models) marked, and the node's
  // own override pre-selected. The maximum physical window isn't known to the
  // dashboard, so values aren't clamped — but we surface both the model's
  // configured context and a "custom" free entry.
  const ctxHtml = node.type === "llm_call" ? contextEditorHtml(node) : "";

  body.innerHTML = `
    <div class="field"><label>ID</label><div class="primary">${node.id}</div></div>
    <div class="field"><label>Type</label><div>${node.type}</div></div>
    ${node.type === "llm_call" ? `<div class="field"><label for="node-model">Model</label>
      <select id="node-model">${modelOpts}</select></div>` : ""}
    ${ctxHtml}
    ${node.type === "pipeline" ? `<div class="field"><label for="node-pipeline">Pipeline</label>
      <input id="node-pipeline" class="text-input" type="text" value="${node.pipeline ?? ""}" aria-label="Pipeline name" /></div>` : ""}
    ${conditionArea}
    <div class="field"><label for="node-guard">Guard (condition branch)</label>
      <select id="node-guard"><option value="">none</option>
      <option value="true" ${nodeEdgeGuard(node) === "true" ? "selected" : ""}>true</option>
      <option value="false" ${nodeEdgeGuard(node) === "false" ? "selected" : ""}>false</option></select>
    </div>
    <div class="field"><label>Connection</label>
      <div class="hint">Drag the socket on the right (●) of a node onto the socket on the left (●) of another to connect them. Drag a node by its body to move it.</div>
    </div>`;

  body.dataset.nodeId = node.id;

  if (node.type === "condition") {
    wireConditionBuilder(node);
  }
  if (node.type === "llm_call") {
    const sel = $("#node-model");
    sel?.addEventListener("change", () => {
      const n = findNode(node.id);
      if (!n) return;
      if (sel.value) n.model = sel.value;
      render();
    });
    // Context window: an explicit standard value, or "custom" reveals the free
    // input. Stored on the node as params.ctx (a per-block override).
    const ctxSel = $("#node-ctx");
    const ctxCustom = $("#node-ctx-custom");
    const wireCtx = () => {
      const n = findNode(node.id);
      if (!n) return;
      const val = ctxSel?.value;
      if (val === "custom") {
        const raw = parseInt(ctxCustom?.value ?? "", 10);
        if (Number.isFinite(raw) && raw > 0) {
          n.params = { ...(n.params ?? {}), ctx: String(raw) };
        } else {
          delete (n.params ?? {}).ctx;
        }
      } else if (val) {
        n.params = { ...(n.params ?? {}), ctx: val };
      } else {
        delete (n.params ?? {}).ctx;
      }
    };
    ctxSel?.addEventListener("change", () => {
      if (ctxSel.value === "custom") ctxCustom?.classList.remove("hidden");
      else ctxCustom?.classList.add("hidden");
      wireCtx();
      render();
    });
    ctxCustom?.addEventListener("input", () => {
      wireCtx();
      render();
    });
  }
  if (node.type === "pipeline") {
    const inp = $("#node-pipeline");
    inp?.addEventListener("change", () => {
      const n = findNode(node.id);
      if (!n) return;
      if (inp.value) n.pipeline = inp.value;
      render();
    });
  }
  const guardSel = $("#node-guard");
  guardSel?.addEventListener("change", () => {
    const edge = state.edges.find((e) => e.from === node.id);
    if (!edge) return;
    if (guardSel.value) edge.guard = guardSel.value;
    else delete edge.guard;
    render();
  });
}

function nodeEdgeGuard(node) {
  const edge = state.edges.find((e) => e.from === node.id);
  return edge ? edge.guard ?? "" : "";
}

function findNode(id) {
  return state.nodes.find((n) => n.id === id);
}

// ── Condition AST builder (closed set, no free-form code) ────────────────
function conditionBuilderHtml(node) {
  const cond = node.condition ?? { op: "compare", field: "lastResponse.status", op2: "==", value: 200 };
  const fieldOpts = ctxFields
    .map((f) => `<option value="${f}" ${cond.field === f ? "selected" : ""}>${f}</option>`)
    .join("");
  const cmpOpts = compareOps
    .map((o) => `<option value="${o}" ${cond.op2 === o ? "selected" : ""}>${o}</option>`)
    .join("");

  return `
    <div class="ast-row">
      <select id="cond-op" class="cond-op" aria-label="Condition operator">
        <option value="compare">compare</option>
        <option value="exists">exists</option>
        <option value="logical">logical</option>
        <option value="not">not</option>
      </select>
    </div>
    <div class="ast-op" data-role="leaf" data-op="${cond.op}">
      <div class="ast-row">
        <select class="cond-field" aria-label="Context field">${fieldOpts}</select>
        <select class="cond-op2" aria-label="Comparison" data-current="${cond.op2 ?? ""}">${cmpOpts}</select>
        <input class="cond-value text-input" type="text" value="${cond.value ?? ""}" aria-label="Value" />
      </div>
    </div>`;
}

function wireConditionBuilder(node) {
  const builder = $(`#cond-builder-${node.id}`);
  if (!builder) return;

  // Whenever any control changes, re-read the form and commit a built AST.
  builder.addEventListener("input", () => {
    const op = builder.querySelector("#cond-op")?.value ?? "compare";
    const field = builder.querySelector(".cond-field")?.value ?? "error";
    const op2 = builder.querySelector(".cond-op2")?.value ?? "==";
    const raw = builder.querySelector(".cond-value")?.value ?? "";
    const num = Number(raw);
    const value = raw !== "" && !Number.isNaN(num) ? num : raw;

    let ast;
    if (op === "exists") {
      ast = buildCondition({ op: "exists", field });
    } else if (op === "compare") {
      ast = buildCondition({ op: "compare", field, op2, value });
    } else if (op === "logical") {
      // Single child leaf — logical AND of one condition keeps the builder
      // simple while still emitting a valid logical expression.
      ast = buildCondition({
        op: "logical",
        and: true,
        args: [{ op: "compare", field, op2, value }],
      });
    } else {
      ast = buildCondition({ op: "not", child: { op: "compare", field, op2, value } });
    }
    node.condition = ast;
    render();
  });
}

// ── Toolbar actions ──────────────────────────────────────────────────────
$("#btn-new").addEventListener("click", () => {
  resetEditor();
});

$("#btn-clear").addEventListener("click", () => {
  state.nodes = [];
  state.edges = [];
  state.selectedId = null;
  render();
  if (canvasEmpty) canvasEmpty.hidden = false;
  $("#inspector-empty").hidden = false;
  $("#inspector-body").hidden = true;
});

$("#btn-validate").addEventListener("click", () => validateGraph());

$("#btn-apply").addEventListener("click", () => applyGraph());

function validateGraph() {
  const payload = buildPayload(state);
  const id = $("#pipeline-name").value || "new-pipeline";
  fetch(`/api/ui/pipelines/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((res) => {
      const box = $("#validation-result");
      if (res.valid) {
        box.dataset.state = "valid";
        box.textContent = "Graph is valid.";
      } else {
        box.dataset.state = "invalid";
        box.textContent = "Invalid: " + (res.errors || []).join("; ");
      }
    })
    .catch((err) => {
      const box = $("#validation-result");
      box.dataset.state = "invalid";
      box.textContent = "Validation request failed: " + err.message;
    });
}

function applyGraph() {
  const id = $("#pipeline-name").value || "new-pipeline";
  const payload = buildPayload(state);
  const draft = {
    config: {
      // Minimal, schema-shaped config carrying the pipeline graph so the apply
      // service's zod validation accepts it. The gateway represents graph
      // pipelines within the chains map; a complete production config would
      // mirror config.example.yaml. Here we POST the composed graph so a hot
      // apply can register it.
      chains: {
        [id]: {
          displayName: id,
          provider: "llama-server",
          nodes: payload.nodes,
          edges: payload.edges,
        },
      },
    },
  };
  // Retain prior editor state: on failure we simply don't reset, and we
  // surface the error. On success we keep the graph and report status.
  fetch("/api/ui/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error?.message || `Apply failed (${r.status})`);
      }
      return data;
    })
    .then((data) => {
      const box = $("#validation-result");
      box.dataset.state = "valid";
      box.textContent = `Applied: ${(data.reloadedChains || []).join(", ") || "ok"}`;
      loadPipelines();
    })
    .catch((err) => {
      // Surface the apply error and RETAIN editor state (dashboard-ui spec:
      // "Apply failure is surfaced" — previous editor state retained).
      state.applyError = err.message;
      $("#validation-result").dataset.state = "invalid";
      $("#validation-result").textContent = "Apply failed (editor state retained): " + err.message;
      showApplyDialog(err.message);
    });
}

function showApplyDialog(message) {
  const dlg = $("#apply-dialog");
  $("#apply-dialog-message").textContent = message;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  $("#btn-apply-ok").onclick = () => {
    if (typeof dlg.close === "function") dlg.close();
    else dlg.removeAttribute("open");
  };
}

function resetEditor() {
  state.nodes = [];
  state.edges = [];
  state.selectedId = null;
  state.nextId = 1;
  render();
  if (canvasEmpty) canvasEmpty.hidden = false;
  $("#inspector-empty").hidden = false;
  $("#inspector-body").hidden = true;
  $("#validation-result").textContent = "";
}

// ── Data loading ─────────────────────────────────────────────────────────
async function loadPipelines() {
  try {
    const res = await fetch("/api/ui/pipelines");
    if (!res.ok) throw new Error(`pipelines ${res.status}`);
    const list = await res.json();
    const el = $("#pipelines-list");
    el.innerHTML = list
      .map(
        (p) =>
          `<div class="list-item">
            <span class="primary">${esc(p.id)}</span>
            <span class="secondary">${p.nodeCount} nodes</span>
            <button type="button" class="btn btn-small" data-open="${esc(p.id)}">Edit →</button>
          </div>`,
      )
      .join("");
    el.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => loadPipelineIntoEditor(btn.dataset.open));
    });
  } catch (err) {
    $("#pipelines-list").textContent = "Failed to load pipelines: " + err.message;
  }
}

/**
 * Load an existing pipeline's full graph into the editor (dashboard-api
 * GET /pipelines/:id). Positions are freshly laid out on load; the user then
 * arranges nodes freely with the mouse.
 */
async function loadPipelineIntoEditor(id) {
  try {
    const res = await fetch(`/api/ui/pipelines/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`pipeline ${id} ${res.status}`);
    const data = await res.json();
    const nodes = (data.nodes || []).map((n) => {
      const base = { id: n.id, type: n.type };
      if (n.model) base.model = n.model;
      if (n.provider) base.provider = n.provider;
      if (n.condition) base.condition = n.condition;
      if (n.body) base.body = n.body;
      if (n.pipeline) base.pipeline = n.pipeline;
      if (n.params) base.params = n.params;
      return base;
    });
    state.nodes = nodes;
    state.edges = (data.edges || []).map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.guard ? { guard: e.guard } : {}),
    }));
    state.selectedId = null;
    // Renumber nextId past loaded ids so new nodes don't collide.
    state.nextId = nodes.reduce((m, n) => Math.max(m, /^n(\d+)$/.exec(n.id)?.[1] ?? 0), 0) + 1;
    $("#pipeline-name").value = id;
    render();
    if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
    $("#inspector-empty").hidden = false;
    $("#inspector-body").hidden = true;
    const box = $("#validation-result");
    box.dataset.state = "valid";
    box.textContent = `Loaded pipeline "${id}" into the editor.`;
    switchView("editor", document.querySelector('.nav-link[data-view="editor"]'));
  } catch (err) {
    const box = $("#validation-result");
    box.dataset.state = "invalid";
    box.textContent = "Failed to load pipeline: " + err.message;
  }
}

async function loadModels() {
  try {
    const res = await fetch("/api/ui/models");
    if (!res.ok) throw new Error(`models ${res.status}`);
    const data = await res.json();
    state.models = data.models || [];
    $("#models-dir").textContent = `modelsDir: ${data.modelsDir}`;
    const el = $("#models-list");
    el.innerHTML = (data.models || [])
      .map(
        (m) =>
          `<div class="list-item">
            <span class="primary">${esc(m.id)}</span>
            <span class="chip">${m.loaded ? "loaded" : "candidate"}</span>
          </div>`,
      )
      .join("");
  } catch (err) {
    $("#models-list").textContent = "Failed to load models: " + err.message;
  }
}

async function loadExecutions() {
  try {
    const res = await fetch("/api/ui/executions?limit=50");
    if (!res.ok) throw new Error(`executions ${res.status}`);
    const list = await res.json();
    const el = $("#executions-list");
    el.innerHTML = list
      .map(
        (x) =>
          `<div class="list-item">
            <span class="primary">${esc(x.id)}</span>
            <span class="secondary">${esc(x.pipelineId)}</span>
            <span class="chip" data-status="${esc(x.status)}">${esc(x.status)}</span>
            <span class="secondary">${x.totalLatencyMs}ms</span>
          </div>`,
      )
      .join("");
  } catch (err) {
    $("#executions-list").textContent = "Failed to load executions: " + err.message;
  }
}

// ── SSE EventSource (live updates) ───────────────────────────────────────
function connectEvents() {
  const status = $("#conn-status");
  let es;
  try {
    es = new EventSource("/api/ui/events");
  } catch {
    status.dataset.state = "disconnected";
    status.textContent = "SSE unavailable";
    return;
  }
  es.onopen = () => {
    status.dataset.state = "connected";
    status.textContent = "Live";
  };
  es.onerror = () => {
    status.dataset.state = "disconnected";
    status.textContent = "Reconnecting…";
  };
  es.addEventListener("models:changed", () => loadModels());
  es.addEventListener("pipeline:reloaded", () => loadPipelines());
  es.addEventListener("step:started", () => loadExecutions());
  es.addEventListener("step:completed", () => loadExecutions());
  es.addEventListener("step:failed", () => loadExecutions());
  es.addEventListener("execution:started", () => loadExecutions());
  es.addEventListener("execution:completed", () => loadExecutions());
  es.addEventListener("execution:failed", () => loadExecutions());
}

// ── View switching ───────────────────────────────────────────────────────
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => switchView(link.dataset.view, link));
});

function switchView(name, link) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  const target = document.querySelector(`#${name}`);
  if (target) target.hidden = false;
  document.querySelectorAll(".nav-link").forEach((l) => l.removeAttribute("aria-current"));
  if (link) link.setAttribute("aria-current", "true");
  if (name === "pipelines") loadPipelines();
  if (name === "models") loadModels();
  if (name === "executions") loadExecutions();
}

// ── helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c];
  });
}

// ── init ─────────────────────────────────────────────────────────────────
function init() {
  resetEditor();
  connectEvents();
  loadPipelines();
  loadModels();
  loadExecutions();
  // Recompute SVG layout once fonts/layout settle.
  setTimeout(() => render(), 0);
}

document.addEventListener("DOMContentLoaded", init);
