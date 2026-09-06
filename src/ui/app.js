/**
 * Dashboard SPA controller — paleta dinamica con bloques preconfigurados.
 *
 * Vanilla (sin framework, sin D3/xyflow) que:
 *   - carga pipelines/modelos/ejecuciones desde /api/ui/*
 *   - renderiza el grafo como SVG nativo
 *   - genera bloques preconfigurados por cada modelo y pipeline registrado
 *   - construye expresiones de condicion con AST cerrado
 *   - valida y aplica el grafo en caliente
 *   - se suscribe al bus SSE /api/ui/events para actualizaciones en vivo
 *   - muestra errores de aplicacion conservando el estado previo del editor
 */
import {
  createNode,
  layoutGraph,
  buildPayload,
  describeCondition,
  campoLegible,
  operadorLegible,
  ctxFields,
  compareOps,
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
  describeLlmCall,
  describePipeline,
  paramsToRows,
  rowsToParams,
  describeLoop,
} from "./graph-model.js";

// ── Estado ────────────────────────────────────────────────────────────────
const state = {
  nodes: [],
  edges: [],
  selectedId: null,
  nextId: 1,
  models: [],
  pipelines: [],
  applyError: null,
  drag: null,
  connect: null,
  view: { x: 40, y: 40, scale: 1 },
  pan: null,
};

const NS = "http://www.w3.org/2000/svg";

// Estado de UI del inspector que NO puede vivir en el nodo (el schema es
// `.strict()` y rechaza keys ajenas): la pestana activa por nodo. Se limpia
// junto con el nodo en removeNode para que no se acumule.
const inspectorTabs = new Map();

// ── Referencias al DOM ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const svg = $("#graph-svg");
const canvas = $("#graph-canvas");
const canvasEmpty = $("#canvas-empty");

// ── Paleta: items genericos (drag + drop + click) ─────────────────────────
const paletteItems = [...document.querySelectorAll(".palette-item[data-node-type]")];
paletteItems.forEach((item) => {
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", item.dataset.nodeType);
    e.dataTransfer.effectAllowed = "copy";
  });
  // Click: agregar el bloque al lienzo, seleccionarlo y abrir el inspector.
  item.addEventListener("click", () => addNode(item.dataset.nodeType, clickPosition()));
});

/** Posicion por defecto para bloques agregados por click (cascada simple). */
function clickPosition() {
  const n = state.nodes.length;
  return { x: 60 + (n % 6) * 24, y: 60 + Math.floor(n / 6) * 24 };
}

// ── Paleta: renderizar bloques preconfigurados ────────────────────────────
function renderPalettePresets() {
  const modelsSection = $("#palette-models-section");
  const modelsList = $("#palette-models");
  const pipelinesSection = $("#palette-pipelines-section");
  const pipelinesList = $("#palette-pipelines");

  // Modelos descargados
  const models = state.models.filter((m) => m.loaded);
  if (models.length > 0) {
    modelsSection.hidden = false;
    modelsList.innerHTML = models
      .map(
        (m) =>
          `<li><button type="button" class="palette-item" draggable="true"
            data-preset="llm" data-model="${esc(m.id)}">${esc(m.id)}</button></li>`,
      )
      .join("");
    modelsList.querySelectorAll(".palette-item").forEach((item) => {
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", `llm_call:${item.dataset.model}`);
        e.dataTransfer.effectAllowed = "copy";
      });
      item.addEventListener("click", () => {
        addNode("llm_call", clickPosition(), item.dataset.model);
      });
    });
  } else {
    modelsSection.hidden = true;
    modelsList.innerHTML = "";
  }

  // Pipelines registrados
  if (state.pipelines.length > 0) {
    pipelinesSection.hidden = false;
    pipelinesList.innerHTML = state.pipelines
      .map(
        (p) =>
          `<li><button type="button" class="palette-item" draggable="true"
            data-preset="pipeline" data-pipeline="${esc(p.id)}">${esc(p.id)}</button></li>`,
      )
      .join("");
    pipelinesList.querySelectorAll(".palette-item").forEach((item) => {
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", `pipeline:${item.dataset.pipeline}`);
        e.dataTransfer.effectAllowed = "copy";
      });
      item.addEventListener("click", () => {
        addNode("pipeline", clickPosition(), item.dataset.pipeline);
      });
    });
  } else {
    pipelinesSection.hidden = true;
    pipelinesList.innerHTML = "";
  }
}

// ── Drop en el lienzo ─────────────────────────────────────────────────────
canvas.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

canvas.addEventListener("drop", (e) => {
  e.preventDefault();
  const raw = e.dataTransfer.getData("text/plain");
  if (!raw) return;
  const pos = screenToGraph(e.clientX, e.clientY);
  // Formato: "tipo" o "tipo:valor" (ej. "llm_call:Qwen2.5-Coder-3B-Instruct")
  if (raw.includes(":")) {
    const [type, value] = raw.split(":", 2);
    addNode(type, pos, value);
  } else {
    addNode(raw, pos);
  }
});

// ── Helpers de viewport (pan/zoom) ────────────────────────────────────────
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

// Pan del lienzo arrastrando el fondo vacio.
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

// Manejo global de puntero para arrastrar nodos y conexiones temporales.
svg.addEventListener("pointermove", onPointerMove);
svg.addEventListener("pointerup", onPointerUp);
svg.addEventListener("pointercancel", onPointerUp);

// Accesibilidad: insercion por teclado con lienzo enfocado.
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

function addNode(type, at, presetValue) {
  const id = `n${state.nextId++}`;
  const node = createNode(type, id);
  if (at) node.pos = { x: at.x, y: at.y };
  // Pre-configurar modelo o pipeline si se arrastro un bloque preset.
  if (type === "llm_call" && presetValue) node.model = presetValue;
  if (type === "pipeline" && presetValue) node.pipeline = presetValue;
  state.nodes.push(node);
  state.selectedId = id;
  markDirty();
  render();
  if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
  openInspector(node);
}

/** Agregar un bloque al cuerpo de un loop (boton + del contenedor o drop de
 * la paleta). El bloque queda posicionado por la pila automatica. */
function addToLoop(loopId, type = "llm_call", presetValue) {
  const loop = findNode(loopId);
  if (!loop || loop.type !== "loop") return;
  const id = `n${state.nextId++}`;
  const node = createNode(type, id);
  if (type === "llm_call" && presetValue) node.model = presetValue;
  if (type === "pipeline" && presetValue) node.pipeline = presetValue;
  node.pos = { x: 0, y: 0 }; // stackLoopMembers lo reubica debajo del header
  state.nodes.push(node);
  if (!Array.isArray(loop.body)) loop.body = [];
  loop.body.push(id);
  state.selectedId = id;
  markDirty();
  render();
  if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
  openInspector(loop);
}

function removeNode(id) {
  const { nodes, edges } = deleteNode(state.nodes, state.edges, id);
  state.nodes = nodes;
  state.edges = edges;
  inspectorTabs.delete(id);
  if (state.selectedId === id) state.selectedId = null;
  markDirty();
  render();
  if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
  $("#inspector-empty").hidden = false;
  $("#inspector-body").hidden = true;
}

// ── Renderizado SVG del grafo ─────────────────────────────────────────────
function socketRoles(node) {
  return {
    input: node.type !== "start",
    output: node.type !== "end",
  };
}

function canConnect(fromNode, toNode) {
  if (!fromNode || !toNode) return false;
  if (fromNode.id === toNode.id) return false;
  if (fromNode.type === "end") return false;
  if (toNode.type === "start") return false;
  return true;
}

/** Nombre amigable para un bloque: modelo para LLM, pipeline invocado para
 * composicion, label propio para los demas. No el id interno (n1, n2...). */
function nodeChipLabel(node) {
  switch (node.type) {
    case "llm_call":
      return node.model ?? "Llamada LLM";
    case "pipeline":
      return node.pipeline ?? "Pipeline";
    case "start":
      return "Inicio";
    case "end":
      return "Fin";
    case "condition":
      return "Condicion";
    case "loop":
      return "Bucle";
    default:
      return node.type;
  }
}

/** Tira de chips encima del canvas: uno por bloque del grafo, con el nombre
 * visible (modelo / pipeline invocado). Clic selecciona y abre el inspector. */
function renderNodeSwitcher() {
  const host = $("#node-switcher");
  if (!host) return;
  host.innerHTML = state.nodes
    .map((n) => {
      const active = n.id === state.selectedId ? " active" : "";
      const title = `${n.id} \u00b7 ${n.type}`;
      return `<button type="button" class="node-chip${active}" role="tab" aria-selected="${n.id === state.selectedId ? "true" : "false"}" data-node-chip="${esc(n.id)}" title="${esc(title)}">${esc(nodeChipLabel(n))}</button>`;
    })
    .join("");
  host.querySelectorAll("[data-node-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const target = findNode(chip.dataset.nodeChip);
      if (!target) return;
      state.selectedId = target.id;
      render();
      openInspector(target);
    });
  });
  // Al cambiar la seleccion, el chip activo vuelve a estar visible en el carrusel.
  if (state.selectedId !== renderNodeSwitcher._lastSel) {
    renderNodeSwitcher._lastSel = state.selectedId;
    const active = host.querySelector(".node-chip.active");
    active?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }
  updateSwitcherOverflow();
}

/** Refleja el estado del scroll del carrusel: fades y flechas visibles solo
 * cuando hay contenido oculto hacia ese lado. */
function updateSwitcherOverflow() {
  const host = $("#node-switcher");
  if (!host) return;
  const wrap = host.closest(".node-switcher-wrap");
  const hasLeft = host.scrollLeft > 2;
  const hasRight = host.scrollLeft + host.clientWidth < host.scrollWidth - 2;
  wrap?.classList.toggle("has-left", hasLeft);
  wrap?.classList.toggle("has-right", hasRight);
}

/** Bindings fijos del carrusel: flechas, scroll y teclado entre chips. */
function registerSwitcher() {
  const host = $("#node-switcher");
  if (!host) return;
  const prev = $("#switcher-prev");
  const next = $("#switcher-next");
  const shift = (dir) => host.scrollBy({ left: dir * host.clientWidth * 0.7, behavior: "smooth" });
  prev?.addEventListener("click", () => shift(-1));
  next?.addEventListener("click", () => shift(1));
  host.addEventListener("scroll", updateSwitcherOverflow, { passive: true });
  window.addEventListener("resize", updateSwitcherOverflow);
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const chips = [...host.querySelectorAll("[data-node-chip]")];
    const idx = chips.indexOf(document.activeElement);
    if (idx === -1) return;
    ev.preventDefault();
    const target = ev.key === "ArrowRight" ? Math.min(idx + 1, chips.length - 1) : Math.max(idx - 1, 0);
    chips[target].focus();
    chips[target].scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    updateSwitcherOverflow();
  });
}

