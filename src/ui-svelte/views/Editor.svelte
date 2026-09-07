<script lang="ts">
  /**
   * Editor view — full interaction set (svelte-ui tasks 3.3–3.5).
   *
   * Declarative SVG graph (`#graph-svg`): nodes render as `.graph-node
   * [data-type]` with `.port--input/.port--output` sockets, edges as
   * `.graph-edge` beziers, loop members stacked under their header
   * (stackLoopMembers). Interactions: palette HTML5 drag + click, numeric
   * keys 1–6, Delete/Backspace, click+shift select, node drag (pointer +
   * rAF batch, ONE history entry through beginMove/endMove), background pan,
   * wheel zoom at cursor (clampZoom 0.2–3), 24 px socket connect with
   * self-edge rejection and guard branches, drop-into-loop bucketing, loop
   * containers (add-block button + member ▲▼ reorder), the node-switcher
   * carousel, and the Ver flujo flow animation (reduced-motion gate).
   *
   * All mutations funnel through the editor store; geometry and guards live
   * in the framework-free libs, never here.
   */
  import type { EditorStore } from "../stores/editor-store.js";
  import type { GraphNode, NodeType, Point } from "../lib/graph-model.js";
  import {
    NODE_W,
    NODE_H,
    socketPositions,
    conditionSockets,
    outSocketFor,
    bezierEdge,
    layoutGraph,
    stackLoopMembers,
    loopBodyRect,
    ownerLoopId,
    COND_DEFAULT_FIELD,
    COND_DEFAULT_OP,
    campoLegible,
    compareOps,
    condAstToRows,
    condRowComplete,
    condRowsToAst,
    ctxFields,
    describeCondition,
    describeLlmCall,
    describeLoop,
    describePipeline,
    isCompleteNode,
    operadorLegible,
    paramsToRows,
    rowsToParams,
    type CondRow,
    type GraphEdge,
    type ParamRow,
  } from "../lib/graph-model.js";
  import type { ModelEntry } from "../stores/types.js";
  import { tick } from "svelte";
  import {
    clientToGraph,
    graphToClient,
    clampZoom,
    nearestInputSocket,
    computeFlowOrder,
    SOCKET_HIT_RADIUS,
    type EditorView,
    type FlowStep,
  } from "../lib/editor-geometry.js";

  const PALETTE = [
    { type: "start", label: "Inicio", key: "1" },
    { type: "llm_call", label: "Llamada LLM", key: "2" },
    { type: "condition", label: "Condición", key: "3" },
    { type: "loop", label: "Bucle", key: "4" },
    { type: "pipeline", label: "Pipeline", key: "5" },
    { type: "end", label: "Fin", key: "6" },
  ] as const satisfies ReadonlyArray<{ type: NodeType; label: string; key: string }>;

  const NODE_LABELS: Record<NodeType, string> = {
    start: "Inicio",
    llm_call: "Llamada LLM",
    condition: "Condición",
    loop: "Bucle",
    pipeline: "Pipeline",
    end: "Fin",
  };

  /** ms between flow-animation steps and total spill time, matching legacy. */
  const FLOW_STEP_MS = 300;
  const FLOW_TAIL_MS = 600;

  let { store, hidden = false, models = [] }: {
    store: EditorStore;
    hidden?: boolean;
    models: ModelEntry[];
  } = $props();

  let canvasEl = $state<HTMLDivElement | null>(null);
  let validateDialog = $state<HTMLDialogElement | null>(null);
  let applyDialog = $state<HTMLDialogElement | null>(null);
  let switcherEl = $state<HTMLDivElement | null>(null);

  const view = $state<EditorView>({ zoom: 1, panX: 0, panY: 0 });

  /** Nodes with every position materialized: stacked members first, then the
   * auto-layout pass fills anything still unplaced (legacy render order). */
  const graph = $derived.by(() => {
    const stacked = stackLoopMembers($store.nodes);
    const layout = layoutGraph(stacked, $store.edges);
    const nodes = stacked.map((n) => ({
      ...n,
      pos: n.pos ?? layout.get(n.id) ?? { x: 40, y: 40 },
    }));
    return { nodes, edges: $store.edges };
  });

  const selection = $derived($store.selection);

  const selectedNode = $derived(
    $store.selection.length > 0
      ? $store.nodes.find((n) => n.id === $store.selection[0]) ?? null
      : null
  );

  function nodeTypeLabel(type: string): string {
    return NODE_LABELS[type as NodeType] ?? type;
  }

  /** Loop container overlays (HTML, legacy `.loop-container-group[data-id]`)
   * positioned over the SVG via graph→client math. */
  const loopOverlays = $derived.by(() => {
    const overlays: { id: string; rect: { x: number; y: number; width: number; height: number }; count: number }[] = [];
    for (const n of graph.nodes) {
      if (n.type !== "loop") continue;
      const rect = loopBodyRect(n, graph.nodes);
      if (rect) overlays.push({ id: n.id, rect, count: n.body?.length ?? 0 });
    }
    return overlays;
  });

  /* ------------------------------------------------------------------ */
  /* coordinate plumbing                                                 */
  /* ------------------------------------------------------------------ */

  function rectView(): DOMRect {
    return canvasEl?.getBoundingClientRect() ?? ({ left: 0, top: 0 } as DOMRect);
  }

  function toGraph(clientX: number, clientY: number): Point {
    return clientToGraph(clientX, clientY, rectView(), view);
  }

  function overlayStyle(rect: { x: number; y: number; width: number; height: number }): string {
    const topLeft = graphToClient({ x: rect.x, y: rect.y }, rectView(), view);
    return `left:${topLeft.x}px;top:${topLeft.y}px;width:${rect.width * view.zoom}px;height:${rect.height * view.zoom}px;`;
  }

  /* ------------------------------------------------------------------ */
  /* drag (node) / pan / connect state                                  */
  /* ------------------------------------------------------------------ */

  interface DragState {
    id: string;
    startClientX: number;
    startClientY: number;
    base: Point;
  }
  interface ConnectState {
    fromId: string;
    guard?: string;
    from: Point;
    cur: Point;
    invalid: boolean;
  }

  let drag: DragState | null = null;
  let dragPending: Point | null = null;
  let rafId = 0;
  let pan: { startX: number; startY: number; baseX: number; baseY: number } | null = null;
  let connect = $state<ConnectState | null>(null);
  /** Last known pointer position (client coords): the HTML5 drop event in
   * some environments carries no coordinates, so the palette drop falls back
   * to where the pointer was last seen. */
  let lastCursor = $state<Point>({ x: 0, y: 0 });

  const sched = $derived(
    typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16) as unknown as number,
  );

  function applyDragNow(): void {
    if (!drag || !dragPending) return;
    const dx = (dragPending.x - drag.startClientX) / view.zoom;
    const dy = (dragPending.y - drag.startClientY) / view.zoom;
    store.actions.moveNode(drag.id, Math.round(drag.base.x + dx), Math.round(drag.base.y + dy));
    dragPending = null;
    rafId = 0;
  }

  function onWindowPointerMove(e: PointerEvent): void {
    lastCursor = { x: e.clientX, y: e.clientY };
    if (drag) {
      dragPending = { x: e.clientX, y: e.clientY };
      if (!rafId) rafId = sched(applyDragNow);
    } else if (connect) {
      const pt = toGraph(e.clientX, e.clientY);
      const target = nearestInputSocket(graph.nodes, pt, SOCKET_HIT_RADIUS / view.zoom);
      connect = { ...connect, cur: pt, invalid: target !== null && target === connect.fromId };
    } else if (pan) {
      view.panX = pan.baseX + (e.clientX - pan.startX);
      view.panY = pan.baseY + (e.clientY - pan.startY);
    }
  }

  function onWindowPointerUp(e: PointerEvent): void {
    if (drag) {
      if (dragPending) applyDragNow();
      store.actions.endMove();
      drag = null;
    } else if (connect) {
      const c = connect;
      connect = null;
      const pt = toGraph(e.clientX, e.clientY);
      const target = nearestInputSocket(graph.nodes, pt, SOCKET_HIT_RADIUS / view.zoom);
      if (target && target !== c.fromId) store.actions.connect(c.fromId, target, c.guard);
    } else if (pan) {
      pan = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* node / port / background pointer handlers                          */
  /* ------------------------------------------------------------------ */

  function onNodePointerDown(e: PointerEvent, n: GraphNode): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    canvasEl?.setPointerCapture?.(e.pointerId);
    canvasEl?.focus?.();
    const currentSel = store.getSnapshot().selection;
    if (e.shiftKey) {
      store.actions.select(
        currentSel.includes(n.id) ? currentSel.filter((id) => id !== n.id) : [...currentSel, n.id],
      );
    } else {
      store.actions.select([n.id]);
    }
    const placed = graph.nodes.find((x) => x.id === n.id);
    drag = {
      id: n.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      base: { x: placed?.pos?.x ?? 0, y: placed?.pos?.y ?? 0 },
    };
    store.actions.beginMove();
  }

  function onPortPointerDown(e: PointerEvent, n: GraphNode): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    canvasEl?.setPointerCapture?.(e.pointerId);
    const guard = (e.currentTarget as Element | null)?.getAttribute("data-guard") ?? undefined;
    const fromPos = n.pos ?? { x: 0, y: 0 };
    connect = {
      fromId: n.id,
      guard,
      from: outSocketFor(n, fromPos, guard),
      cur: outSocketFor(n, fromPos, guard),
      invalid: false,
    };
  }

  function onBackgroundPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    canvasEl?.setPointerCapture?.(e.pointerId);
    pan = { startX: e.clientX, startY: e.clientY, baseX: view.panX, baseY: view.panY };
    if (!e.shiftKey && store.getSnapshot().selection.length > 0) store.actions.select([]);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = clampZoom(view.zoom * factor);
    if (next === view.zoom) return;
    const pt = toGraph(e.clientX, e.clientY);
    view.zoom = next;
    // keep the graph point under the cursor stationary
    view.panX = e.clientX - rectView().left - pt.x * next;
    view.panY = e.clientY - rectView().top - pt.y * next;
  }

  /* ------------------------------------------------------------------ */
  /* palette / drop / keyboard                                          */
  /* ------------------------------------------------------------------ */

  function onPaletteDragStart(e: DragEvent, type: NodeType): void {
    e.dataTransfer?.setData("application/x-node-type", type);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
  }

  function onCanvasDrop(e: DragEvent): void {
    e.preventDefault();
    const type = e.dataTransfer?.getData("application/x-node-type") as NodeType | undefined;
    if (!type) return;
    // jsdom (and some browsers) deliver the drop without coordinates; the
    // palette drag ends over the last known pointer position, so fall back.
    const cx = Number.isFinite(e.clientX) ? e.clientX : lastCursor.x;
    const cy = Number.isFinite(e.clientY) ? e.clientY : lastCursor.y;
    const pt = toGraph(cx, cy);
    store.actions.addNode(type, pt);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key >= "1" && e.key <= "6") {
      const item = PALETTE[Number(e.key) - 1];
      if (item) {
        store.actions.addNode(item.type);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      const targets = [...store.getSnapshot().selection];
      for (const id of targets) store.actions.deleteNode(id);
      e.preventDefault();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) store.actions.redo();
      else store.actions.undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      store.actions.redo();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      cycleCarousel(e.key === "ArrowRight" ? 1 : -1);
      e.preventDefault();
    }
  }

  /* ------------------------------------------------------------------ */
  /* carousel                                                            */
  /* ------------------------------------------------------------------ */

  function cycleCarousel(dir: -1 | 1): void {
    const ids = graph.nodes.map((n) => n.id);
    if (ids.length === 0) return;
    const current = store.getSnapshot().selection[0] ?? ids[0]!;
    const idx = ids.indexOf(current);
    const nextId = ids[(idx + dir + ids.length) % ids.length]!;
    store.actions.select([nextId]);
    (switcherEl?.querySelector(`[data-node-id="${nextId}"]`) as HTMLElement | null)?.scrollIntoView?.({
      block: "nearest",
    });
  }

  function scrollSwitcher(dir: -1 | 1): void {
    switcherEl?.scrollBy?.({ left: dir * (switcherEl.clientWidth * 0.7), behavior: "smooth" });
  }

  /* ------------------------------------------------------------------ */
  /* flow animation (Ver flujo)                                          */
  /* ------------------------------------------------------------------ */

  let flow = $state<{ steps: FlowStep[]; cur: number } | null>(null);
  let flowTimers: (ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>)[] = [];

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function clearFlow(): void {
    for (const t of flowTimers) {
      if (typeof t === "number") {
        clearInterval(t);
        clearTimeout(t);
      }
    }
    flowTimers = [];
    flow = null;
  }

  function runFlow(): void {
    clearFlow();
    const steps = computeFlowOrder(graph.nodes, graph.edges);
    if (steps.length === 0) return;
    if (prefersReducedMotion()) {
      // static reveal: no animation, the whole order is shown at once
      flow = { steps, cur: steps.length };
      return;
    }
    flow = { steps, cur: 0 };
    flowTimers.push(setInterval(() => {
      if (flow) flow = { ...flow, cur: flow.cur + 1 };
    }, FLOW_STEP_MS));
    flowTimers.push(
      setTimeout(() => {
        flow = null;
      }, Math.min(2600, steps.length * FLOW_STEP_MS + FLOW_TAIL_MS)),
    );
  }

  function flowClass(nodeId: string): "" | "flow-active" | "flow-past" {
    if (!flow) return "";
    const idx = flow.steps.findIndex((s) => s.nodeId === nodeId);
    if (idx < 0) return "";
    if (idx === flow.cur && flow.cur < flow.steps.length) return "flow-active";
    if (idx < flow.cur) return "flow-past";
    return "";
  }

  /* ------------------------------------------------------------------ */
  /* toolbar / dialogs / loop actions                                   */
  /* ------------------------------------------------------------------ */

  let nameDraft = $state("");

  $effect(() => {
    nameDraft = $store.name ?? "";
  });

  function onNew(): void {
    store.actions.reset();
    store.actions.rename(nameDraft.trim() || null);
  }

  function onClear(): void {
    store.actions.reset();
  }

  async function runValidate(): Promise<void> {
    await store.actions.validate();
    validateDialog?.showModal();
  }

  function openApply(): void {
    applyDialog?.showModal();
  }

  function closeApply(): void {
    applyDialog?.close();
  }

  async function confirmApply(): Promise<void> {
    await store.actions.apply();
    applyDialog?.close();
  }

  function loopAddBlock(loopId: string): void {
    const overlay = loopOverlays.find((o) => o.id === loopId);
    if (!overlay) return;
    const r = overlay.rect;
    // Adds the member to the loop body directly (store action) — no reliance
    // on positional bucketing, which breaks for a loop whose position is only
    // materialized at render time.
    store.actions.addLoopMember(loopId, {
      x: r.x + r.width / 2 - NODE_W / 2,
      y: r.y + r.height - NODE_H / 2 - 8,
    });
  }

  function memberMove(loopId: string, memberId: string, dir: -1 | 1): void {
    store.actions.reorderLoopMember(loopId, memberId, dir);
  }

  /* ------------------------------------------------------------------ */
  /* window listeners + cleanup + wheel (non-passive)                   */
  /* ------------------------------------------------------------------ */

  $effect(() => {
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      if (rafId) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
        else clearTimeout(rafId);
      }
      clearFlow();
    };
  });

  $effect(() => {
    const canvas = canvasEl;
    if (!canvas) return;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  /** Node-scoped templates. Loop body members expose no external sockets;
   *  start emits only a single output and end only a single input. */
  function nodeSockets(n: GraphNode): { cx: number; cy: number; guard?: string }[] {
    if (ownerLoopId(graph.nodes, n.id) !== null && n.type !== "loop") return [];
    if (n.type === "condition") {
      const cs = conditionSockets(n.pos ?? { x: 0, y: 0 });
      return [
        { cx: cs.in.x - (n.pos?.x ?? 0), cy: cs.in.y - (n.pos?.y ?? 0) },
        { cx: cs.outTrue.x - (n.pos?.x ?? 0), cy: cs.outTrue.y - (n.pos?.y ?? 0), guard: "true" },
        { cx: cs.outFalse.x - (n.pos?.x ?? 0), cy: cs.outFalse.y - (n.pos?.y ?? 0), guard: "false" },
      ];
    }
    const sp = socketPositions(n.pos ?? { x: 0, y: 0 });
    const sockets: { cx: number; cy: number; guard?: string }[] = [];
    if (n.type !== "start") {
      sockets.push({ cx: sp.in.x - (n.pos?.x ?? 0), cy: sp.in.y - (n.pos?.y ?? 0) });
    }
    if (n.type !== "end") {
      sockets.push({ cx: sp.out.x - (n.pos?.x ?? 0), cy: sp.out.y - (n.pos?.y ?? 0) });
    }
    return sockets;
  }

  /** Bezier curve path for an edge (no arrowhead — that is a separate tip). */
  function edgeCurve(e: GraphEdge): string {
    const from = graph.nodes.find((n) => n.id === e.from);
    const to = graph.nodes.find((n) => n.id === e.to);
    if (!from?.pos || !to?.pos) return "";
    const start = outSocketFor(from, from.pos, e.guard);
    const end = { x: to.pos.x, y: to.pos.y + NODE_H / 2 };
    return bezierEdge(start.x, start.y, end.x, end.y);
  }

  /** Filled arrowhead shape at the target end of an edge. */
  function edgeTip(e: GraphEdge): string {
    const from = graph.nodes.find((n) => n.id === e.from);
    const to = graph.nodes.find((n) => n.id === e.to);
    if (!from?.pos || !to?.pos) return "";
    const end = { x: to.pos.x, y: to.pos.y + NODE_H / 2 };
    return `M ${end.x} ${end.y} L ${end.x} ${end.y + 10} L ${end.x - 9} ${end.y + 1} Z`;
  }

  /* ------------------------------------------------------------------ */
  /* inspector (editable node fields)                                    */
  /* ------------------------------------------------------------------ */

  /** Standard context sizes offered in the llm_call ctx selector. */
  const CONTEXT_STANDARDS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

  /** llm_call mode pills (value, label, live help line). */
  const MODES = [
    ["generate", "Generar", "el modelo responde al prompt (historial tal cual)."],
    ["refine", "Refinar", "re-alimenta la última respuesta del paso como nueva instrucción."],
    ["passthrough", "Pasar", "replica el texto original sin llamar al modelo."],
  ] as const;

  /** Max preview length for the living node subtitle on the canvas. */
  const MAX_NODE_PREVIEW = 20;

  function shortText(text: string, max: number): string {
    const t = String(text);
    return t.length > max ? `${t.slice(0, max).trimEnd()}\u2026` : t;
  }

  /** Readable label for a graph node (model / pipeline name where relevant),
   *  same contract the original `nodeChipLabel` had. */
  function nodeChipLabel(n: GraphNode): string {
    switch (n.type) {
      case "llm_call":
        return n.model ?? "Llamada LLM";
      case "pipeline":
        return n.pipeline ?? "Pipeline";
      case "start":
        return "Inicio";
      case "end":
        return "Fin";
      case "condition":
        return "Condición";
      case "loop":
        return "Bucle";
      default:
        return n.type;
    }
  }

  /** Select label for a node-destination option (human label + id fallback). */
  function nodeIdForSelect(n: GraphNode): string {
    const label = nodeChipLabel(n);
    return label === n.id ? label : `${label} (${n.id})`;
  }

  /** Living subtitle text for a canvas node (rendered under the title). */
  function nodeSubtitle(n: GraphNode): string {
    if (n.type === "llm_call") return describeLlmCall(n);
    if (n.type === "pipeline") return describePipeline(n);
    if (n.type === "condition" || n.type === "loop") {
      return n.type === "loop" ? describeLoop(n) : describeCondition(n.condition);
    }
    return "";
  }

  /** Configured context of a model (ctx field), null when unknown. */
  function modelCtx(id: string | undefined): number | null {
    const m = models.find((x) => x.id === id);
    return typeof m?.ctx === "number" ? m.ctx : null;
  }

  /** Guard label of the selected node's outgoing edge ("" when none). */
  const outgoingGuard = $derived($store.edges.find((e) => e.from === selectedNode?.id)?.guard ?? "");

  /** llm_call context-editor data (standards/selection/unsafe flags), or null
   *  for any other node type. Recomputed whenever the node or models change. */
  const ctxData = $derived.by(() => {
    const n = selectedNode;
    if (!n || n.type !== "llm_call") return null;
    const current = modelCtx(n.model);
    const override = (n.params as Record<string, unknown> | undefined)?.ctx;
    const model = models.find((m) => m.id === n.model);
    const ggufMax = typeof model?.ggufContextLength === "number" ? model.ggufContextLength : null;
    const hwMax = typeof model?.hardwareMaxCtx === "number" ? model.hardwareMaxCtx : null;
    const effectiveMax = ggufMax != null ? (hwMax != null ? Math.min(ggufMax, hwMax) : ggufMax) : hwMax;
    const base = (effectiveMax != null
      ? CONTEXT_STANDARDS.filter((c) => c <= effectiveMax)
      : CONTEXT_STANDARDS
    ).map((c) => String(c));
    // El ctx configurado del modelo es una opcion propia del selector (evita
    // el doble control selector + input para valores no estandar).
    const currentKey = current != null ? String(current) : null;
    const standards = currentKey && !base.includes(currentKey) ? [...base, currentKey] : base;
    let selected = override != null ? String(override) : currentKey;
    let isCustom = false;
    if (selected && !standards.includes(selected)) isCustom = true;
    const overrideKey = override != null ? String(override) : null;
    const isUnsafe = (val: string): boolean => hwMax != null && Number(val) > hwMax;
    const opts = standards.map((c) => ({
      value: c,
      unsafe: isUnsafe(c),
      label: currentKey === c && c !== overrideKey
        ? `${Number(c).toLocaleString()} (actual del modelo)`
        : `${Number(c).toLocaleString()}${isUnsafe(c) ? " \u26a0" : ""}`,
    }));
    const effectiveCtx = typeof model?.effectiveCtx === "number" ? model.effectiveCtx : null;
    return { current, currentKey, selected, isCustom, opts, isUnsafe, hwMax, effectiveCtx };
  });

  // Per-node tab selection lives OUTSIDE the node (strict graph schema) and
  // outside the store: a per-instance Map keyed by node id, like legacy.
  type TabKey = "basica" | "prompt" | "avanzado";
  const TAB_NAMES: ReadonlyArray<[TabKey, string]> = [
    ["basica", "Config. básica"],
    ["prompt", "Prompt"],
    ["avanzado", "Avanzado"],
  ];
  const inspectorTabs = new Map<string, TabKey>();
  const tabKeysFor = (n: GraphNode | null): TabKey[] =>
    n?.type === "llm_call" ? ["basica", "prompt", "avanzado"] : [];

  // Draft state for the inspector. The drafts (not the store value) drive the
  // inputs so typing never clobbers itself through a round-trip; the store
  // receives only the committed, trimmed value. Everything re-initializes
  // when the inspected node changes (guarded by lastInspectedId).
  let lastInspectedId = $state<string | null>(null);
  let ctxModelKey = $state<string | null>(null);
  let activeTab = $state<TabKey>("basica");
  let condRows = $state<CondRow[]>([]);
  let condAnd = $state(true);
  let paramRows = $state<ParamRow[]>([]);
  let drafts = $state({ system: "", assistant: "", provider: "", pipeline: "" });
  let ctxSelectDraft = $state("");
  let ctxCustomDraft = $state("");
  let ctxCustomMode = $state(false);
  let inspectorEl = $state<HTMLElement | null>(null);
  let condBuilderEl = $state<HTMLElement | null>(null);
  let paramRowsEl = $state<HTMLElement | null>(null);

  /** Re-initialize every inspector draft from the newly selected node. Runs
   *  when the selection first id changes — or, for llm_call, when its model
   *  changes (the ctx editor is model-dependent). Live field edits mutate
   *  drafts + store together, so the same-node case never resets. */
  $effect(() => {
    const n = selectedNode;
    const id = n?.id ?? null;
    const modelKey = n && n.type === "llm_call" ? (n.model ?? "") : null;
    if (id === lastInspectedId && (modelKey === null || modelKey === ctxModelKey)) return;
    lastInspectedId = id;
    ctxModelKey = modelKey;
    const tabs = tabKeysFor(n);
    activeTab = tabs.includes(inspectorTabs.get(id ?? "") as TabKey)
      ? (inspectorTabs.get(id ?? "") as TabKey)
      : "basica";
    condRows =
      n && (n.type === "condition" || n.type === "loop")
        ? initCondRows(n.condition)
        : [];
    condAnd = n?.condition?.op === "logical" ? (n.condition as { and: boolean }).and !== false : true;
    paramRows = n && n.type === "pipeline" ? paramsToRows(n.params) : [];
    drafts = {
      system: n?.system ?? "",
      assistant: n?.assistant ?? "",
      provider: n?.provider ?? "",
      pipeline: n?.pipeline ?? "",
    };
    const cd = ctxData;
    if (n && n.type === "llm_call" && cd) {
      if (cd.isCustom) {
        ctxSelectDraft = "custom";
        ctxCustomMode = true;
        ctxCustomDraft = cd.selected ?? "";
      } else {
        ctxSelectDraft = cd.selected ?? "";
        ctxCustomMode = false;
        ctxCustomDraft = "";
      }
    } else {
      ctxSelectDraft = "";
      ctxCustomMode = false;
      ctxCustomDraft = "";
    }
  });

  function initCondRows(condition: unknown): CondRow[] {
    const rows = condAstToRows(condition);
    return rows.length > 0
      ? rows
      : [{ field: COND_DEFAULT_FIELD, op: COND_DEFAULT_OP, value: "", negated: false }];
  }

  function tabNameOf(k: TabKey): string {
    return TAB_NAMES.find(([key]) => key === k)?.[1] ?? k;
  }

  function onTabSelect(tab: TabKey): void {
    const n = selectedNode;
    if (!n) return;
    inspectorTabs.set(n.id, tab);
    activeTab = tab;
  }

  function onTabKeydown(e: KeyboardEvent, tab: TabKey): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const keys = tabKeysFor(selectedNode);
    const idx = keys.indexOf(tab);
    const dir = e.key === "ArrowRight" ? 1 : -1;
    onTabSelect(keys[(idx + dir + keys.length) % keys.length]!);
    void tick().then(() => {
      inspectorEl
        ?.querySelector(
          `[data-tab-panel="${activeTab}"] input, [data-tab-panel="${activeTab}"] select, [data-tab-panel="${activeTab}"] textarea, [data-tab-panel="${activeTab}"] button`,
        )
        ?.focus();
    });
  }

  /** Merge a patch with possibly-undefined field values into the node. */
  function updateNode(patch: Record<string, unknown>): void {
    const n = selectedNode;
    if (!n) return;
    store.actions.updateNode(n.id, patch as Partial<GraphNode>);
  }

  function onModelChange(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v) updateNode({ model: v });
  }

  function onModeSelect(mode: string): void {
    if (mode === "generate") updateNode({ mode: undefined });
    else updateNode({ mode });
  }

  function onTextInput(key: "system" | "assistant" | "provider", e: Event): void {
    const raw = (e.currentTarget as HTMLTextAreaElement | HTMLInputElement).value;
    if (key === "system") drafts.system = raw;
    else if (key === "assistant") drafts.assistant = raw;
    else drafts.provider = raw;
    const v = raw.trim();
    updateNode(v ? { [key]: v } : { [key]: undefined });
  }

  function onPipelineInput(e: Event): void {
    const raw = (e.currentTarget as HTMLInputElement).value;
    drafts.pipeline = raw;
    updateNode({ pipeline: raw.trim() || undefined });
  }

  function writeCtx(val: string): void {
    const n = selectedNode;
    if (!n) return;
    const params: Record<string, string> = { ...(n.params ?? {}) };
    if (val === "") delete params.ctx;
    else params.ctx = val;
    updateNode(Object.keys(params).length > 0 ? { params } : { params: undefined });
  }

  function onCtxChange(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const val = sel.value;
    ctxSelectDraft = val;
    if (val === "custom") {
      ctxCustomMode = true;
      // re-commit the typed draft exactly like legacy re-reading the input
      writeCtx(ctxCustomDraft);
    } else {
      ctxCustomMode = false;
      ctxCustomDraft = "";
      writeCtx(val);
    }
  }

  function onCtxCustomInput(e: Event): void {
    const raw = (e.currentTarget as HTMLInputElement).value;
    ctxCustomDraft = raw;
    const n = parseInt(raw, 10);
    writeCtx(Number.isFinite(n) && n > 0 ? String(n) : "");
  }

  function onTargetChange(key: "on_429" | "tool_calls_route", e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    updateNode(v ? { [key]: v } : { [key]: undefined });
  }

  function onGuardChange(e: Event): void {
    const n = selectedNode;
    if (!n) return;
    const v = (e.currentTarget as HTMLSelectElement).value;
    store.actions.setEdgeGuard(n.id, v || null);
  }

  /* -- condition builder -- */

  function commitCond(): void {
    const n = selectedNode;
    if (!n || (n.type !== "condition" && n.type !== "loop")) return;
    const ast = condRowsToAst(condRows, condAnd);
    store.actions.updateNode(n.id, ast ? { condition: ast } : { condition: undefined });
  }

  const condPreview = $derived(condRowsToAst(condRows, condAnd));

  function setCondField(i: number, v: string): void {
    condRows[i].field = v;
    commitCond();
  }

  function setCondOp(i: number, v: string): void {
    condRows[i].op = v;
    commitCond();
  }

  function setCondValue(i: number, v: string): void {
    condRows[i].value = v;
    commitCond();
  }

  function toggleCondNegate(i: number): void {
    condRows[i].negated = !condRows[i].negated;
    commitCond();
  }

  function setCondAnd(v: "and" | "or"): void {
    condAnd = v === "and";
    commitCond();
  }

  function focusCondField(idx: number | null): void {
    void tick().then(() => {
      const target = idx === null ? ".cond-row .cond-field" : `.cond-row[data-row="${idx}"] .cond-field`;
      (condBuilderEl?.querySelector(target) as HTMLElement | null)?.focus();
    });
  }

  function addCondRow(): void {
    condRows = [...condRows, { field: COND_DEFAULT_FIELD, op: COND_DEFAULT_OP, value: "", negated: false }];
    commitCond();
    focusCondField(condRows.length - 1);
  }

  function removeCondRow(i: number): void {
    const next = condRows.filter((_, x) => x !== i);
    if (next.length === 0) {
      next.push({ field: COND_DEFAULT_FIELD, op: COND_DEFAULT_OP, value: "", negated: false });
    }
    const focus = Math.min(i, next.length - 1);
    condRows = next;
    commitCond();
    focusCondField(focus);
  }

  /* -- pipeline params -- */

  function commitParams(): void {
    const n = selectedNode;
    if (!n || n.type !== "pipeline") return;
    const params = rowsToParams(paramRows);
    updateNode(Object.keys(params).length > 0 ? { params } : { params: undefined });
  }

  function setParamKey(i: number, v: string): void {
    paramRows[i].key = v;
    commitParams();
  }

  function setParamValue(i: number, v: string): void {
    paramRows[i].value = v;
    commitParams();
  }

  function focusParamKey(idx: number | null): void {
    void tick().then(() => {
      const target = idx === null ? ".param-row .param-key" : `.param-row[data-row="${idx}"] .param-key`;
      (paramRowsEl?.querySelector(target) as HTMLElement | null)?.focus();
    });
  }

  function addParamRow(): void {
    if (paramRows.length === 0 || paramRows[paramRows.length - 1]!.key.trim() !== "") {
      paramRows = [...paramRows, { key: "", value: "" }];
    }
    focusParamKey(paramRows.length - 1);
  }

  function removeParamRow(i: number): void {
    const next = paramRows.filter((_, x) => x !== i);
    if (next.length === 0) {
      next.push({ key: "", value: "" });
    }
    const focus = Math.min(i, next.length - 1);
    paramRows = next;
    commitParams();
    focusParamKey(focus);
  }

  /* -- loop members -- */

  function memberRemove(loopId: string, memberId: string): void {
    store.actions.removeLoopMember(loopId, memberId);
  }

  function memberLabel(id: string): string {
    const m = graph.nodes.find((x) => x.id === id);
    return m ? nodeChipLabel(m) : id;
  }

  /** Orphan destination options survive node deletion: shown read-only so a
   *  reference to a removed node is never silently lost. */
  function targetHas(x: string | undefined): boolean {
    return x !== undefined && !graph.nodes.some((n) => n.id === x);
  }
