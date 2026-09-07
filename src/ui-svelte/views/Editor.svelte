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
    type GraphEdge,
  } from "../lib/graph-model.js";
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

  let { store, hidden = false }: { store: EditorStore; hidden?: boolean } = $props();

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
    // a position inside the container so the store buckets the new member
    store.actions.addNode("llm_call", {
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

  /** Node-scoped templates. */
  function nodeSockets(n: GraphNode): { cx: number; cy: number; guard?: string }[] {
    if (n.type === "condition") {
      const cs = conditionSockets(n.pos ?? { x: 0, y: 0 });
      return [
        { cx: cs.in.x - (n.pos?.x ?? 0), cy: cs.in.y - (n.pos?.y ?? 0) },
        { cx: cs.outTrue.x - (n.pos?.x ?? 0), cy: cs.outTrue.y - (n.pos?.y ?? 0), guard: "true" },
        { cx: cs.outFalse.x - (n.pos?.x ?? 0), cy: cs.outFalse.y - (n.pos?.y ?? 0), guard: "false" },
      ];
    }
    const sp = socketPositions(n.pos ?? { x: 0, y: 0 });
    return [
      { cx: sp.in.x - (n.pos?.x ?? 0), cy: sp.in.y - (n.pos?.y ?? 0) },
      { cx: sp.out.x - (n.pos?.x ?? 0), cy: sp.out.y - (n.pos?.y ?? 0) },
    ];
  }

  function edgePath(e: GraphEdge): string {
    const from = graph.nodes.find((n) => n.id === e.from);
    const to = graph.nodes.find((n) => n.id === e.to);
    if (!from?.pos || !to?.pos) return "";
    const start = outSocketFor(from, from.pos, e.guard);
    const end = { x: to.pos.x, y: to.pos.y + NODE_H / 2 };
    const d = bezierEdge(start.x, start.y, end.x, end.y);
    return `${d} L ${end.x} ${end.y + 10} L ${end.x - 9} ${end.y + 1} Z`; // arrowhead
  }
</script>

<section id="editor" class="view" aria-label="Editor de pipelines" data-testid="view-editor" hidden={hidden || undefined}>
  <div class="toolbar" role="toolbar" aria-label="Acciones del editor">
    <button id="btn-new" class="btn" title="Nuevo pipeline" onclick={onNew} data-testid="btn-new">Nuevo</button>
    <input
      id="pipeline-name"
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
          {#each graph.edges as edge (edge.id ?? `${edge.from}>${edge.to}`)}
            <path
              class="graph-edge"
              data-testid="graph-edge"
              d={edgePath(edge)}
              class:edge-invalid={connect?.invalid === true && connect?.fromId === edge.from}
            />
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
              <text class="node-title" x={NODE_W / 2} y={NODE_H / 2} dominant-baseline="middle" text-anchor="middle">
                {NODE_LABELS[n.type]}
              </text>
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

    <aside id="inspector" class="inspector" aria-label="Inspector de nodos" data-testid="node-inspector">
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
        <dl class="inspector-props">
          <div class="inspector-prop">
            <dt>ID</dt>
            <dd>{selectedNode.id}</dd>
          </div>
          {#if selectedNode.pos}
            <div class="inspector-prop">
              <dt>Posición</dt>
              <dd>({selectedNode.pos.x}, {selectedNode.pos.y})</dd>
            </div>
          {/if}
          {#if selectedNode.model}
            <div class="inspector-prop">
              <dt>Modelo</dt>
              <dd>{selectedNode.model}</dd>
            </div>
          {/if}
          {#if selectedNode.pipeline}
            <div class="inspector-prop">
              <dt>Pipeline</dt>
              <dd>{selectedNode.pipeline}</dd>
            </div>
          {/if}
          {#if selectedNode.condition}
            <div class="inspector-prop">
              <dt>Condición</dt>
              <dd class="inspector-code">{JSON.stringify(selectedNode.condition)}</dd>
            </div>
          {/if}
          {#if selectedNode.body && selectedNode.body.length > 0}
            <div class="inspector-prop">
              <dt>Bloques ({selectedNode.body.length})</dt>
              <dd>
                <ol class="inspector-list">
                  {#each selectedNode.body as memberId}
                    <li>{memberId}</li>
                  {/each}
                </ol>
              </dd>
            </div>
          {/if}
          {#if selectedNode.system}
            <div class="inspector-prop">
              <dt>System Prompt</dt>
              <dd class="inspector-code inspector-truncate">{selectedNode.system}</dd>
            </div>
          {/if}
        </dl>
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