// Largo maximo de los previews vivientes dentro de los nodos SVG. La frase
// completa la arma graph-model (describeLlmCall/describePipeline/describeLoop);
// aca solo se recorta para que entre en el ancho del nodo (NODE_W 160px).
const MAX_NODE_PREVIEW = 20;
function shortText(text, max) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}\u2026` : text;
}

function render() {
  svg.replaceChildren();
  // Los miembros del loop se apilan automaticamente (no se mueven a mano).
  state.nodes = stackLoopMembers(state.nodes);
  const pos = layoutGraph(state.nodes, state.edges);
  state.nodes = state.nodes.map((n) => (n.pos ? n : { ...n, pos: pos.get(n.id) ?? { x: 40, y: 40 } }));

  // El switcher solo necesita re-renderizarse cuando cambian los bloques o la
  // seleccion — no en cada frame de drag/zoom.
  const sig = state.nodes.map((n) => `${n.id}|${nodeChipLabel(n)}`).join(";") + "#" + (state.selectedId ?? "");
  if (sig !== render._switcherSig) {
    render._switcherSig = sig;
    renderNodeSwitcher();
  }

  const vp = document.createElementNS(NS, "g");
  vp.setAttribute("data-viewport", "true");
  vp.setAttribute("transform", graphTransform());
  svg.appendChild(vp);

  // Aristas (detras de los nodos) como curvas bezier libres.
  const byFrom = new Map();
  for (const e of state.edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e);
  }
  for (const e of state.edges) {
    const an = state.nodes.find((n) => n.id === e.from);
    const bn = state.nodes.find((n) => n.id === e.to);
    if (!an?.pos || !bn?.pos) continue;
    const a = outSocketFor(an, an.pos, e.guard);
    const b = socketPositions(bn.pos).in;
    const path = document.createElementNS(NS, "path");
    const guardClass = e.guard ? ` edge-line--${e.guard}` : "";
    path.setAttribute("class", `edge-line${guardClass}`);
    path.setAttribute("d", bezierEdge(a.x, a.y, b.x, b.y));
    path.setAttribute("data-from", e.from);
    path.setAttribute("data-to", e.to);
    vp.appendChild(path);
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
      markDirty();
      render();
    });
    vp.appendChild(del);
  }

  // Contenedores de loop (detras de los nodos, encima de las aristas): el
  // bucle se ve como una caja que envuelve a sus bloques internos y crece
  // hacia abajo a medida que se agregan miembros.
  for (const n of state.nodes) {
    if (n.type !== "loop") continue;
    const rect = loopBodyRect(n, state.nodes);
    if (!rect) continue;
    const cg = document.createElementNS(NS, "g");
    cg.setAttribute("class", "loop-container-group");
    cg.setAttribute("data-id", n.id);

    const box = document.createElementNS(NS, "rect");
    box.setAttribute("class", "loop-container");
    box.setAttribute("x", String(rect.x));
    box.setAttribute("y", String(rect.y));
    box.setAttribute("width", String(rect.width));
    box.setAttribute("height", String(rect.height));
    box.setAttribute("rx", "14");
    cg.appendChild(box);

    const title = document.createElementNS(NS, "text");
    title.setAttribute("class", "loop-container-title");
    title.setAttribute("x", String(rect.x + 14));
    title.setAttribute("y", String(rect.y + 18));
    const members = (n.body ?? []).length;
    title.textContent = `Bucle ${members > 0 ? `- ${members} bloque(s)` : ""}`;
    cg.appendChild(title);

    const hint = document.createElementNS(NS, "text");
    hint.setAttribute("class", "loop-container-hint");
    hint.setAttribute("x", String(rect.x + rect.width - 12));
    hint.setAttribute("y", String(rect.y + 18));
    hint.setAttribute("text-anchor", "end");
    // Preview viviente de la condicion de salida (lenguaje natural), igual
    // que en el nodo: se reemplaza el texto generico por la frase truncada.
    const loopCondPreview = describeLoop(n);
    hint.textContent = loopCondPreview
      ? shortText(loopCondPreview, MAX_NODE_PREVIEW)
      : members > 0
        ? "sin conexiones: el orden lo dan las flechas"
        : "hace clic en + para agregar";
    cg.appendChild(hint);

    // Boton visual para agregar un bloque al cuerpo del loop.
    const addBtn = document.createElementNS(NS, "g");
    addBtn.setAttribute("class", "loop-add");
    addBtn.setAttribute("data-loop-id", n.id);
    const addBg = document.createElementNS(NS, "rect");
    addBg.setAttribute("x", String(rect.x + 12));
    addBg.setAttribute("y", String(rect.y + rect.height - 30));
    addBg.setAttribute("width", String(rect.width - 24));
    addBg.setAttribute("height", "22");
    addBg.setAttribute("rx", "6");
    addBtn.appendChild(addBg);
    const addLbl = document.createElementNS(NS, "text");
    addLbl.setAttribute("x", String(rect.x + rect.width / 2));
    addLbl.setAttribute("y", String(rect.y + rect.height - 15));
    addLbl.setAttribute("text-anchor", "middle");
    addLbl.textContent = members > 0 ? "+ Agregar otro bloque" : "+ Agregar bloque";
    addBtn.appendChild(addLbl);
    addBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      addToLoop(n.id);
    });
    cg.appendChild(addBtn);

    // Soltar un bloque de la paleta dentro del contenedor lo agrega al body.
    cg.addEventListener("dragover", (ev) => {
      const types = (ev.dataTransfer?.types ?? []).map((t) => String(t));
      if (!types.includes("text/plain")) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      cg.classList.add("loop-drop-target");
      // El drop se resuelve aca; no dejar que el drop del lienzo lo duplique.
      ev.stopPropagation();
    });
    cg.addEventListener("dragleave", (ev) => {
      if (cg.contains(ev.relatedTarget)) return;
      cg.classList.remove("loop-drop-target");
    });
    cg.addEventListener("drop", (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // No dejar que el handler del lienzo cree un segundo nodo.
      cg.classList.remove("loop-drop-target");
      const payload = ev.dataTransfer.getData("text/plain");
      if (!payload) return;
      const [kind, value] = payload.split(":");
      const type = kind === "llm_call" ? "llm_call" : kind === "pipeline" ? "pipeline" : kind;
      if (!createNode(type).type) return;
      addToLoop(n.id, type, value);
    });

    cg.addEventListener("click", (ev) => {
      if (ev.target.closest(".graph-node")) return;
      state.selectedId = n.id;
      render();
      openInspector(n);
    });
    vp.appendChild(cg);
  }

  // Nodos
  // Mientras se arrastra una conexion, detectar el puerto de entrada mas
  // cercano dentro del radio de tolerancia para resaltarlo como destino.
  const nearInput = state.connect && !state.connect.done
    ? nearestInputSocket({ x: state.connect.x, y: state.connect.y }, SOCKET_HIT_RADIUS / state.view.scale)
    : null;
  for (const n of state.nodes) {
    const p = n.pos ?? { x: 40, y: 40 };
    // Los miembros de un loop no tienen sockets (la secuencia la dicta el
    // body, no las conexiones) ni badges de orden.
    const inLoop = ownerLoopId(state.nodes, n.id);
    const roles = inLoop ? { input: false, output: false } : socketRoles(n);
    const bodyIndex = inLoop
      ? (state.nodes.find((x) => x.id === inLoop)?.body ?? []).indexOf(n.id)
      : -1;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "graph-node");
    g.setAttribute("data-id", n.id);
    g.setAttribute("data-type", n.type);
    if (inLoop) g.setAttribute("data-member-of", inLoop);
    if (state.selectedId === n.id) g.setAttribute("class", "graph-node selected");

    const box = document.createElementNS(NS, "rect");
    box.setAttribute("class", "node-box");
    box.setAttribute("data-type", n.type);
    box.setAttribute("x", String(p.x));
    box.setAttribute("y", String(p.y));
    box.setAttribute("width", String(NODE_W));
    box.setAttribute("height", String(NODE_H));
    box.setAttribute("rx", "8");

    // Badge de orden para miembros del loop (la secuencia es explicita).
    if (inLoop && bodyIndex >= 0) {
      const badge = document.createElementNS(NS, "circle");
      badge.setAttribute("class", "node-order-badge");
      badge.setAttribute("cx", String(p.x + 10));
      badge.setAttribute("cy", String(p.y + 10));
      badge.setAttribute("r", "8");
      badge.setAttribute("pointer-events", "none");
      g.appendChild(badge);
      const badgeLbl = document.createElementNS(NS, "text");
      badgeLbl.setAttribute("class", "node-order-label");
      badgeLbl.setAttribute("x", String(p.x + 10));
      badgeLbl.setAttribute("y", String(p.y + 13));
      badgeLbl.setAttribute("text-anchor", "middle");
      badgeLbl.setAttribute("pointer-events", "none");
      badgeLbl.textContent = String(bodyIndex + 1);
      g.appendChild(badgeLbl);
    }

    const lbl = document.createElementNS(NS, "text");
    lbl.setAttribute("class", "node-label");
    lbl.setAttribute("x", String(p.x + NODE_W / 2));
    lbl.setAttribute("y", String(p.y + 24));
    lbl.setAttribute("text-anchor", "middle");
    const missing = isCompleteNode(n) ? "" : " \u00b7";
    lbl.textContent = `${n.type}${missing}`;

    // Subtitulo vivo (lenguaje del nodo): preview legible de lo que hara el
    // bloque. Debe ir DESPUES del rect para renderizar encima.
    let subLbl = null;
    const liveText = n.type === "llm_call"
      ? describeLlmCall(n)
      : n.type === "pipeline"
        ? describePipeline(n)
        : "";
    if (liveText) {
      subLbl = document.createElementNS(NS, "text");
      subLbl.setAttribute("class", `node-sub node-sub--${n.type}`);
      subLbl.setAttribute("x", String(p.x + NODE_W / 2));
      subLbl.setAttribute("y", String(p.y + NODE_H - 14));
      subLbl.setAttribute("text-anchor", "middle");
      subLbl.textContent = shortText(liveText, MAX_NODE_PREVIEW);
    }

    // Preview legible de la condicion bajo el titulo (condition y loop usan
    // el mismo AST; el loop muestra su condicion de salida).
    let condSub = null;
    if ((n.type === "condition" || n.type === "loop") && n.condition) {
      const condText = n.type === "loop" ? describeLoop(n) : describeCondition(n.condition);
      if (condText) {
        condSub = document.createElementNS(NS, "text");
        condSub.setAttribute("class", `node-sub node-sub--${n.type}`);
        condSub.setAttribute("x", String(p.x + NODE_W / 2));
        condSub.setAttribute("y", String(p.y + NODE_H - 14));
        condSub.setAttribute("text-anchor", "middle");
        condSub.textContent = shortText(condText, MAX_NODE_PREVIEW);
      }
    }

    // Puertos de conexion estilo Blender/Godot.
    const sp = socketPositions(p);
    if (roles.input) {
      const inSock = document.createElementNS(NS, "circle");
      inSock.setAttribute("class", "socket socket-in");
      inSock.setAttribute("cx", String(sp.in.x));
      inSock.setAttribute("cy", String(sp.in.y));
      inSock.setAttribute("r", "7");
      inSock.setAttribute("data-role", "input");
      if (nearInput === n.id) inSock.classList.add("socket-hot");
      g.appendChild(inSock);
    }
    if (roles.output) {
      if (n.type === "condition") {
        const cs = conditionSockets(p);
        const branches = [
          { guard: "true", y: cs.outTrue.y },
          { guard: "false", y: cs.outFalse.y },
        ];
        for (const br of branches) {
          const outSock = document.createElementNS(NS, "circle");
          outSock.setAttribute("class", `socket socket-out socket-out--${br.guard}`);
          outSock.setAttribute("cx", String(cs.outTrue.x));
          outSock.setAttribute("cy", String(br.y));
          outSock.setAttribute("r", "7");
          outSock.setAttribute("data-role", "output");
          outSock.setAttribute("data-guard", br.guard);
          outSock.addEventListener("pointerdown", (ev) => startConnect(ev, n.id, br.guard));
          g.appendChild(outSock);
        }
        // Etiquetas de rama junto a los sockets: Si arriba (true), No abajo.
        const trueLbl = document.createElementNS(NS, "text");
        trueLbl.setAttribute("class", "node-branch-label node-branch-label--true");
        trueLbl.setAttribute("x", String(cs.outTrue.x + 10));
        trueLbl.setAttribute("y", String(cs.outTrue.y + 4));
        trueLbl.setAttribute("pointer-events", "none");
        trueLbl.textContent = "S\u00ed";
        g.appendChild(trueLbl);

        const falseLbl = document.createElementNS(NS, "text");
        falseLbl.setAttribute("class", "node-branch-label node-branch-label--false");
        falseLbl.setAttribute("x", String(cs.outFalse.x + 10));
        falseLbl.setAttribute("y", String(cs.outFalse.y + 4));
        falseLbl.setAttribute("pointer-events", "none");
        falseLbl.textContent = "No";
        g.appendChild(falseLbl);
      } else {
        const outSock = document.createElementNS(NS, "circle");
        outSock.setAttribute("class", "socket socket-out");
        outSock.setAttribute("cx", String(sp.out.x));
        outSock.setAttribute("cy", String(sp.out.y));
        outSock.setAttribute("r", "7");
        outSock.setAttribute("data-role", "output");
        outSock.addEventListener("pointerdown", (ev) => startConnect(ev, n.id));
        g.appendChild(outSock);
      }
    }

    // Boton de eliminar (se agrega al FINAL del grupo: el rect del cuerpo lo
    // taparia si quedara antes en el DOM, y seria imposible clickearlo).
    const delBtn = document.createElementNS(NS, "circle");
    delBtn.setAttribute("class", "node-delete");
    delBtn.setAttribute("cx", String(p.x + NODE_W - 12));
    delBtn.setAttribute("cy", String(p.y + 12));
    delBtn.setAttribute("r", "8");
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeNode(n.id);
    });
    const delGlyph = document.createElementNS(NS, "path");
    delGlyph.setAttribute("class", "node-delete-glyph");
    delGlyph.setAttribute(
      "d",
      `M ${p.x + NODE_W - 16} ${p.y + 8} L ${p.x + NODE_W - 8} ${p.y + 16} M ${p.x + NODE_W - 8} ${p.y + 8} L ${p.x + NODE_W - 16} ${p.y + 16}`,
    );
    delGlyph.setAttribute("pointer-events", "none");
    g.appendChild(delGlyph);

    // Click en el cuerpo selecciona el nodo.
    g.addEventListener("click", (ev) => {
      if (ev.target !== box && ev.target.closest(".socket")) return;
      state.selectedId = n.id;
      render();
      openInspector(n);
    });

    // Arrastrar el cuerpo mueve el nodo — salvo miembros de loop, cuya
    // posicion la decide la pila automatica (el cuerpo solo selecciona).
    g.addEventListener("pointerdown", (ev) => {
      if (inLoop) return;
      if (ev.target.closest(".socket") || ev.target.closest(".node-delete")) return;
      startDragNode(ev, n);
    });

    g.appendChild(box);
    g.appendChild(lbl);
    if (subLbl) g.appendChild(subLbl);
    if (condSub) g.appendChild(condSub);
    g.appendChild(delBtn);
    vp.appendChild(g);
  }

  // Conexion en progreso sigue al puntero.
  if (state.connect) {
    const from = state.nodes.find((n) => n.id === state.connect.from);
    if (from?.pos) {
      const a = outSocketFor(from, from.pos, state.connect.guard);
      const path = document.createElementNS(NS, "path");
      const guardClass = state.connect.guard ? ` edge-line--${state.connect.guard}` : "";
      path.setAttribute("class", `edge-line edge-draft${guardClass}`);
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

// ── Arrastre de nodos ─────────────────────────────────────────────────────
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
  if (state.pan) {
    ev.preventDefault();
    state.view.x = state.pan.baseViewX + (ev.clientX - state.pan.startScreenX);
    state.view.y = state.pan.baseViewY + (ev.clientY - state.pan.startScreenY);
    render();
    return;
  }
  if (state.drag) {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const dx = (ev.clientX - rect.left - state.drag.startX) / state.view.scale;
    const dy = (ev.clientY - rect.top - state.drag.startY) / state.view.scale;
    // Sin limite en (0,0): el espacio es infinito, como en los editores de
    // nodos clasicos. El usuario siempre puede mover el lienzo (pan) para
    // traer de vuelta un nodo que quedo fuera de la vista.
    const nx = state.drag.baseX + dx;
    const ny = state.drag.baseY + dy;
    state.nodes = moveNode(state.nodes, state.drag.id, nx, ny);
    render();
    return;
  }
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
    bucketDroppedNode(state.drag.id);
    state.drag = null;
    svg.classList.remove("dragging");
  }
  if (state.connect && !state.connect.done) {
    // Resolver el destino por DISTANCIA (no por elemento bajo el cursor):
    // conecta al puerto de entrada mas cercano dentro del radio de
    // tolerancia, asi el usuario no necesita acertar el circulito exacto.
    const p = screenToGraph(ev.clientX, ev.clientY);
    const target = nearestInputSocket(p, SOCKET_HIT_RADIUS / state.view.scale);
    if (target) {
      finishConnect(target);
    } else {
      state.connect = null;
      render();
    }
  }
}

// ── Conexion puerto a puerto (estilo Blender/Godot) ───────────────────────
/** Tras arrastrar un nodo: si quedo DENTRO del contenedor de un loop pasa a
 * ser miembro de su body; si quedo FUERA de todos, sale de cualquier body. El
 * contenedor crece (se re-layout-ea solo) al mudar la posicion. */
function bucketDroppedNode(id) {
  const node = findNode(id);
  if (!node || node.type === "loop" || node.type === "start") return;
  const cx = (node.pos?.x ?? 0) + NODE_W / 2;
  const cy = (node.pos?.y ?? 0) + NODE_H / 2;
  const host = state.nodes.find(
    (n) => n.type === "loop" && loopContainsPoint(n, state.nodes, { x: cx, y: cy }),
  );
  const changed = state.nodes.some(
    (n) => n.type === "loop" && (n.body ?? []).includes(id),
  );
  if (host) {
    if (!(host.body ?? []).includes(id)) {
      host.body = [...(host.body ?? []), id];
    }
    // Si estaba en OTRO loop (o en varios), queda solo en el contenedor actual.
    for (const n of state.nodes) {
      if (n.type === "loop" && n.id !== host.id) {
        n.body = (n.body ?? []).filter((b) => b !== id);
      }
    }
  } else if (changed) {
    for (const n of state.nodes) {
      if (n.type === "loop") n.body = (n.body ?? []).filter((b) => b !== id);
    }
  }
}

// ── Conexion puerto a puerto (estilo Blender/Godot) ───────────────────────
function startConnect(ev, fromId, guard) {
  ev.preventDefault();
  ev.stopPropagation();
  const p = screenToGraph(ev.clientX, ev.clientY);
  state.connect = { from: fromId, guard: guard ?? null, x: p.x, y: p.y, done: false };
  svg.setPointerCapture(ev.pointerId);
  svg.classList.add("dragging");
}

function finishConnect(toId) {
  if (!state.connect || state.connect.from === toId) return;
  const fromNode = state.nodes.find((n) => n.id === state.connect.from);
  const toNode = state.nodes.find((n) => n.id === toId);
  if (!canConnect(fromNode, toNode)) {
    state.connect = null;
    svg.classList.remove("dragging");
    render();
    return;
  }
  state.connect.done = true;
  const existing = state.edges.find((e) => e.from === state.connect.from && e.to === toId);
  // El guard arrastrado desde un socket de condicion manda; si no hay socket
  // (nodos normales), se preserva el guard ya existente de la arista.
  const guard = state.connect.guard ?? existing?.guard;
  state.edges = connectNodes(state.edges, state.connect.from, toId, guard);
  state.connect = null;
  svg.classList.remove("dragging");
  markDirty();
  render();
}

// Radio de tolerancia (en px de pantalla) para soltar una conexion sobre un
// puerto de entrada: el puerto VISUAL es pequeno, pero el area de acierto es
// generosa para que el usuario no tenga que apuntar exacto.
const SOCKET_HIT_RADIUS = 24;

// Puerto de entrada mas cercano a un punto (en coordenadas de grafo) dentro
// de `maxDist` (en unidades de grafo). Devuelve el id del nodo o null.
function nearestInputSocket(p, maxDist) {
  let best = null;
  let bestD = maxDist;
  for (const n of state.nodes) {
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

// ── Inspector ────────────────────────────────────────────────────────────
const CONTEXT_STANDARDS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

function modelCtx(id) {
  const m = state.models.find((x) => x.id === id);
  return typeof m?.ctx === "number" ? m.ctx : null;
}

function contextEditorHtml(node) {
  const current = modelCtx(node.model);
  const override = node.params?.ctx;

  const model = state.models.find((m) => m.id === node.model);
  const ggufMax = model?.ggufContextLength;
  const hwMax = model?.hardwareMaxCtx;

  const effectiveMax = ggufMax != null
    ? (hwMax != null ? Math.min(ggufMax, hwMax) : ggufMax)
    : hwMax ?? null;

  const base = (effectiveMax != null
    ? CONTEXT_STANDARDS.filter((c) => c <= effectiveMax)
    : CONTEXT_STANDARDS
  ).map((c) => String(c));

  // El ctx configurado del modelo es una opcion propia del selector, no un
  // "personalizado": evita el doble control (selector + input) cuando el
  // valor del modelo no coincide con un tamano estandar (ej. 102400).
  const currentKey = current != null ? String(current) : null;
  const standards = currentKey && !base.includes(currentKey)
    ? [...base, currentKey]
    : base;

  // Selection: el override explicito del nodo gana; si no hay, el ctx actual.
  let selected = override != null ? String(override) : currentKey;
  let isCustom = false;
  if (selected && !standards.includes(selected)) {
    isCustom = true;
  }

  const isUnsafe = (val) => hwMax != null && Number(val) > hwMax;

  const opts = standards
    .map((c) => {
      const isModelCurrent = currentKey === c && c !== String(override);
      const label = isModelCurrent
        ? `${Number(c).toLocaleString()} (actual del modelo)`
        : `${Number(c).toLocaleString()}${isUnsafe(c) ? " \u26a0" : ""}`;
      return `<option value="${c}" ${selected === c ? "selected" : ""} class="${isUnsafe(c) ? "ctx-unsafe" : ""}">${label}</option>`;
    })
    .join("");
  const currentNote =
    current != null
      ? `<div class="hint">Actual para <strong>${esc(node.model ?? "")}</strong>: ${current.toLocaleString()} tokens.</div>`
      : `<div class="hint">Ventana de contexto (tokens). No se reporta el valor configurado del modelo; la ventana maxima fisica es desconocida.</div>`;

  // El backend corre cada modelo con un ctx EFECTIVO = min(config, limite GGUF,
  // tope por VRAM). Cuando difiere del valor del selector, se avisa.
  const effectiveNote =
    model?.effectiveCtx != null && current != null && model.effectiveCtx !== current
      ? `<div class="hint">Efectivo aplicado en el backend para <strong>${esc(node.model ?? "")}</strong>: ${model.effectiveCtx.toLocaleString()} tokens (${model.effectiveCtx < current ? "recortado" : "elevado"} al arrancar).</div>`
      : "";

  return `<div class="field"><label for="node-ctx">Ventana de contexto</label>
    <select id="node-ctx">
      <option value="" ${selected ? "" : "selected"}>\u2014 heredar / sin valor \u2014</option>
      <option value="custom" ${isCustom ? "selected" : ""}>Personalizado\u2026</option>
      ${opts}
    </select>
    <input id="node-ctx-custom" class="text-input ${isCustom ? "" : "hidden"}" type="number" min="1" step="1" value="${isCustom ? esc(selected) : ""}" aria-label="Ventana de contexto personalizada" />
    ${currentNote}
    ${effectiveNote}
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

  const ctxHtml = node.type === "llm_call" ? contextEditorHtml(node) : "";

  // Pestana activa por nodo (no puede vivir en el nodo: schema estricto).
  const activeTab = inspectorTabs.get(node.id) ?? "basica";
  const tabNames = [
    ["basica", "Config. b\u00e1sica"],
    ["prompt", "Prompt"],
    ["avanzado", "Avanzado"],
  ];
  // Solo las pestañas que aplican a este tipo se muestran; son tres para
  // llm_call y ninguna para start/end.
  const tabKeys = node.type === "llm_call" ? ["basica", "prompt", "avanzado"] : [];
  // Si una pestaña ya no aplica (nodo recargado con otro tipo), caer a basica.
  const effectiveTab = tabKeys.includes(activeTab) ? activeTab : "basica";
  const tabNameOf = (k) => (tabNames.find(([key]) => key === k) ?? [k, k])[1];
  const tabRowHtml =
    tabKeys.length > 0
      ? `<div class="inspector-tabs" role="tablist" aria-label="Opciones del nodo">
           ${tabKeys.map((k) => `<button type="button" class="tab-btn" role="tab" aria-selected="${k === effectiveTab ? "true" : "false"}" data-tab="${k}" aria-controls="tab-panel-${k}">${esc(tabNameOf(k))}</button>`).join("")}
         </div>`
      : "";

  const field = (label, inner, labelFor) =>
    `<div class="field">${labelFor ? `<label for="${labelFor}">${label}</label>` : `<span class="field-label">${label}</span>`}${inner}</div>`;

  const MODES = [
    ["generate", "Generar", "el modelo responde al prompt (historial tal cual)."],
    ["refine", "Refinar", "re-alimenta la \u00faltima respuesta del paso como nueva instrucci\u00f3n."],
    ["passthrough", "Pasar", "replica el texto original sin llamar al modelo."],
  ];
  const baseTab = node.type === "llm_call"
    ? `${field("ID", `<div class="primary">${esc(node.id)}</div>`)}
      ${field("Tipo", `<div>${esc(node.type)}</div>`)}
      ${field("Modelo", `<select id="node-model">${modelOpts}</select>`, "node-model")}
      ${field("Modo", `
        <div class="mode-pills" role="radiogroup" aria-label="Modo de la llamada">
          ${MODES.map(([val, lbl]) => {
            const isSel = (node.mode ?? "generate") === val;
            return `<button type="button" class="mode-pill${isSel ? " is-active" : ""}" role="radio" aria-checked="${isSel ? "true" : "false"}" data-mode="${val}">${esc(lbl)}</button>`;
          }).join("")}
        </div>
        <div class="hint" id="mode-help">${esc(MODES.find(([v]) => v === (node.mode ?? "generate"))?.[2] ?? "")}</div>`)}
      ${ctxHtml}`
    : "";

  const promptTab = node.type === "llm_call"
    ? `${field("Prompt del sistema (opcional)", `
        <textarea id="node-system" rows="4" aria-label="Prompt del sistema">${esc(node.system ?? "")}</textarea>
        <div class="char-counter" id="node-system-count">${node.system ? node.system.length : 0} caracteres</div>`, "node-system")}
      ${field("Scaffold de asistente (opcional)", `
        <textarea id="node-assistant" rows="3" aria-label="Scaffold de asistente">${esc(node.assistant ?? "")}</textarea>
        <div class="hint">Se antepone al historial en modos generar/refinar.</div>
        <div class="char-counter" id="node-assistant-count">${node.assistant ? node.assistant.length : 0} caracteres</div>`, "node-assistant")}`
    : "";

  const targetOpts = (cur) => {
    const opts = state.nodes
      .filter((n) => n.id !== node.id)
      .map((n) => `<option value="${n.id}" ${cur === n.id ? "selected" : ""}>${esc(nodeIdForSelect(n))}</option>`)
      .join("");
    // Ruta huerfana (apunta a un nodo borrado): se muestra y se conserva en
    // vez de perderse silenciosamente; editarla la reemplaza o limpia.
    const orphan = cur ? !state.nodes.some((n) => n.id === cur) : false;
    return opts + (orphan ? `<option value="${cur}" selected>${esc(cur)} (nodo inexistente)</option>` : "");
  };

  const advancedTab = node.type === "llm_call"
    ? `${field("Si responde 429 \u2192 (opcional)", `
        <select id="node-on-429"><option value="" ${!node.on_429 ? "selected" : ""}>\u2014 sin ruta \u2014</option>${targetOpts(node.on_429)}</select>
        <div class="hint">Cuando el modelo responde con un c\u00f3digo 429 (l\u00edmite de velocidad), continuar desde este nodo.</div>`, "node-on-429")}
      ${field("Si responde con tool_calls \u2192 (opcional)", `
        <select id="node-tool-calls-route"><option value="" ${!node.tool_calls_route ? "selected" : ""}>\u2014 sin ruta \u2014</option>${targetOpts(node.tool_calls_route)}</select>
        <div class="hint">Cuando el modelo pide herramientas, continuar desde este nodo (con los resultados disponibles como contexto).</div>`, "node-tool-calls-route")}
      ${field("Proveedor (opcional)", `
        <input id="node-provider" class="text-input" type="text" value="${esc(node.provider ?? "")}" placeholder="llama-server" aria-label="Proveedor" />
        <div class="hint">Proveedor que ejecuta este nodo; vac\u00edo usa el de la pipeline (por defecto llama-server). Sin una lista fiable en el estado, se escribe a mano.</div>`, "node-provider")}`
    : "";

  const paramsHtml = (node) =>
    `<div class="field"><span class="field-label">Par\u00e1metros del pipeline (opcional)</span>
      <div class="hint">Pasamos estos <code>clave=valor</code> como opciones de ejecuci\u00f3n del pipeline invocado.</div>
      <div class="param-rows" id="param-rows">
        ${paramsToRows(node.params).map((row, idx) => paramRowHtml(row, idx)).join("")}
      </div>
      <button type="button" class="btn btn-ghost" id="params-add">+ Agregar par\u00e1metro</button>
      <div class="cond-row-error param-rows-error" hidden>Complet\u00e1 la clave de cada par\u00e1metro (la fila vac\u00eda se descarta al guardar).</div>
    </div>`;

  const connectionCnx = `<div class="field"><span class="field-label">Conexi\u00f3n</span>
      <div class="hint">Arrastra el puerto derecho (<b>\u25cf</b>) de un nodo sobre el puerto izquierdo (<b>\u25cf</b>) de otro para conectarlos. Arrastra por el cuerpo para mover.</div>
    </div>`;

  const guardField =
    node.type === "llm_call" || node.type === "pipeline"
      ? `${field("Guardia de salida (rama)", `
          <select id="node-guard"><option value="">\u2014 sin guardia \u2014</option>
          <option value="true" ${nodeEdgeGuard(node) === "true" ? "selected" : ""}>S\u00ed (true)</option>
          <option value="false" ${nodeEdgeGuard(node) === "false" ? "selected" : ""}>No (false)</option></select>
          <div class="hint">Marca la arista saliente como rama S\u00ed/No; \u00fatil cuando este nodo est\u00e1 seguido por una condici\u00f3n.</div>`, "node-guard")} `
      : "";

  const endpointCnx = node.type === "start"
    ? `<div class="field"><span class="field-label">Inicio</span><div class="hint">El pipeline arranca ac\u00e1.</div></div>`
    : node.type === "end"
      ? `<div class="field"><span class="field-label">Fin</span><div class="hint">El pipeline termina ac\u00e1.</div></div>`
      : "";

  const conditionArea =
    node.type === "condition" || node.type === "loop"
      ? `<div class="field">
           <span class="field-label" id="cond-label-${node.id}">${node.type === "loop" ? "Condici\u00f3n de salida" : "Condici\u00f3n"}</span>
           ${node.type === "loop" ? `<div class="hint">Escrita en lenguaje natural; el bucle sale apenas se cumple. Sin condici\u00f3n, corre hasta el tope. El orden del cuerpo lo dan las flechas.</div>` : ""}
           <div class="ast-builder" id="cond-builder-${node.id}" aria-labelledby="cond-label-${node.id}">
             ${conditionBuilderHtml(node)}
           </div>
         </div>`
      : "";

  const loopMembers =
    node.type === "loop"
      ? `<div class="field"><span class="field-label">Bloques internos</span>
           <div class="hint">Los bloques del bucle se encadenan en orden: no hace falta conectarlos. Usa las flechas para cambiar el orden.</div>
           <div class="loop-members">${(node.body ?? []).length > 0 ? (node.body ?? []).map((b, i) => { const m = findNode(b); return `<div class="loop-member-row" data-member="${esc(b)}">
             <span class="loop-member-index">${i + 1}</span>
             <span class="loop-member-name">${esc(m ? nodeChipLabel(m) : b)}</span>
             <button type="button" class="icon-btn" data-member-up="${esc(b)}" title="Mover arriba" aria-label="Mover arriba">\u2191</button>
             <button type="button" class="icon-btn" data-member-down="${esc(b)}" title="Mover abajo" aria-label="Mover abajo">\u2193</button>
             <button type="button" class="icon-btn" data-member-remove="${esc(b)}" title="Quitar del bucle" aria-label="Quitar del bucle">\u00d7</button>
           </div>`; }).join("") : `<span class="loop-members-empty">sin bloques adentro aun</span>`}
           </div>
           <button type="button" class="btn btn-ghost" id="loop-add-block">+ Agregar bloque</button>
         </div>`
      : "";

  // ── Bloque de pestañas ────────────────────────────────────────────────
  // Se renderizan las 3 pestañas en el DOM con la activa visible (hidden en
  // las otras) para que los controles conserven su estado al alternar.
  let paneHtml = "";
  if (tabKeys.length > 0) {
    paneHtml = [
      ["basica", baseTab, "b\u00e1sica"],
      ["prompt", promptTab, "prompt"],
      ["avanzado", advancedTab, "avanzado"],
    ]
      .filter(([k]) => tabKeys.includes(k))
      .map(
        ([key, html, label]) =>
          `<div class="inspector-tab-panel" role="tabpanel" aria-label="${esc(label)}" data-tab-panel="${key}"${key === effectiveTab ? "" : " hidden"}>${html}</div>`,
      )
      .join("");
  } else {
    // Sin pestañas: pipeline agrega nombre + params; los demas (start/end/loop)
    // muestran sus campos especificos. El guardia solo aplica a llm_call y
    // pipeline, que no vienen por aca salvo que no tengan tabs (no es el caso).
    paneHtml = `${node.type === "pipeline" ? `${field("Pipeline", `<input id="node-pipeline" class="text-input" type="text" value="${esc(node.pipeline ?? "")}" aria-label="Nombre del pipeline" />`, "node-pipeline")}${paramsHtml(node)}` : ""}
      ${conditionArea}
      ${loopMembers}
      ${guardField}
      ${connectionCnx}
      ${endpointCnx}`;
  }

  body.innerHTML = tabRowHtml + paneHtml;
  body.dataset.nodeId = node.id;

  // Alternar pestañas (aplica a llm_call): guarda la activa en el Map por nodo.
  const tabBtns = [...body.querySelectorAll("[data-tab]")];
  const activateTab = (tab, focus = false) => {
    inspectorTabs.set(node.id, tab);
    tabBtns.forEach((b) => {
      const sel = b.dataset.tab === tab;
      b.classList.toggle("is-active", sel);
      b.setAttribute("aria-selected", sel ? "true" : "false");
    });
    body.querySelectorAll("[data-tab-panel]").forEach((p) => {
      p.hidden = p.dataset.tabPanel !== tab;
    });
    if (focus) {
      // El primer foco de la pestaña recien activada queda en el primer control.
      body.querySelector(`[data-tab-panel="${tab}"]`)?.querySelector("input, select, textarea, button")?.focus();
    }
  };
  tabBtns.forEach((btn, i) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    btn.addEventListener("keydown", (ev) => {
      // Flechas izquierda/derecha rotan entre pestañas (patron ARIA tabs).
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const dir = ev.key === "ArrowRight" ? 1 : -1;
      const next = tabBtns[(i + dir + tabBtns.length) % tabBtns.length];
      activateTab(next.dataset.tab, true);
    });
  });

  if (node.type === "loop") {
    const reorder = (memberId, dir) => {
      const loop = findNode(node.id);
      if (!loop || !Array.isArray(loop.body)) return;
      const i = loop.body.indexOf(memberId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= loop.body.length) return;
      [loop.body[i], loop.body[j]] = [loop.body[j], loop.body[i]];
      render();
      openInspector(loop);
    };
    body.querySelectorAll("[data-member-up]").forEach((b) =>
      b.addEventListener("click", () => reorder(b.dataset.memberUp, -1)),
    );
    body.querySelectorAll("[data-member-down]").forEach((b) =>
      b.addEventListener("click", () => reorder(b.dataset.memberDown, 1)),
    );
    body.querySelectorAll("[data-member-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        const loop = findNode(node.id);
        if (!loop || !Array.isArray(loop.body)) return;
        loop.body = loop.body.filter((x) => x !== b.dataset.memberRemove);
        render();
        openInspector(loop);
      }),
    );
    const addBlock = $("#loop-add-block");
    addBlock?.addEventListener("click", () => addToLoop(node.id));
  }

  if (node.type === "condition" || node.type === "loop") {
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
    // Pills de modo: escribir n.mode SOLO si difiere del default "generate"
    // (payload minimo); si eligen Generar, se borra el campo. El inspector no
    // se re-renderiza con render(), asi que el estado visual se actualiza aca.
    body.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const n = findNode(node.id);
        if (!n) return;
        const mode = btn.dataset.mode;
        if (mode === "generate") delete n.mode;
        else n.mode = mode;
        render();
        body.querySelectorAll("[data-mode]").forEach((b) => {
          const sel = b === btn;
          b.classList.toggle("is-active", sel);
          b.setAttribute("aria-checked", sel ? "true" : "false");
        });
        const help = $("#mode-help");
        if (help) help.textContent = MODES.find(([v]) => v === mode)?.[2] ?? "";
      });
    });
    // Textos del nodo: system / assistant — borrar si quedan vacios.
    const wireText = (nodeKey, id) => {
      const el = $(`#${id}`);
      if (!el) return {};
      const counter = $(`#${id}-count`);
      const apply = () => {
        const n = findNode(node.id);
        if (!n) return;
        const v = el.value.trim();
        if (v) n[nodeKey] = v;
        else delete n[nodeKey];
        if (counter) counter.textContent = `${el.value.length} caracteres`;
        render();
      };
      el.addEventListener("input", apply);
      return { apply };
    };
    wireText("system", "node-system");
    wireText("assistant", "node-assistant");
    // Ruta 429 / tool_calls hacia otro nodo del grafo.
    const wireTarget = (nodeKey, id) => {
      const el = $(`#${id}`);
      if (!el) return;
      el.addEventListener("change", () => {
        const n = findNode(node.id);
        if (!n) return;
        if (el.value) n[nodeKey] = el.value;
        else delete n[nodeKey];
        render();
      });
    };
    wireTarget("on_429", "node-on-429");
    wireTarget("tool_calls_route", "node-tool-calls-route");
    // Proveedor (input honesto, sin select mentiroso).
    const provEl = $("#node-provider");
    provEl?.addEventListener("input", () => {
      const n = findNode(node.id);
      if (!n) return;
      const v = provEl.value.trim();
      if (v) n.provider = v;
      else delete n.provider;
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
    // Filas-pildora clave=valor para params.
    const rowsHost = $("#param-rows");
    const errorEl = $(".param-rows-error");
    const applyParams = () => {
      const n = findNode(node.id);
      if (!n) return;
      const rows = [...(rowsHost?.querySelectorAll(".param-row") ?? [])].map((row) => ({
        key: row.querySelector(".param-key")?.value ?? "",
        value: row.querySelector(".param-value")?.value ?? "",
      }));
      // Honestidad: la fila con clave vacia se marca en rojo y se descarta al
      // serializar (rowsToParams la filtra); nunca se escribe un string vacio.
      const invalid = rows.filter((r) => r.key.trim() === "").length > 0;
      (rowsHost?.querySelectorAll(".param-row") ?? []).forEach((row) =>
        row.classList.toggle("param-row--invalid", (row.querySelector(".param-key")?.value ?? "").trim() === ""),
      );
      if (errorEl) errorEl.hidden = !invalid;
      const params = rowsToParams(rows);
      if (Object.keys(params).length > 0) n.params = params;
      else delete n.params;
      render();
    };
    const makeRowEl = (row = { key: "", value: "" }) => {
      const div = document.createElement("div");
      div.className = "param-row";
      div.innerHTML = `
        <input class="param-key text-input" type="text" value="${esc(row.key)}" placeholder="clave" aria-label="Clave del par\u00e1metro" />
        <input class="param-value text-input" type="text" value="${esc(row.value)}" placeholder="valor" aria-label="Valor del par\u00e1metro" />
        <button type="button" class="param-row-remove" title="Quitar par\u00e1metro" aria-label="Quitar par\u00e1metro">\u00d7</button>`;
      return div;
    };
    const wireRow = (rowEl) => {
      rowEl.querySelector(".param-key")?.addEventListener("input", applyParams);
      rowEl.querySelector(".param-value")?.addEventListener("input", applyParams);
      rowEl.querySelector(".param-row-remove")?.addEventListener("click", () => {
        rowEl.remove();
        if (rowsHost && rowsHost.children.length === 0) {
          const fresh = makeRowEl();
          rowsHost.appendChild(fresh);
          wireRow(fresh);
        }
        applyParams();
        rowEl.nextElementSibling?.querySelector(".param-key")?.focus()
          ?? rowsHost?.querySelector(".param-key")?.focus();
      });
    };
    // Filas iniciales (desde paramsToRows) y cualquier fila futura comparten
    // el mismo wiring; las filas viven en el DOM, nunca en un draft del nodo.
    (rowsHost?.querySelectorAll(".param-row") ?? []).forEach(wireRow);
    $("#params-add")?.addEventListener("click", () => {
      if (!rowsHost) return;
      if (rowsHost.children.length === 0 || (rowsHost.querySelector(".param-key")?.value ?? "") !== "") {
        const fresh = makeRowEl();
        rowsHost.appendChild(fresh);
        wireRow(fresh);
      }
      rowsHost.querySelector(".param-key:last-of-type")?.focus();
    });
    applyParams();
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

/** Renders a single key/value param row for the pipeline inspector. */
function paramRowHtml(row, idx) {
  return `
    <div class="param-row" data-param-idx="${idx}">
      <input class="param-key text-input" type="text" value="${esc(row.key)}" placeholder="clave" aria-label="Clave del par\u00e1metro ${idx + 1}" />
      <input class="param-value text-input" type="text" value="${esc(row.value)}" placeholder="valor" aria-label="Valor del par\u00e1metro ${idx + 1}" />
      <button type="button" class="param-row-remove" title="Quitar par\u00e1metro" aria-label="Quitar par\u00e1metro">\u00d7</button>
    </div>`;
}

/** Select label for a node-destination option (human label + id fallback). */
function nodeIdForSelect(n) {
  const label = nodeChipLabel(n);
  return label === n.id ? label : `${label} (${n.id})`;
}

function nodeEdgeGuard(node) {
  const edge = state.edges.find((e) => e.from === node.id);
  return edge ? edge.guard ?? "" : "";
}

function findNode(id) {
  return state.nodes.find((n) => n.id === id);
}

// ── Constructor de condiciones ("pildoras") ──────────────────────────────
const COND_DEFAULT_FIELD = "lastResponse.status";
const COND_DEFAULT_OP = "==";

/** Aplana un AST de condicion a filas editables del constructor. Cada hoja
 * (compare/exists), con o sin not, se vuelve una fila; un logical se aplana
 * recursivamente. Las formas que el constructor no puede editar se descartan:
 * el usuario las reconstruye con los controles explicitos. */
function condAstToRows(ast) {
  const rows = [];
  const visit = (expr, negated) => {
    if (!expr || typeof expr !== "object") return;
    if (expr.op === "not") {
      visit(expr.child, !negated);
    } else if (expr.op === "compare") {
      rows.push({ field: expr.field, op: expr.op2, value: expr.value, negated });
    } else if (expr.op === "exists") {
      rows.push({ field: expr.field, op: "exists", value: "", negated });
    } else if (expr.op === "logical" && Array.isArray(expr.args)) {
      for (const a of expr.args) visit(a, negated);
    }
  };
  visit(ast, false);
  return rows;
}

/** Una fila "existe" siempre es valida; una comparacion exige valor. */
function condRowComplete(row) {
  return row.op === "exists" || String(row.value ?? "") !== "";
}

/** Serializa las filas del DOM a un AST valido — o null si alguna comparacion
 * queda sin valor. Una fila unica va directa (o envuelta en not); con 2+ filas
 * se combinan con el conector global Y/O. */
function condRowsToAst(rows, and) {
  if (rows.length === 0 || rows.some((r) => !condRowComplete(r))) return null;
  const args = rows.map((r) => {
    const leaf = r.op === "exists"
      ? { op: "exists", field: r.field }
      : { op: "compare", field: r.field, op2: r.op, value: r.value };
    return r.negated ? { op: "not", child: leaf } : leaf;
  });
  return args.length === 1 ? args[0] : { op: "logical", and: and !== false, args };
}

function condRowHtml(row, idx) {
  const fieldOpts = ctxFields
    .map((f) => `<option value="${f}" ${row.field === f ? "selected" : ""}>${esc(campoLegible(f))}</option>`)
    .join("");
  const opOpts = [
    ...compareOps.map((o) => `<option value="${o}" ${row.op === o ? "selected" : ""}>${esc(operadorLegible(o))}</option>`),
    `<option value="exists" ${row.op === "exists" ? "selected" : ""}>existe</option>`,
  ].join("");
  const exists = row.op === "exists";
  return `
    <div class="cond-row ${exists ? "cond-row--exists" : ""}">
      <select class="cond-field" aria-label="Campo de la condici\u00f3n ${idx + 1}">${fieldOpts}</select>
      <select class="cond-op" aria-label="Operador de la condici\u00f3n ${idx + 1}">${opOpts}</select>
      <input class="cond-value text-input" type="text" value="${esc(String(row.value ?? ""))}" aria-label="Valor de comparaci\u00f3n ${idx + 1}" />
      <button type="button" class="cond-negate" aria-pressed="${row.negated ? "true" : "false"}" aria-label="Negar la condici\u00f3n ${idx + 1}">NO</button>
      <button type="button" class="cond-remove" aria-label="Eliminar la condici\u00f3n ${idx + 1}">\u00d7</button>
      <small class="cond-row-error">Falta el valor</small>
    </div>`;
}

function conditionBuilderHtml(node) {
  let rows = condAstToRows(node.condition);
  if (rows.length === 0) {
    rows = [{ field: COND_DEFAULT_FIELD, op: COND_DEFAULT_OP, value: "", negated: false }];
  }
  const and = node.condition?.op === "logical" ? node.condition.and !== false : true;
  return `
    <p class="cond-preview">Se ejecuta cuando: \u2026</p>
    <div class="cond-rows">
      ${rows.map((r, i) => condRowHtml(r, i)).join("")}
    </div>
    <button type="button" class="btn cond-add">+ Agregar condici\u00f3n</button>
    <div class="cond-combine-wrap">
      <select class="cond-combine" aria-label="Combinaci\u00f3n de las condiciones">
        <option value="and" ${and ? "selected" : ""}>y (todas)</option>
        <option value="or" ${and ? "" : "selected"}>o (cualquiera)</option>
      </select>
    </div>`;
}

function wireConditionBuilder(node) {
  const builder = $(`#cond-builder-${node.id}`);
  if (!builder) return;

  const fieldOptsHtml = () =>
    ctxFields.map((f) => `<option value="${f}">${esc(campoLegible(f))}</option>`).join("");
  const opOptsHtml = () =>
    [
      ...compareOps.map((o) => `<option value="${o}">${esc(operadorLegible(o))}</option>`),
      `<option value="exists">existe</option>`,
    ].join("");

  const addRow = () => {
    const rows = builder.querySelector(".cond-rows");
    const row = document.createElement("div");
    row.className = "cond-row";
    row.innerHTML = `
      <select class="cond-field" aria-label="Campo de la condici\u00f3n">${fieldOptsHtml()}</select>
      <select class="cond-op" aria-label="Operador de la condici\u00f3n">${opOptsHtml()}</select>
      <input class="cond-value text-input" type="text" value="" aria-label="Valor de comparaci\u00f3n" />
      <button type="button" class="cond-negate" aria-pressed="false" aria-label="Negar la condici\u00f3n">NO</button>
      <button type="button" class="cond-remove" aria-label="Eliminar la condici\u00f3n">\u00d7</button>
      <small class="cond-row-error">Falta el valor</small>`;
    rows.appendChild(row);
    updateCondState();
    row.querySelector(".cond-field").focus();
  };

  const removeRow = (row) => {
    const rows = builder.querySelector(".cond-rows");
    const focusTarget =
      row.nextElementSibling?.querySelector(".cond-field") ??
      row.previousElementSibling?.querySelector(".cond-field");
    row.remove();
    if (rows.children.length === 0) addRow();
    else updateCondState();
    (focusTarget ?? rows.querySelector(".cond-field") ?? builder.querySelector(".cond-add"))?.focus();
  };

  const toggleNegate = (row) => {
    const btn = row.querySelector(".cond-negate");
    const negated = btn.getAttribute("aria-pressed") === "true";
    btn.setAttribute("aria-pressed", negated ? "false" : "true");
    btn.classList.toggle("is-active", !negated);
    updateCondState();
  };

  const readRows = () => {
    const out = [];
    builder.querySelectorAll(".cond-row").forEach((row) => {
      const field = row.querySelector(".cond-field")?.value ?? "error";
      const op = row.querySelector(".cond-op")?.value ?? COND_DEFAULT_OP;
      const raw = row.querySelector(".cond-value")?.value ?? "";
      const num = Number(raw);
      const value = raw !== "" && !Number.isNaN(num) ? num : raw;
      const negated = row.querySelector(".cond-negate")?.getAttribute("aria-pressed") === "true";
      out.push({ field, op, value, negated });
    });
    return out;
  };

  const updateCondState = () => {
    const rows = readRows();
    const and = (builder.querySelector(".cond-combine")?.value ?? "and") !== "or";
    const ast = condRowsToAst(rows, and);

    rows.forEach((r, i) => {
      const row = builder.querySelectorAll(".cond-row")[i];
      if (!row) return;
      const exists = r.op === "exists";
      row.classList.toggle("cond-row--exists", exists);
      row.classList.toggle("cond-row--invalid", !condRowComplete(r));
      row.querySelector(".cond-value")?.classList.toggle("hidden", exists);
      const n = i + 1;
      row.querySelector(".cond-field")?.setAttribute("aria-label", `Campo de la condici\u00f3n ${n}`);
      row.querySelector(".cond-op")?.setAttribute("aria-label", `Operador de la condici\u00f3n ${n}`);
      row.querySelector(".cond-value")?.setAttribute("aria-label", `Valor de comparaci\u00f3n ${n}`);
      row.querySelector(".cond-negate")?.setAttribute("aria-label", `Negar la condici\u00f3n ${n}`);
      row.querySelector(".cond-remove")?.setAttribute("aria-label", `Eliminar la condici\u00f3n ${n}`);
    });

    builder.querySelector(".cond-combine-wrap")?.classList.toggle("cond-combine-wrap--visible", rows.length >= 2);
    const preview = builder.querySelector(".cond-preview");
    if (preview) {
      // El loop es do-while (el body corre y SALE apenas se cumple), asi que
      // su frase viviente describe la salida, no la repeticion.
      const prefix = node.type === "loop" ? "Sale cuando: " : "Se ejecuta cuando: ";
      preview.textContent = `${prefix}${ast ? describeCondition(ast) : "\u2026"}`;
    }

    const n = findNode(node.id);
    if (!n) return;
    // Solo se comitea un AST completo; si falta algun valor el nodo queda
    // marcado incompleto ("\u00b7" en el canvas) hasta completarlo.
    if (ast) n.condition = ast;
    else delete n.condition;
    render();
  };

  builder.addEventListener("input", () => updateCondState());
  builder.addEventListener("click", (ev) => {
    if (ev.target.closest(".cond-add")) {
      addRow();
    } else if (ev.target.closest(".cond-remove")) {
      removeRow(ev.target.closest(".cond-row"));
    } else if (ev.target.closest(".cond-negate")) {
      toggleNegate(ev.target.closest(".cond-row"));
    }
  });

  // Sincroniza el estado inicial (preview, filas invalidas, AST) desde el DOM.
  updateCondState();
}

// ── Acciones de la barra de herramientas ──────────────────────────────────
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
$("#btn-flow")?.addEventListener("click", () => simulateFlow());

$("#btn-apply").addEventListener("click", () => applyGraph());

/** Quita el estado "validado OK" cuando el grafo vuelve a modificarse. */
function markDirty() {
  document.querySelectorAll(".btn.is-valid").forEach((b) => b.classList.remove("is-valid"));
}

/** Intenta convertir un mensaje que parezca JSON (p.ej. un ZodError crudo
 * viejo) en texto legible; si no, devuelve el mensaje tal cual. */
function readableMessage(message) {
  if (typeof message !== "string") return String(message ?? "Error desconocido");
  const trimmed = message.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const issues = Array.isArray(parsed)
        ? parsed
        : parsed?.issues && Array.isArray(parsed.issues)
          ? parsed.issues
          : null;
      if (issues) {
        return issues
          .map((i) => {
            const path = Array.isArray(i?.path) ? i.path.join(".") : "";
            const msg = i?.message ?? JSON.stringify(i);
            return path ? `${path}: ${msg}` : msg;
          })
          .join(" · ");
      }
    } catch {
      // No era JSON — usar el mensaje original.
    }
  }
  return trimmed;
}

