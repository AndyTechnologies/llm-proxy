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
  import { ApiError, getWorkflow } from "../../lib/api/index.js";
  import {
    graphToFlow,
    nodeGroupOf,
    parseWorkflowYamlToGraph,
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
  import Button from "../common/Button.svelte";
  import EmptyState from "../common/EmptyState.svelte";
  import CanvasCommands from "./CanvasCommands.svelte";
  import Inspector from "./Inspector.svelte";
  import NodePalette from "./NodePalette.svelte";
  import FlowNodeStartEnd from "./nodes/FlowNodeStartEnd.svelte";
  import FlowNodeLlm from "./nodes/FlowNodeLlm.svelte";
  import FlowNodeBranch from "./nodes/FlowNodeBranch.svelte";
  import FlowNodeDataNode from "./nodes/FlowNodeData.svelte";
  import FlowNodePipeline from "./nodes/FlowNodePipeline.svelte";
  import FlowNodeOutput from "./nodes/FlowNodeOutput.svelte";

  /**
   * Workflow editor island (U05): reads a stored workflow through the typed
   * API client, converts it to canvas shape, and hosts the SvelteFlow
   * surface (canvas + palette + inspector) plus the shared node components.
   * Purely read/visual for now: adding nodes, connecting and deleting work
   * on the canvas model only — persistence lands in U07.
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

  /** `initialGraph` is applied exactly once and never again (non-reactive). */
  let seeded = false;

  const selectedNode = $derived(
    flowNodes.find((node) => node.id === selectedId) ?? null,
  );
  const emptyCanvas = $derived(status === "ready" && flowNodes.length === 0);
  const loading = $derived(status === "idle" || status === "loading");

  $effect(() => {
    if (workflowName === null) return;
    void loadWorkflow(workflowName);
  });

  $effect(() => {
    if (workflowName !== null || initialGraph === undefined || seeded) return;
    seeded = true;
    seedFromGraph(initialGraph);
  });

  function seedFromGraph(graph: GraphPipeline): void {
    const converted = graphToFlow(graph);
    flowNodes = converted.nodes;
    flowEdges = converted.edges;
    selectedId = null;
    errorMessage = "";
    status = "ready";
    fitQueued += 1;
  }

  async function loadWorkflow(name: string): Promise<void> {
    status = "loading";
    errorMessage = "";
    try {
      const record = await getWorkflow(name);
      const parsed = parseWorkflowYamlToGraph(record.yaml);
      if (!parsed.ok) {
        status = "error";
        errorMessage = parsed.error;
        return;
      }
      seedFromGraph(parsed.graph);
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
</script>

<div class="wf-layout" data-testid="workflow-flow-editor">
  {#if status === "error"}
    <div class="wf-error">
      <EmptyState icon="workflows" title="Could not load workflow" description={errorMessage}>
        <Button variant="secondary" onclick={() => (attempt += 1)}>Retry</Button>
      </EmptyState>
    </div>
  {:else}
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
      <Inspector node={selectedNode} />
    </aside>
  {/if}
</div>

<style>
  .wf-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    gap: var(--space-3);
    height: 100%;
    min-height: 460px;
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
      grid-template-rows: minmax(420px, 55vh) auto;
    }

    .wf-rail {
      overflow-y: visible;
    }
  }
</style>