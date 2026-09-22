<script lang="ts">
  import {
    Background,
    BackgroundVariant,
    Controls,
    MarkerType,
    MiniMap,
    SvelteFlow,
  } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import { ApiError, getWorkflow, listModels, saveWorkflow } from "../../lib/api/index.js";
  import {
    graphToFlow,
    nodeGroupOf,
    parseWorkflowYamlToGraph,
    patchNodeData,
    serializeGraphToYaml,
    uniqueEdgeId,
    type CanvasApi,
    type FlowEdge,
    type FlowNode,
    type FlowNodeData,
  } from "../../lib/workflow-flow.js";
  import {
    makeNodeId,
    nodeTypeDef,
    type AstExpr,
    type GraphPipeline,
    type NodeType,
  } from "../../lib/workflow-nodes.js";
  import { validateWorkflow } from "../../lib/workflow-validate.js";
  import Button from "../common/Button.svelte";
  import EmptyState from "../common/EmptyState.svelte";
  import Icon from "../common/Icon.svelte";
  import CanvasCommands from "./CanvasCommands.svelte";
  import Inspector from "./Inspector.svelte";
  import NodePalette from "./NodePalette.svelte";
  import RunPanel from "./RunPanel.svelte";
  import FlowNodeStartEnd from "./nodes/FlowNodeStartEnd.svelte";
  import FlowNodeLlm from "./nodes/FlowNodeLlm.svelte";
  import FlowNodeBranch from "./nodes/FlowNodeBranch.svelte";
  import FlowNodeDataNode from "./nodes/FlowNodeData.svelte";
  import FlowNodePipeline from "./nodes/FlowNodePipeline.svelte";
  import FlowNodeOutput from "./nodes/FlowNodeOutput.svelte";

  /**
   * Workflow editor island (U05 + U06): reads a stored workflow through the
   * typed API client, converts it to canvas shape, and hosts the SvelteFlow
   * surface (canvas + palette + inspector). U06 adds editing: the inspector
   * writes canvas state immediately; SAVE is explicit (button or Ctrl/Cmd+S),
   * gated by a client-side structural mirror (`validateWorkflow`) with the
   * backend as the authority (its 400 error envelope is shown verbatim).
   * Positions never dirty the graph JSON — geometry is not persisted.
   */

  const nodeTypes = {
    "wf-start-end": FlowNodeStartEnd,
    "wf-llm": FlowNodeLlm,
    "wf-branch": FlowNodeBranch,
    "wf-data": FlowNodeDataNode,
    "wf-pipeline": FlowNodePipeline,
    "wf-output": FlowNodeOutput,
  } as const;

  const edgeOptions = {
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
  } as const;

  let {
    workflowName,
    initialGraph,
  }: {
    /** Name of a stored workflow to load; null → seed from `initialGraph`. */
    workflowName: string | null;
    /** Optional engine graph to seed the canvas when no workflow is stored. */
    initialGraph?: GraphPipeline;
  } = $props();

  let flowNodes = $state<FlowNode[]>([]);
  let flowEdges = $state<FlowEdge[]>([]);
  let selectedId = $state<string | null>(null);
  let status = $state<"idle" | "loading" | "ready" | "error">("idle");
  let errorMessage = $state("");
  let attempt = $state(0);
  let fitQueued = $state(0);
  let canvasApi = $state<CanvasApi | null>(null);
  let hostEl: HTMLDivElement | undefined = $state();

  /** Last persisted version from the store (null → never saved this session). */
  let savedVersion = $state<number | null>(null);
  /** Semantic JSON snapshot of the last saved/loaded graph (drag ≠ dirty). */
  let savedGraphJson = $state<string | null>(null);
  let saving = $state(false);
  let saveFlash = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let errorsPanel = $state<{ title: string; items: string[] } | null>(null);
  let knownModelIds = $state<string[]>([]);
  /** The run drawer (U07) — mounted below the rail while open. */
  let runOpen = $state(false);

  /** `initialGraph` is applied exactly once and never again (non-reactive). */
  let seeded = false;

  const selectedNode = $derived(
    flowNodes.find((node) => node.id === selectedId) ?? null,
  );
  const emptyCanvas = $derived(status === "ready" && flowNodes.length === 0);
  const loading = $derived(status === "idle" || status === "loading");

  /** Canvas → engine graph with the real workflow identity stamped in. */
  function snapshotGraph(): string {
    const graph = flowToGraph(flowNodes, flowEdges);
    const name = workflowName ?? "workflow";
    graph.id = name;
    graph.name = name;
    return JSON.stringify(graph);
  }

  /** Unsaved = the current canvas semantics differ from the last saved state. */
  const dirty = $derived(savedGraphJson !== null && snapshotGraph() !== savedGraphJson);

  const canSave = $derived(
    status === "ready" && dirty && !saving && workflowName !== null,
  );

  $effect(() => {
    if (workflowName === null) return;
    void loadWorkflow(workflowName);
  });

  $effect(() => {
    if (workflowName !== null || initialGraph === undefined || seeded) return;
    seeded = true;
    seedFromGraph(initialGraph, null);
  });

  /** Best-effort local-registry model ids for the inspector datalist. */
  $effect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    void listModels()
      .then((rows) => {
        if (!cancelled) knownModelIds = rows.map((row) => row.id);
      })
      .catch(() => {
        if (!cancelled) knownModelIds = [];
      });
    return () => {
      cancelled = true;
    };
  });

  /** Ctrl/Cmd+S saves explicitly — the ONLY implicit affordance, never auto-save. */
  $effect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function seedFromGraph(graph: GraphPipeline, version: number | null): void {
    const converted = graphToFlow(graph);
    flowNodes = converted.nodes;
    flowEdges = converted.edges;
    selectedId = null;
    errorMessage = "";
    status = "ready";
    fitQueued += 1;
    savedVersion = version;
    savedGraphJson = snapshotGraph();
    errorsPanel = null;
  }

  async function loadWorkflow(name: string): Promise<void> {
    status = "loading";
    errorMessage = "";
    errorsPanel = null;
    try {
      const record = await getWorkflow(name);
      const parsed = parseWorkflowYamlToGraph(record.yaml);
      if (!parsed.ok) {
        status = "error";
        errorMessage = parsed.error;
        return;
      }
      seedFromGraph(parsed.graph, record.version);
    } catch (err) {
      status = "error";
      errorMessage =
        err instanceof ApiError
          ? err.status > 0
            ? `${err.message} (HTTP ${err.status})`
            : err.message
          : "request failed";
    }
  }

  function addNode(type: NodeType): void {
    const taken = new Set(flowNodes.map((node) => node.id));
    const id = makeNodeId(type, taken);
    const def = nodeTypeDef(type);
    const data: FlowNodeData = { wNodeType: type, label: def.label, values: {} };
    for (const [key, value] of Object.entries(def.defaults)) {
      if (value === undefined) continue;
      if (key === "condition" && (type === "condition" || type === "router")) {
        data.condition = value as AstExpr;
        continue;
      }
      if (key === "params" && type === "pipeline") {
        data.params = value as Record<string, string>;
        continue;
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        Array.isArray(value)
      ) {
        data.values[key] = value;
      }
    }
    const node: FlowNode = {
      id,
      type: nodeGroupOf(type),
      position: addPosition(),
      data,
    };
    flowNodes = [...flowNodes, node];
    selectedId = id;
  }

  /** New nodes land at the canvas center (or a deterministic fallback). */
  function addPosition(): { x: number; y: number } {
    if (canvasApi === null || hostEl === undefined) return { x: 40, y: 40 };
    const rect = hostEl.getBoundingClientRect();
    return canvasApi.screenToFlowPosition(
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      true,
    );
  }

  function onConnect({ source, target }: { source: string | null; target: string | null }): void {
    if (source === null || target === null || source === target) return;
    const taken = new Set(flowEdges.map((edge) => edge.id));
    flowEdges = [...flowEdges, { id: uniqueEdgeId(source, target, taken), source, target }];
  }

  function onSelectionChange({
    nodes,
  }: {
    nodes: readonly { id: string }[];
  }): void {
    selectedId = nodes[0]?.id ?? null;
  }

  /**
   * start/end are undeletable: strip them from the delete set (keyboard and
   * button deletion both flow through onBeforeDelete).
   */
  function onBeforeDelete({
    nodes,
    edges,
  }: {
    nodes: FlowNode[];
    edges: FlowEdge[];
  }): { nodes: FlowNode[]; edges: FlowEdge[] } {
    const deletable = nodes.filter(
      (node) => node.data.wNodeType !== "start" && node.data.wNodeType !== "end",
    );
    return { nodes: deletable, edges };
  }

  function updateNode(id: string, patch: Partial<FlowNodeData>): void {
    flowNodes = patchNodeData(flowNodes, id, patch);
  }

  /** Format a save failure from the ApiError envelope (verbatim backend text). */
  function formatSaveError(err: unknown): { title: string; items: string[] } {
    if (err instanceof ApiError) {
      const items = Array.isArray(err.errors) ? err.errors.map(String) : [];
      return { title: err.message, items };
    }
    return {
      title: "Save failed",
      items: [err instanceof Error ? err.message : "unknown error"],
    };
  }

  function flash(text: string): void {
    saveFlash = text;
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      saveFlash = null;
    }, 3000);
  }

  /**
   * Explicit save: structural mirror first (errors SHOWN BEFORE the request),
   * then serialize → PUT with the real workflow name stamped on the doc, and
   * surface the backend's own 400 envelope verbatim when it disagrees.
   */
  async function save(): Promise<void> {
    if (workflowName === null || saving || status !== "ready") return;
    const graph = flowToGraph(flowNodes, flowEdges);
    graph.id = workflowName;
    graph.name = workflowName;
    const check = validateWorkflow(
      graph,
      knownModelIds.length > 0 ? { knownModels: knownModelIds } : {},
    );
    if (!check.valid) {
      errorsPanel = { title: `Workflow "${workflowName}" does not validate`, items: check.errors };
      return;
    }
    saving = true;
    errorsPanel = null;
    try {
      const yaml = serializeGraphToYaml(graph);
      const result = await saveWorkflow(workflowName, yaml);
      savedVersion = result.version;
      savedGraphJson = snapshotGraph();
      flash(`Saved v${result.version}`);
    } catch (err) {
      errorsPanel = formatSaveError(err);
    } finally {
      saving = false;
    }
  }