function validateGraph() {
  const payload = buildPayload(state);
  const id = $("#pipeline-name").value || "nuevo-pipeline";
  fetch(`/api/ui/pipelines/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((res) => {
      const box = $("#validation-result");
      const btnValidate = $("#btn-validate");
      const btnApply = $("#btn-apply");
      if (res.valid) {
        box.dataset.state = "valid";
        box.textContent = "El grafo es valido.";
        btnValidate?.classList.add("is-valid");
        btnApply?.classList.add("is-valid");
      } else {
        markDirty();
        const errors = Array.isArray(res.errors) ? res.errors : ["El grafo no paso la validacion."];
        box.dataset.state = "invalid";
        box.textContent = "Invalido: " + errors.join("; ");
        showValidateDialog(errors);
      }
    })
    .catch((err) => {
      markDirty();
      const box = $("#validation-result");
      box.dataset.state = "invalid";
      box.textContent = "Error en la validacion: " + readableMessage(err.message);
    });
}

function showValidateDialog(errors) {
  const dlg = $("#validate-dialog");
  if (!dlg) return;
  const list = $("#validate-errors");
  list.innerHTML = errors.map((e) => `<li>${esc(readableMessage(e))}</li>`).join("");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  const okBtn = dlg.querySelector("#btn-validate-ok");
  okBtn?.focus();
  okBtn.onclick = () => {
    if (typeof dlg.close === "function") dlg.close();
    else dlg.removeAttribute("open");
  };
}

function applyGraph() {
  const id = $("#pipeline-name").value || "nuevo-pipeline";
  const payload = buildPayload(state);
  const draft = {
    config: {
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
  fetch("/api/ui/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(readableMessage(data?.error?.message) || `Error al aplicar (${r.status})`);
      }
      return data;
    })
    .then((data) => {
      const box = $("#validation-result");
      box.dataset.state = "valid";
      box.textContent = `Aplicado: ${(data.reloadedChains || []).join(", ") || "ok"}`;
      loadPipelines();
    })
    .catch((err) => {
      markDirty();
      state.applyError = err.message;
      $("#validation-result").dataset.state = "invalid";
      $("#validation-result").textContent = "Error al aplicar (estado del editor conservado): " + err.message;
      showApplyDialog(err.message);
    });
}

// ── Ver flujo: anima el orden de ejecucion del pipeline ───────────────────
let flowTimer = null;
let flowPrevId = null;

/**
 * Recorre el grafo igual que el engine: arranca en start, sigue por la
 * primera arista; una condition toma su rama true; un loop recorre su body en
 * orden (secuencia autoencadenada) y sale por la arista hacia afuera. No
 * ejecuta providers: es una animacion local para entender el flujo.
 */
function computeFlowOrder() {
  const steps = [];
  const seen = new Set();
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const nextEdges = (n) => {
    const direct = state.edges.filter((e) => e.from === n.id);
    if (n.type === "condition") {
      const t = direct.find((e) => e.guard === "true");
      return t ? [t] : direct.slice(0, 1);
    }
    return direct.slice(0, 1);
  };
  let cur = state.nodes.find((n) => n.type === "start");
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

function clearFlow() {
  if (flowTimer) {
    clearTimeout(flowTimer);
    flowTimer = null;
  }
  flowPrevId = null;
  document.querySelectorAll(".graph-node.flow-active, .graph-node.flow-past").forEach((el) =>
    el.classList.remove("flow-active", "flow-past"),
  );
  document.querySelectorAll(".edge-line.flow-past").forEach((el) => el.classList.remove("flow-past"));
  document.querySelectorAll(".loop-container-group.flow-past").forEach((el) => el.classList.remove("flow-past"));
}

function simulateFlow() {
  render();
  const steps = computeFlowOrder();
  if (steps.length === 0) return;
  const STEP_MS = 300;
  let i = 0;
  const tick = () => {
    if (i >= steps.length) {
      // Dejar el ultimo bloque encendido un momento y limpiar.
      flowTimer = setTimeout(clearFlow, Math.min(2600, steps.length * STEP_MS + 600));
      return;
    }
    const step = steps[i++];
    // La arista que une el paso anterior con este queda marcada como recorrida.
    if (flowPrevId && flowPrevId !== step.nodeId) {
      const edge = document.querySelector(
        `.edge-line[data-from="${flowPrevId}"][data-to="${step.nodeId}"]`,
      );
      if (edge) edge.classList.add("flow-past");
    }
    // El bloque actual pulsa; el anterior queda en estado "ya visitado".
    const active = document.querySelector(".graph-node.flow-active");
    if (active && active.dataset.id !== step.nodeId) active.classList.replace("flow-active", "flow-past");
    const target = document.querySelector(`.graph-node[data-id="${step.nodeId}"]`);
    if (target) {
      target.classList.remove("flow-past");
      target.classList.add("flow-active");
    }
    // El contenedor del loop tambien se marca cuando entramos al bucle.
    if (step.kind === "loop") {
      const cg = document.querySelector(`.loop-container-group[data-id="${step.nodeId}"]`);
      if (cg) cg.classList.add("flow-past");
    }
    flowPrevId = step.nodeId;
    flowTimer = setTimeout(tick, STEP_MS);
  };
  tick();
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
  markDirty();
  render();
  if (canvasEmpty) canvasEmpty.hidden = false;
  $("#inspector-empty").hidden = false;
  $("#inspector-body").hidden = true;
  $("#validation-result").textContent = "";
}

// ── Carga de datos ───────────────────────────────────────────────────────
async function loadPipelines() {
  try {
    const res = await fetch("/api/ui/pipelines");
    if (!res.ok) throw new Error(`al listar pipelines (HTTP ${res.status})`);
    const list = await res.json();
    state.pipelines = list;
    const el = $("#pipelines-list");
    el.innerHTML = list
      .map(
        (p) =>
          `<div class="list-item">
            <span class="primary">${esc(p.id)}</span>
            <span class="secondary">${p.nodeCount} nodos</span>
            <button type="button" class="btn btn-small" data-open="${esc(p.id)}">Editar \u2192</button>
          </div>`,
      )
      .join("");
    el.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => loadPipelineIntoEditor(btn.dataset.open));
    });
    renderPalettePresets();
  } catch (err) {
    $("#pipelines-list").textContent = "Error al cargar pipelines: " + err.message;
  }
}

async function loadPipelineIntoEditor(id) {
  try {
    const res = await fetch(`/api/ui/pipelines/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`al cargar "${id}" (HTTP ${res.status})`);
    const data = await res.json();
    const nodes = (data.nodes || []).map((n) => {
      const base = { id: n.id, type: n.type };
      if (n.model) base.model = n.model;
      if (n.provider) base.provider = n.provider;
      if (n.condition) base.condition = n.condition;
      if (n.body) base.body = n.body;
      if (n.pipeline) base.pipeline = n.pipeline;
      if (n.params) base.params = n.params;
      if (n.parallel) base.parallel = n.parallel;
      if (n.mode) base.mode = n.mode;
      if (n.ctx != null) base.ctx = n.ctx;
      if (n.system) base.system = n.system;
      if (n.assistant) base.assistant = n.assistant;
      if (n.on_429) base.on_429 = n.on_429;
      if (n.tool_calls_route) base.tool_calls_route = n.tool_calls_route;
      return base;
    });
    state.nodes = nodes;
    // El nuevo modelo de loop encadena el body por orden (sin conexiones):
    // al cargar, se descartan edges internos obsoletos guardados por versiones
    // anteriores del editor.
    state.edges = stripLoopInternalEdges(
      (data.edges || []).map((e) => ({
        from: e.from,
        to: e.to,
        ...(e.guard ? { guard: e.guard } : {}),
      })),
      nodes,
    );
    state.nextId = nodes.reduce((m, n) => Math.max(m, /^n(\d+)$/.exec(n.id)?.[1] ?? 0), 0) + 1;
    markDirty();
    // Seleccionar el start (o el primer nodo) para que el inspector muestre
    // algo apenas se carga el pipeline, en vez de quedar vacio.
    const first = nodes.find((n) => n.type === "start") ?? nodes[0] ?? null;
    state.selectedId = first?.id ?? null;
    $("#pipeline-name").value = id;
    render();
    if (canvasEmpty) canvasEmpty.hidden = state.nodes.length > 0;
    if (first) {
      openInspector(first);
    } else {
      $("#inspector-empty").hidden = false;
      $("#inspector-body").hidden = true;
    }
    const box = $("#validation-result");
    box.dataset.state = "valid";
    box.textContent = `Pipeline "${id}" cargado en el editor.`;
    switchView("editor", document.querySelector('.nav-link[data-view="editor"]'));
  } catch (err) {
    const box = $("#validation-result");
    box.dataset.state = "invalid";
    box.textContent = "Error al cargar el pipeline: " + err.message;
  }
}

