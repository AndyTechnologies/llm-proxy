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
} from "./graph-model.js";

// ── State ────────────────────────────────────────────────────────────────
const state = {
  nodes: [],      // committed nodes {id,type,model?,condition?,body?,pipeline?}
  edges: [],      // committed edges {from,to,guard?}
  selectedId: null,
  nextId: 1,
  models: [],     // {id,file,loaded}
  applyError: null,
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
  addNode(type);
});

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

function addNode(type) {
  const id = `n${state.nextId++}`;
  const node = createNode(type, id);
  state.nodes.push(node);
  state.selectedId = id;
  render();
  // Keep the empty-state hint hidden once nodes exist.
  if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
  openInspector(node);
}

function removeNode(id) {
  state.nodes = state.nodes.filter((n) => n.id !== id);
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  if (state.selectedId === id) state.selectedId = null;
  render();
  if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
  $("#inspector-empty").hidden = false;
  $("#inspector-body").hidden = true;
}

// ── SVG graph render ─────────────────────────────────────────────────────
function render() {
  svg.replaceChildren();
  const pos = layoutGraph(state.nodes, state.edges);

  // Edges first (under nodes).
  for (const e of state.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "edge-line");
    path.setAttribute("d", edgePath(a, b));
    path.setAttribute("data-from", e.from);
    path.setAttribute("data-to", e.to);
    svg.appendChild(path);
    if (e.guard) {
      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("class", "edge-label");
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - 6;
      lbl.setAttribute("x", String(mx));
      lbl.setAttribute("y", String(my));
      lbl.textContent = e.guard;
      svg.appendChild(lbl);
    }
  }

  for (const n of state.nodes) {
    const p = pos.get(n.id) ?? { x: 200, y: 200 };
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
    box.setAttribute("width", "130");
    box.setAttribute("height", "40");

    const lbl = document.createElementNS(NS, "text");
    lbl.setAttribute("class", "node-label");
    lbl.setAttribute("x", String(p.x + 65));
    lbl.setAttribute("y", String(p.y + 24));
    lbl.setAttribute("text-anchor", "middle");
    const missing = isCompleteNode(n) ? "" : " ·";
    lbl.textContent = `${n.type}${missing}`;

    g.appendChild(box);
    g.appendChild(lbl);
    g.addEventListener("click", () => {
      state.selectedId = n.id;
      render();
      openInspector(n);
    });
    svg.appendChild(g);
  }
}

/** Quadratic-ish edge path between two node boxes (native SVG, no lib). */
function edgePath(a, b) {
  const x1 = a.x + 65;
  const y1 = a.y + 20;
  const x2 = b.x + 65;
  const y2 = b.y + 20;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

// ── Inspector ────────────────────────────────────────────────────────────
function openInspector(node) {
  const empty = $("#inspector-empty");
  const body = $("#inspector-body");
  empty.hidden = true;
  body.hidden = false;

  const modelOpts = state.models
    .map((m) => `<option value="${m.id}" ${node.model === m.id ? "selected" : ""}>${m.id}</option>`)
    .join("");

  const edgeOpts = state.nodes
    .filter((n) => n.id !== node.id)
    .map((n) => `<option value="${n.id}">${n.id}</option>`)
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

  body.innerHTML = `
    <div class="field"><label>ID</label><div class="primary">${node.id}</div></div>
    <div class="field"><label>Type</label><div>${node.type}</div></div>
    ${node.type === "llm_call" ? `<div class="field"><label for="node-model">Model</label>
      <select id="node-model">${modelOpts}</select></div>` : ""}
    ${node.type === "pipeline" ? `<div class="field"><label for="node-pipeline">Pipeline</label>
      <input id="node-pipeline" class="text-input" type="text" value="${node.pipeline ?? ""}" aria-label="Pipeline name" /></div>` : ""}
    ${conditionArea}
    <div class="field"><label for="node-connect">Connect to</label>
      <select id="node-connect"><option value="">— none —</option>${edgeOpts}</select></div>
    <div class="field"><label for="node-guard">Guard (condition branch)</label>
      <select id="node-guard"><option value="">none</option>
      <option value="true" ${nodeEdgeGuard(node) === "true" ? "selected" : ""}>true</option>
      <option value="false" ${nodeEdgeGuard(node) === "false" ? "selected" : ""}>false</option></select>
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
  const conn = $("#node-connect");
  conn?.addEventListener("change", () => {
    if (!conn.value) return;
    const n = findNode(node.id);
    if (!n) return;
    const guardSel = $("#node-guard");
    const guard = guardSel ? guardSel.value || undefined : undefined;
    // Replace any existing outgoing edge from this node with the new one.
    state.edges = state.edges.filter((e) => e.from !== node.id);
    state.edges.push({ from: node.id, to: conn.value, ...(guard ? { guard } : {}) });
    render();
  });
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
          </div>`,
      )
      .join("");
  } catch (err) {
    $("#pipelines-list").textContent = "Failed to load pipelines: " + err.message;
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