</script>

<div class="wf-layout" data-testid="workflow-flow-editor">
  {#if status === "error"}
    <div class="wf-error">
      <EmptyState icon="workflows" title="Could not load workflow" description={errorMessage}>
        <Button variant="secondary" onclick={() => (attempt += 1)}>Retry</Button>
      </EmptyState>
    </div>
  {:else}
    <div class="wf-toolbar">
      <div class="wf-toolbar-left">
        <span class="wf-name">{workflowName ?? "Unnamed workflow"}</span>
        <code class="wf-version">v{savedVersion ?? "—"}</code>
        {#if dirty}
          <span class="wf-dirty" aria-live="polite">Unsaved changes</span>
        {/if}
        {#if saveFlash !== null}
          <span class="wf-flash" aria-live="polite">{saveFlash}</span>
        {/if}
      </div>
      <div class="wf-toolbar-actions">
        <Button
          variant="secondary"
          disabled={workflowName === null}
          ariaLabel="Run workflow"
          onclick={() => {
            runOpen = true;
          }}
        >
          <Icon name="play" size={14} />
          Run
        </Button>
        <Button variant="primary" disabled={!canSave} onclick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>

    {#if errorsPanel !== null}
      <div class="wf-errors" role="alert" aria-label="Save errors">
        <h3 class="wf-errors-title">{errorsPanel.title}</h3>
        {#if errorsPanel.items.length > 0}
          <ul class="wf-errors-list">
            {#each errorsPanel.items as item (item)}
              <li><code>{item}</code></li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <div class="wf-canvas" bind:this={hostEl} aria-label="Workflow canvas">
      {#if loading}
        <div class="wf-skeleton" aria-hidden="true">
          <span class="wf-skeleton-bar"></span>
          <span class="wf-skeleton-bar"></span>
          <span class="wf-skeleton-bar"></span>
        </div>
        <p class="sr-only">Loading workflow…</p>
      {:else}
        <SvelteFlow
          bind:nodes={flowNodes}
          bind:edges={flowEdges}
          {nodeTypes}
          onconnect={onConnect}
          onselectionchange={onSelectionChange}
          onbeforedelete={onBeforeDelete}
          {defaultEdgeOptions}
          defaultMarkerColor={null}
          minZoom={0.25}
          maxZoom={1.5}
          snapToGrid
          snapGrid={[16, 16]}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} />
          <MiniMap pannable zoomable />
          <Controls />
          <CanvasCommands
            queued={fitQueued}
            onReady={(api) => {
              canvasApi = api;
            }}
          />
        </SvelteFlow>
        {#if emptyCanvas}
          <div class="wf-canvas-hint">Empty canvas — add nodes from the palette.</div>
        {/if}
      {/if}
    </div>
    <aside class="wf-rail">
      <NodePalette onAdd={addNode} />
      <Inspector
        node={selectedNode}
        onUpdate={updateNode}
        canvasNodes={flowNodes}
        knownModelIds={knownModelIds}
      />
    </aside>
    {#if runOpen && workflowName !== null}
      <RunPanel
        name={workflowName}
        onClose={() => {
          runOpen = false;
        }}
      />
    {/if}
  {/if}
</div>

<style>
  .wf-layout {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: var(--space-3);
    height: 100%;
    min-height: 460px;
  }

  .wf-toolbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 36px;
  }

  .wf-toolbar-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .wf-toolbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }

  .wf-name {
    font-size: 0.92rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wf-version {
    flex: none;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--code);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.68rem;
  }

  .wf-dirty {
    flex: none;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--accent-subtle);
    color: var(--accent-hover);
    font-size: 0.7rem;
    font-weight: 600;
  }

  .wf-flash {
    flex: none;
    color: var(--success);
    font-size: 0.74rem;
  }

  .wf-errors {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--danger);
    border-radius: var(--radius-control);
    background: var(--code);
  }

  .wf-errors-title {
    margin: 0;
    color: var(--danger);
    font-size: 0.8rem;
    font-weight: 700;
  }

  .wf-errors-list {
    margin: 0;
    padding-left: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .wf-errors-list li {
    color: var(--secondary);
    font-size: 0.76rem;
    line-height: 1.5;
  }

  .wf-errors-list code {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }

  .wf-canvas {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
  }

  .wf-rail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  .wf-error {
    display: flex;
    align-items: flex-start;
    grid-column: 1 / -1;
  }

  .wf-skeleton {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-6);
    background: var(--card);
    pointer-events: none;
  }

  .wf-skeleton-bar {
    width: 48%;
    height: 12px;
    border-radius: var(--radius-full);
    background: var(--border);
  }

  .wf-skeleton-bar:nth-child(2) {
    width: 72%;
  }

  .wf-skeleton-bar:nth-child(3) {
    width: 58%;
  }

  .wf-canvas-hint {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 1;
    transform: translate(-50%, -50%);
    padding: var(--space-4) var(--space-6);
    border: 1px dashed var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
    color: var(--muted);
    font-size: 0.85rem;
    pointer-events: none;
  }

  /* SvelteFlow surface tokens — no raw colors, only the palette. */
  .wf-canvas :global(.svelte-flow) {
    --xy-background-pattern-dots-color: var(--border);
    --xy-node-background-color: var(--bg-code);
    --xy-node-border: 1px solid var(--border);
    --xy-node-color: var(--text);
    --xy-edge-stroke: var(--muted);
    --xy-edge-stroke-selected: var(--accent);
    --xy-connectionline-stroke: var(--accent);
    --xy-controls-button-background-color: var(--bg-code);
    --xy-controls-button-background-color-hover: var(--card);
    --xy-controls-button-color: var(--text);
    --xy-controls-button-color-hover: var(--text);
    --xy-controls-button-border-color: var(--border);
    --xy-controls-box-shadow: 0 0 0 1px var(--border);
    --xy-minimap-background-color: var(--code);
    --xy-minimap-mask-background-color: var(--bg);
    --xy-attribution-background-color: var(--card);
    --xy-attribution-link-color: var(--muted);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 1080px) {
    .wf-layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto auto minmax(420px, 55vh) auto;
    }

    .wf-rail {
      overflow-y: visible;
    }
  }
</style>