// ── F2: ciclo de vida (panel Backend + unload por modelo) ────────────────

/** Formatea un timestamp ISO como hora local corta. */
function lcTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Muestra/oculta los campos freeGb/capGb según el modo VRAM elegido. */
function toggleVramInputs() {
  const mode = $("#lc-vram-mode").value;
  $("#lc-freegb-wrap").hidden = mode === "cap";
  $("#lc-capgb-wrap").hidden = mode !== "cap";
}

/** Pinta el bloque de estado del panel Backend desde GET /api/ui/models. */
function renderLifecycleState(lifecycle) {
  const st = $("#lc-status");
  st.dataset.state = "idle";
  if (lifecycle?.vramPolicyActive) {
    st.textContent = "política VRAM activa";
    st.dataset.state = "connected";
  } else {
    st.textContent = "política VRAM inactiva (muestreo nvidia-smi falló o desactivada)";
    st.dataset.state = "disconnected";
  }
  const s = lifecycle?.lastVramSample;
  $("#lc-meta").textContent = s
    ? `última muestra: ${s.usedMiB} MiB usados de ${s.totalMiB} MiB (${lcTime(s.at)})`
    : "sin muestra de VRAM todavía";
  const unloads = lifecycle?.recentUnloads || [];
  const box = $("#lc-unloads");
  if (unloads.length === 0) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = unloads
    .slice(0, 5)
    .map(
      (u) =>
        `<div class="list-item">
          <span class="primary">${esc(u.modelId)}</span>
          <span class="chip" data-live="${u.ok ? "unloaded" : "loaded"}">${u.ok ? "descargado" : "falló"}</span>
          <span class="secondary">${esc(u.reason)} · pid ${u.pid} · ${lcTime(u.at)}</span>
        </div>`,
    )
    .join("");
}