</script>

<section id="editor" class="view" aria-label="Editor de pipelines" data-testid="view-editor" hidden={hidden || undefined}>
  <div class="toolbar" role="toolbar" aria-label="Acciones del editor">
    <button id="btn-new" class="btn" title="Nuevo pipeline" onclick={onNew} data-testid="btn-new">Nuevo</button>
    <input
      id="pipeline-name"
      type="text"
      class="pipeline-name"
      aria-label="Nombre del pipeline"
      placeholder="Nombre del pipeline"
      bind:value={nameDraft}
    />
    <span class="toolbar-spacer" aria-hidden="true"></span>
    <button id="btn-undo" class="btn" disabled={!$store.canUndo} title="Deshacer (Ctrl+Z)" onclick={() => store.actions.undo()} data-testid="btn-undo">Deshacer</button>
    <button id="btn-redo" class="btn" disabled={!$store.canRedo} title="Rehacer (Ctrl+Y)" onclick={() => store.actions.redo()} data-testid="btn-redo">Rehacer</button>
    <button id="btn-validate" class="btn" onclick={runValidate} data-testid="btn-validate">Validar</button>
    <button id="btn-flow" class="btn" title="Ver el flujo del pipeline" onclick={runFlow} data-testid="btn-flow">Ver flujo</button>
    <button id="btn-apply" class="btn btn-primary" onclick={openApply} data-testid="btn-apply">Aplicar</button>
    <button id="btn-clear" class="btn" title="Limpiar el lienzo" onclick={onClear} data-testid="btn-clear">Limpiar</button>
  </div>

  <div class="editor-layout">
    <aside id="palette" class="palette" aria-label="Paleta de nodos">
      <h2 class="panel-title">Paleta de nodos</h2>
      <p class="hint" id="palette-hint">
        Arrastrá un nodo al lienzo o presioná su tecla numérica con el lienzo enfocado.
      </p>
      <div class="palette-section">
        <h3 class="palette-section-title">Bloques base</h3>
        <ul id="palette-list" class="palette-list" data-testid="palette-list">
          {#each PALETTE as item (item.type)}
            <li>
              <button
                type="button"
                class="palette-item"
                data-node-type={item.type}
                data-key={item.key}
                draggable="true"
                data-testid="palette-item"
                onclick={() => store.actions.addNode(item.type)}
                ondragstart={(e) => onPaletteDragStart(e, item.type)}
              >
                {item.label}
                <span class="shortcut">{item.key}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>

      <div class="switcher-section">
        <h3 class="palette-section-title">Nodos del grafo</h3>
        <div class="switcher-wrap">
          <button id="switcher-prev" class="switcher-arrow" aria-label="Anterior" onclick={() => scrollSwitcher(-1)}>‹</button>
          <div id="node-switcher" class="node-switcher" role="tablist" aria-label="Nodos del grafo" bind:this={switcherEl}>
            {#each graph.nodes as n (n.id)}
              <button
                type="button"
                class="node-chip"
                role="tab"
                aria-selected={selection.includes(n.id) ? "true" : "false"}
                class:active={selection.includes(n.id)}
                data-node-id={n.id}
                onclick={() => store.actions.select([n.id])}
              >
                {NODE_LABELS[n.type]}
              </button>
            {/each}
          </div>
          <button id="switcher-next" class="switcher-arrow" aria-label="Siguiente" onclick={() => scrollSwitcher(1)}>›</button>
        </div>
      </div>
    </aside>

    <div
      id="graph-canvas"
      class="graph-canvas"
      tabindex="0"
      aria-label="Lienzo del grafo"
      role="application"
      data-testid="graph-canvas"
      bind:this={canvasEl}
      onkeydown={onKeyDown}
      ondragover={(e) => e.preventDefault()}
      ondrop={onCanvasDrop}
    >
      {#if graph.nodes.length === 0}
        <p id="canvas-empty" class="canvas-empty">
          Arrastrá un nodo desde la paleta o presioná una tecla numérica (1–6).
        </p>
      {/if}

      <svg id="graph-svg" class="graph-svg" role="img" aria-label="Grafo del pipeline">
        <rect
          data-testid="canvas-background"
          class="canvas-background"
          x={-9999}
          y={-9999}
          width={19998}
          height={19998}
          fill="transparent"
          onpointerdown={onBackgroundPointerDown}
        />
        <g data-testid="viewport" transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
          {#each graph.edges as edge (edge.id ?? `${edge.from}>${edge.to}:${edge.guard ?? ""}`)}
            <g
              class="graph-edge"
              data-testid="graph-edge"
              data-guard={edge.guard ?? undefined}
              class:edge-invalid={connect?.invalid === true && connect?.fromId === edge.from}
            >
              <path class="graph-edge-curve" d={edgeCurve(edge)} />
              <path class="graph-edge-tip" d={edgeTip(edge)} />
            </g>
          {/each}

          {#if connect}
            <path
              class="graph-edge graph-edge-preview"
              data-testid="edge-preview"
              class:edge-invalid={connect.invalid}
              d={`${bezierEdge(connect.from.x, connect.from.y, connect.cur.x, connect.cur.y)}`}
            />
          {/if}

          {#each graph.nodes as n (n.id)}
            <g
              class="graph-node"
              data-type={n.type}
              data-node-id={n.id}
              class:selected={selection.includes(n.id)}
              class:edge-invalid={connect?.invalid === true && connect?.fromId === n.id}
              class:flow-active={flowClass(n.id) === "flow-active"}
              class:flow-past={flowClass(n.id) === "flow-past"}
              transform={`translate(${n.pos!.x} ${n.pos!.y})`}
              onpointerdown={(e) => onNodePointerDown(e, n)}
            >
              <rect class="node-rect" width={NODE_W} height={NODE_H} rx="10" />
              <text
                class="node-title"
                x={NODE_W / 2}
                y={nodeSubtitle(n) ? 23 : NODE_H / 2}
                dominant-baseline="middle"
                text-anchor="middle"
              >
                {NODE_LABELS[n.type]}{isCompleteNode(n) ? "" : " \u00b7"}
              </text>
              {#if nodeSubtitle(n)}
                <text
                  class="node-sub node-sub--{n.type}"
                  x={NODE_W / 2}
                  y={42}
                  dominant-baseline="middle"
                  text-anchor="middle"
                >{nodeSubtitle(n)}</text>
              {/if}
              {#each nodeSockets(n) as s, i (s.guard ?? i)}
                <circle
                  class:port--input={!s.guard && s.cx === 0}
                  class:port--output={s.guard !== undefined || s.cx > 0}
                  class="port"
                  data-port={s.guard !== undefined || s.cx > 0 ? "out" : "in"}
                  data-guard={s.guard ?? undefined}
                  data-cond={s.guard ?? undefined}
                  cx={s.cx}
                  cy={s.cy}
                  r="7"
                  onpointerdown={(e) => onPortPointerDown(e, n)}
                />
              {/each}
              {#if ownerLoopId(graph.nodes, n.id) !== null && n.type !== "loop"}
                <text
                  class="member-move-up"
                  role="button"
                  tabindex="0"
                  aria-label="Subir bloque del bucle"
                  data-testid="member-move-up"
                  data-node-id={n.id}
                  x={NODE_W - 38}
                  y={NODE_H / 2 - 4}
                  text-anchor="middle"
                  onclick={(e) => {
                    e.stopPropagation();
                    memberMove(ownerLoopId(graph.nodes, n.id)!, n.id, -1);
                  }}
                  onpointerdown={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      memberMove(ownerLoopId(graph.nodes, n.id)!, n.id, -1);
                    }
                  }}
                >▲</text>
                <text
                  class="member-move-down"
                  role="button"
                  tabindex="0"
                  aria-label="Bajar bloque del bucle"
                  data-testid="member-move-down"
                  data-node-id={n.id}
                  x={NODE_W - 18}
                  y={NODE_H / 2 + 5}
                  text-anchor="middle"
                  onclick={(e) => {
                    e.stopPropagation();
                    memberMove(ownerLoopId(graph.nodes, n.id)!, n.id, 1);
                  }}
                  onpointerdown={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      memberMove(ownerLoopId(graph.nodes, n.id)!, n.id, 1);
                    }
                  }}
                >▼</text>
              {/if}
            </g>
          {/each}
        </g>
      </svg>

      {#each loopOverlays as overlay (overlay.id)}
        <div class="loop-container-group" data-id={overlay.id} style={overlayStyle(overlay.rect)}>
          <div class="loop-container">
            <span class="loop-title">
              Bucle - {overlay.count} {overlay.count === 1 ? "bloque" : "bloques"}
            </span>
            <button type="button" class="loop-add" onclick={() => loopAddBlock(overlay.id)}>
              {overlay.count === 0 ? "+ Agregar bloque" : "+ Agregar otro bloque"}
            </button>
          </div>
        </div>
      {/each}
    </div>

    <aside
      id="inspector"
      class="inspector"
      aria-label="Inspector de nodos"
      data-testid="node-inspector"
      bind:this={inspectorEl}
    >
      <h2 class="panel-title">Inspector</h2>
      {#if selectedNode}
        <div class="inspector-header">
          <h3 class="inspector-title">{nodeTypeLabel(selectedNode.type)}</h3>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="Cerrar inspector"
            data-testid="close-inspector"
            onclick={() => store.actions.select([])}
          >&times;</button>
        </div>
        {#if selectedNode.type === "llm_call"}
          <div class="inspector-tabs" role="tablist" aria-label="Secciones del nodo">
            {#each tabKeysFor(selectedNode) as tab (tab)}
              <button
                type="button"
                role="tab"
                class="tab-btn"
                data-tab={tab}
                class:active={activeTab === tab}
                aria-selected={activeTab === tab}
                aria-controls={"tab-panel-" + tab}
                tabindex={activeTab === tab ? 0 : -1}
                onclick={() => onTabSelect(tab)}
                onkeydown={(e) => onTabKeydown(e, tab)}
              >{tabNameOf(tab)}</button>
            {/each}
          </div>

          {#if activeTab === "basica"}
            <div id="tab-panel-basica" class="tab-panel" role="tabpanel" aria-label="Config. básica">
              <div class="field">
                <label class="field-label" for="node-model">Modelo</label>
                <select id="node-model" class="select" data-testid="node-model" onchange={onModelChange}>
                  <option value="" selected={!selectedNode.model}>— sin modelo —</option>
                  {#each models as m (m.id)}
                    <option value={m.id} selected={selectedNode.model === m.id}>{m.id}</option>
                  {/each}
                </select>
              </div>

              <div class="field">
                <span class="field-label" id="mode-label">Modo</span>
                <div class="mode-pills" role="group" aria-labelledby="mode-label">
                  {#each MODES as [val, label, hint] (val)}
                    <button
                      type="button"
                      class="mode-pill"
                      data-mode={val}
                      data-testid="node-mode"
                      class:active={(selectedNode.mode ?? "generate") === val}
                      title={hint}
                      onclick={() => onModeSelect(val)}
                    >{label}</button>
                  {/each}
                </div>
              </div>

              {#if ctxData}
                <div class="field">
                  <label class="field-label" for="node-ctx">Contexto (tokens)</label>
                  <select id="node-ctx" class="select" data-testid="node-ctx" onchange={onCtxChange}>
                    <option value="" selected={ctxSelectDraft === ""}>predeterminado</option>
                    {#each ctxData.opts as o (o.value)}
                      <option value={o.value} class:ctx-unsafe={o.unsafe} selected={ctxSelectDraft === o.value}>{o.label}</option>
                    {/each}
                    <option value="custom" selected={ctxSelectDraft === "custom"}>personalizado…</option>
                  </select>
                  {#if ctxCustomMode}
                    <input
                      type="number"
                      min="1"
                      step="1"
                      class="text-input"
                      placeholder="ej. 6000"
                      data-testid="node-ctx-custom"
                      value={ctxCustomDraft}
                      oninput={onCtxCustomInput}
                    />
                    {#if ctxCustomDraft !== "" && ctxData.isUnsafe(ctxCustomDraft)}
                      <p class="ctx-unsafe" data-testid="ctx-unsafe-warning">
                        ⚠ Más del máximo del modelo ({ctxData.hwMax!.toLocaleString()} tokens) — la generación puede fallar.
                      </p>
                    {/if}
                  {/if}
                </div>
              {/if}
            </div>
          {/if}

          {#if activeTab === "prompt"}
            <div id="tab-panel-prompt" class="tab-panel" role="tabpanel" aria-label="Prompt">
              <div class="field">
                <label class="field-label" for="node-system">System prompt</label>
                <textarea
                  id="node-system"
                  class="text-input"
                  rows="4"
                  data-testid="node-system"
                  oninput={(e) => onTextInput("system", e)}
                >{drafts.system}</textarea>
                <span class="char-counter" data-testid="system-counter">{drafts.system.length}</span>
              </div>

              <div class="field">
                <label class="field-label" for="node-assistant">Assistant (rol del asistente)</label>
                <textarea
                  id="node-assistant"
                  class="text-input"
                  rows="3"
                  data-testid="node-assistant"
                  oninput={(e) => onTextInput("assistant", e)}
                >{drafts.assistant}</textarea>
              </div>
            </div>
          {/if}

          {#if activeTab === "avanzado"}
            <div id="tab-panel-avanzado" class="tab-panel" role="tabpanel" aria-label="Avanzado">
              <div class="field">
                <label class="field-label" for="node-provider">Proveedor (server de la API)</label>
                <input
                  id="node-provider"
                  class="text-input"
                  data-testid="node-provider"
                  value={drafts.provider}
                  oninput={(e) => onTextInput("provider", e)}
                />
              </div>

              <div class="field">
                <label class="field-label" for="node-on429">Si da 429 (rate limit)</label>
                <select id="node-on429" class="select" data-testid="node-on429" onchange={(e) => onTargetChange("on_429", e)}>
                  <option value="" selected={!selectedNode.on_429}>— (finalizar)</option>
                  {#each graph.nodes as g (g.id)}
                    <option value={g.id} selected={selectedNode.on_429 === g.id}>{nodeIdForSelect(g)}</option>
                  {/each}
                  {#if targetHas(selectedNode.on_429)}
                    <option value={selectedNode.on_429} selected>(nodo inexistente)</option>
                  {/if}
                </select>
              </div>

              <div class="field">
                <label class="field-label" for="node-toolroute">Si pide tool calls</label>
                <select id="node-toolroute" class="select" data-testid="node-toolroute" onchange={(e) => onTargetChange("tool_calls_route", e)}>
                  <option value="" selected={!selectedNode.tool_calls_route}>— (finalizar)</option>
                  {#each graph.nodes as g (g.id)}
                    <option value={g.id} selected={selectedNode.tool_calls_route === g.id}>{nodeIdForSelect(g)}</option>
                  {/each}
                  {#if targetHas(selectedNode.tool_calls_route)}
                    <option value={selectedNode.tool_calls_route} selected>(nodo inexistente)</option>
                  {/if}
                </select>
              </div>

              <div class="field">
                <label class="field-label" for="node-guard">Condición de salida</label>
                <select id="node-guard" class="select" data-testid="node-guard" onchange={onGuardChange}>
                  <option value="" selected={outgoingGuard === ""}>— (continuar)</option>
                  {#each graph.nodes as g (g.id)}
                    <option value={g.id} selected={outgoingGuard === g.id}>{nodeIdForSelect(g)}</option>
                  {/each}
                </select>
              </div>
            </div>
          {/if}
        {:else if selectedNode.type === "condition" || selectedNode.type === "loop"}
          <div class="field" bind:this={condBuilderEl}>
            <span class="field-label">{selectedNode.type === "loop" ? "Se ejecuta cuando:" : "Sale cuando:"}</span>
            <ul class="cond-rows">
              {#each condRows as row, i (i)}
                <li class="cond-row" class:cond-row--invalid={!condRowComplete(row)} data-row={i}>
                  {#if row.negated}
                    <button
                      type="button"
                      class="cond-negate"
                      data-testid="cond-negate"
                      data-row={i}
                      title="Quitar negación"
                      onclick={() => toggleCondNegate(i)}
                    >no</button>
                  {/if}
                  <select class="cond-field" data-testid="cond-field" data-row={i} onchange={(e) => setCondField(i, (e.currentTarget as HTMLSelectElement).value)}>
                    {#each ctxFields as f (f)}
                      <option value={f} selected={row.field === f}>{campoLegible(f)}</option>
                    {/each}
                  </select>
                  <select class="cond-op" data-testid="cond-op" data-row={i} onchange={(e) => setCondOp(i, (e.currentTarget as HTMLSelectElement).value)}>
                    {#each compareOps as op (op)}
                      <option value={op} selected={row.op === op}>{operadorLegible(op)}</option>
                    {/each}
                  </select>
                  <input
                    type="text"
                    class="cond-value"
                    placeholder="valor…"
                    data-testid="cond-value"
                    data-row={i}
                    value={row.value}
                    oninput={(e) => setCondValue(i, (e.currentTarget as HTMLInputElement).value)}
                  />
                  {#if !condRowComplete(row)}
                    <p class="cond-row-error" data-testid="cond-row-error">Completá campo, operador y valor.</p>
                  {/if}
                  <button
                    type="button"
                    class="cond-remove"
                    data-testid="cond-remove"
                    data-row={i}
                    title="Borrar fila"
                    onclick={() => removeCondRow(i)}
                  >&times;</button>
                </li>
              {/each}
            </ul>
            {#if condRows.length > 1}
              <select
                class="cond-combine"
                aria-label="Combinación de condiciones"
                data-testid="cond-combine"
                onchange={(e) => setCondAnd((e.currentTarget as HTMLSelectElement).value as "and" | "or")}
              >
                <option value="and" selected={condAnd}>todas (Y)</option>
                <option value="or" selected={!condAnd}>cualquiera (O)</option>
              </select>
            {/if}
            <button type="button" class="cond-add" data-testid="cond-add" onclick={addCondRow}>
              + Agregar otra condición
            </button>
            <p class="cond-preview" data-testid="cond-preview">
              {condRows.every(condRowComplete) ? describeCondition(condPreview) : "\u2026"}
            </p>
          </div>

          {#if selectedNode.type === "loop"}
            <div class="field">
              <span class="field-label">Bloques del bucle ({selectedNode.body?.length ?? 0})</span>
              <ul class="loop-members">
                {#each selectedNode.body ?? [] as memberId (memberId)}
                  <li class="loop-member" data-member-id={memberId}>
                    <span class="loop-member-name">{memberLabel(memberId)}</span>
                    <span class="loop-member-buttons">
                      <button
                        type="button"
                        class="icon-btn"
                        title="Subir"
                        data-testid="loop-member-up"
                        onclick={() => store.actions.reorderLoopMember(selectedNode.id, memberId, -1)}
                      >▲</button>
                      <button
                        type="button"
                        class="icon-btn"
                        title="Bajar"
                        data-testid="loop-member-down"
                        onclick={() => store.actions.reorderLoopMember(selectedNode.id, memberId, 1)}
                      >▼</button>
                      <button
                        type="button"
                        class="icon-btn icon-btn--danger"
                        title="Sacar del bucle"
                        data-testid="loop-member-remove"
                        onclick={() => memberRemove(selectedNode.id, memberId)}
                      >×</button>
                    </span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {:else if selectedNode.type === "pipeline"}
          <div class="field">
            <label class="field-label" for="pipeline-name-node">Nombre del pipeline</label>
            <input
              id="pipeline-name-node"
              class="text-input pipeline-name"
              data-testid="pipeline-name"
              value={drafts.pipeline}
              oninput={onPipelineInput}
            />
          </div>

          <div class="field" bind:this={paramRowsEl}>
            <span class="field-label">Parámetros</span>
            <ul class="param-rows">
              {#each paramRows as row, i (i)}
                <li class="param-row" data-row={i}>
                  <input
                    type="text"
                    class="param-key"
                    placeholder="key"
                    data-testid="param-key"
                    data-row={i}
                    value={row.key}
                    oninput={(e) => setParamKey(i, (e.currentTarget as HTMLInputElement).value)}
                  />
                  <input
                    type="text"
                    class="param-value"
                    placeholder="valor"
                    data-testid="param-value"
                    data-row={i}
                    value={row.value}
                    oninput={(e) => setParamValue(i, (e.currentTarget as HTMLInputElement).value)}
                  />
                  <button
                    type="button"
                    class="param-remove"
                    data-testid="param-remove"
                    data-row={i}
                    title="Quitar parámetro"
                    onclick={() => removeParamRow(i)}
                  >&times;</button>
                </li>
              {/each}
            </ul>
            <button type="button" class="param-add" data-testid="param-add" onclick={addParamRow}>
              + Agregar parámetro
            </button>
          </div>

          <div class="field">
            <label class="field-label" for="node-guard">Condición de salida</label>
            <select id="node-guard" class="select" data-testid="node-guard" onchange={onGuardChange}>
              <option value="" selected={outgoingGuard === ""}>— (continuar)</option>
              {#each graph.nodes as g (g.id)}
                <option value={g.id} selected={outgoingGuard === g.id}>{nodeIdForSelect(g)}</option>
              {/each}
            </select>
          </div>
        {:else if selectedNode.type === "start"}
          <p class="hint">El pipeline arranca acá.</p>
        {:else if selectedNode.type === "end"}
          <p class="hint">El pipeline termina acá.</p>
        {:else}
          <p class="hint">Nodo de control — no requiere configuración.</p>
        {/if}
        <div class="inspector-actions">
          <button
            type="button"
            class="btn btn-danger btn-sm"
            data-testid="delete-node"
            onclick={() => {
              if (selectedNode) store.actions.deleteNode(selectedNode.id);
            }}
          >Eliminar nodo</button>
        </div>
      {:else}
        <p class="hint">Seleccioná un nodo en el lienzo para ver y editar sus propiedades.</p>
      {/if}
    </aside>
  </div>

  <dialog id="validate-dialog" class="dialog" bind:this={validateDialog} data-testid="validate-dialog">
    <div class="dialog-content">
      <h2 class="panel-title dialog-title">Validación</h2>
      {#if $store.validation}
        {#if $store.validation.valid}
          <p class="validation-result" data-state="valid">El pipeline es válido.</p>
        {:else}
          <ul class="validation-errors">
            {#each $store.validation.errors ?? [] as error (error)}
              <li class="validation-result" data-state="invalid" data-testid="validation-error">
                {error}
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="hint">Validando…</p>
      {/if}
      <div class="dialog-actions">
        <button class="btn" onclick={() => validateDialog?.close()} data-testid="btn-close-validate">Cerrar</button>
      </div>
    </div>
  </dialog>

  <dialog id="apply-dialog" class="dialog" bind:this={applyDialog} data-testid="apply-dialog">
    <div class="dialog-content">
      <h2 class="panel-title dialog-title">Aplicar cambios</h2>
      <p>¿Aplicar el pipeline actual a la configuración del servidor?</p>
      {#if $store.applyError}
        <p class="validation-error" data-testid="apply-error">{$store.applyError}</p>
      {/if}
      <div class="dialog-actions">
        <button class="btn" onclick={closeApply}>Cancelar</button>
        <button id="btn-confirm-apply" class="btn btn-primary" onclick={confirmApply} data-testid="btn-confirm-apply">
          Aplicar cambios
        </button>
      </div>
    </div>
  </dialog>
</section>