/** Carga la config viva desde GET /api/ui/config y llena el editor Backend. */
async function loadLifecycle() {
  try {
    const res = await fetch("/api/ui/config");
    const data = await res.json();
    state.lifecycleConfig = data;
    const lc = data?.llama?.lifecycle || {};
    $("#lc-ttl").value = String(lc.ttl ?? "");
    $("#lc-vram-mode").value = lc.vram?.mode || "dynamic";
    $("#lc-freegb").value = String(lc.vram?.freeGb ?? "");
    $("#lc-capgb").value = String(lc.vram?.capGb ?? "");
    toggleVramInputs();
  } catch (err) {
    $("#lc-status").dataset.state = "disconnected";
    $("#lc-status").textContent = "config no disponible: " + err.message;
  }
}

/** Persiste el panel Backend: merge sobre la config viva + POST /api/ui/apply. */
async function saveLifecycle() {
  const btn = $("#lc-save");
  const st = $("#lc-status");
  btn.disabled = true;
  try {
    const lc = state.lifecycleConfig;
    if (!lc?.llama) throw new Error("config aún no cargada — reintentá en un segundo");
    lc.llama.lifecycle = {
      ttl: Number($("#lc-ttl").value) || 0,
      vram: {
        mode: $("#lc-vram-mode").value,
        freeGb: Number($("#lc-freegb").value) || 0,
        capGb: Number($("#lc-capgb").value) || 0.5,
      },
    };
    const res = await fetch("/api/ui/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: lc }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Error al aplicar (${res.status})`);
    }
    st.dataset.state = "connected";
    st.textContent = "guardado y aplicado";
    await loadLifecycle();
    await loadModels();
  } catch (err) {
    st.dataset.state = "disconnected";
    st.textContent = "error: " + err.message;
  } finally {
    btn.disabled = false;
  }
}

/** Descarga un worker de modelo por su id. */
async function unloadModel(id) {
  try {
    const res = await fetch(`/api/ui/models/${encodeURIComponent(id)}/unload`, {
      method: "POST",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("#lc-status").textContent = `no se pudo descargar ${id}: ${data?.error?.message || res.status}`;
      $("#lc-status").dataset.state = "disconnected";
    } else {
      $("#lc-status").textContent = `${id} descargado`;
      $("#lc-status").dataset.state = "connected";
    }
    await loadModels();
  } catch (err) {
    $("#lc-status").textContent = "error al descargar: " + err.message;
    $("#lc-status").dataset.state = "disconnected";
  }
}

/** Descarga todos los workers de modelos. */
async function unloadAllModels() {
  const btn = $("#lc-unload-all");
  btn.disabled = true;
  try {
    const res = await fetch("/api/ui/models/unload-all", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    $("#lc-status").textContent = `${data.unloaded} worker(s) descargado(s)`;
    $("#lc-status").dataset.state = "connected";
    await loadModels();
  } catch (err) {
    $("#lc-status").textContent = "error: " + err.message;
    $("#lc-status").dataset.state = "disconnected";
  } finally {
    btn.disabled = false;
  }
}

async function loadModels() {
  try {
    const res = await fetch("/api/ui/models");
    if (!res.ok) throw new Error(`al listar modelos (HTTP ${res.status})`);
    const data = await res.json();
    state.models = data.models || [];
    $("#models-dir").textContent = `Directorio: ${data.modelsDir}`;
    renderLifecycleState(data.lifecycle);
    const el = $("#models-list");
    el.innerHTML = (data.models || [])
      .map((m) => {
        const live = m.processLoaded ? "loaded" : "unloaded";
        const lastUsed = m.lastUsed ? ` · última actividad ${lcTime(m.lastUsed)}` : "";
        const unloadBtn = m.processLoaded
          ? `<button class="btn btn-small" data-unload="${esc(m.id)}">Descargar</button>`
          : "";
        return `<div class="list-item">
            <span class="primary">${esc(m.id)}</span>
            <span class="chip" data-live="${live}">${m.processLoaded ? "cargado" : "descargado"}</span>
            <span class="secondary">${m.loaded ? "registrado" : "candidato"}${lastUsed}</span>
            ${unloadBtn}
          </div>`;
      })
      .join("");
    el.querySelectorAll("[data-unload]").forEach((btn) => {
      btn.addEventListener("click", () => unloadModel(btn.dataset.unload));
    });
    renderPalettePresets();
  } catch (err) {
    $("#models-list").textContent = "Error al cargar modelos: " + err.message;
  }
}

async function loadExecutions() {
  try {
    const res = await fetch("/api/ui/executions?limit=50");
    if (!res.ok) throw new Error(`al listar ejecuciones (HTTP ${res.status})`);
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
    $("#executions-list").textContent = "Error al cargar ejecuciones: " + err.message;
  }
}

// ── Agentes: sincronizacion de modelos gateway en configs de agentes ─────
async function loadAgents() {
  try {
    const res = await fetch("/api/ui/agents/status");
    if (!res.ok) throw new Error(`al consultar agentes (HTTP ${res.status})`);
    const data = await res.json();
    state.agents = data.agents || [];
    $("#agent-token-row").hidden = !data.authRequired;
    const gatewayCount = (data.models || []).length;
    const el = $("#agents-list");
    el.innerHTML =
      `<div class="hint">Modelos gateway registrados: ${gatewayCount}.</div>` +
      (data.agents || [])
        .map(
          (a) => {
            const estado = a.providerPresent
              ? `Configurado (${a.modelCount} modelos)`
              : a.exists
                ? "Sin proveedor llm-proxy"
                : "Sin archivo de config";
            const chipState = a.providerPresent ? "completed" : "failed";
            return `<div class="list-item agents-card">
              <span class="primary">${esc(a.label)}</span>
              <span class="secondary">${esc(a.configPath)}</span>
              <span class="chip" data-status="${chipState}">${esc(estado)}</span>
              <button type="button" class="btn btn-small" data-agent="${esc(a.id)}">Sincronizar y configurar</button>
            </div>`;
          },
        )
        .join("");
    el.querySelectorAll("[data-agent]").forEach((btn) => {
      btn.addEventListener("click", () => configureAgent(btn.dataset.agent));
    });
  } catch (err) {
    $("#agents-list").textContent = "Error al cargar agentes: " + err.message;
  }
}

async function configureAgent(agentId) {
  if (!agentId) return;
  const btn = document.querySelector(`[data-agent="${agentId}"]`);
  const result = $("#agents-result");
  const token = $("#agent-token")?.value.trim();
  result.dataset.state = "pending";
  result.textContent = "Configurando\u2026";
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/ui/agents/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(token ? { agent: agentId, apiKey: token } : { agent: agentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Error al configurar (HTTP ${res.status})`);
    }
    const label = (state.agents || []).find((a) => a.id === agentId)?.label || agentId;
    const count = (data.modelsConfigured || []).length;
    result.dataset.state = "valid";
    result.textContent = `Configurado: ${count} modelos sincronizados. Reinici\u00e1 ${label} para tomar la config.`;
    loadAgents();
  } catch (err) {
    result.dataset.state = "invalid";
    result.textContent = "Error: " + err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── SSE EventSource (actualizaciones en vivo) ─────────────────────────────
function connectEvents() {
  const status = $("#conn-status");
  let es;
  try {
    es = new EventSource("/api/ui/events");
  } catch {
    status.dataset.state = "disconnected";
    status.textContent = "SSE no disponible";
    return;
  }
  es.onopen = () => {
    status.dataset.state = "connected";
    status.textContent = "En vivo";
  };
  es.onerror = () => {
    status.dataset.state = "disconnected";
    status.textContent = "Reconectando\u2026";
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

// ── Cambio de vistas ──────────────────────────────────────────────────────
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
  if (name === "agents") loadAgents();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c];
  });
}

// ── Inicializacion ────────────────────────────────────────────────────────
function init() {
  resetEditor();
  registerSwitcher();
  connectEvents();
  loadPipelines();
  loadModels();
  loadExecutions();
  loadAgents();
  loadLifecycle();
  $("#lc-save").addEventListener("click", saveLifecycle);
  $("#lc-unload-all").addEventListener("click", unloadAllModels);
  $("#lc-vram-mode").addEventListener("change", toggleVramInputs);
  // El lifecycle corre en el backend cada 5s; refresca la vista mientras esté
  // visible para reflejar descargas TTL/VRAM sin interacción del usuario.
  setInterval(() => {
    if (!document.querySelector("#models").hidden) loadModels();
  }, 5000);
  setTimeout(() => render(), 0);
}

document.addEventListener("DOMContentLoaded", init);
