<script lang="ts">
  /**
   * Workflow designer (Task 6.7, workflow-editor spec): palette sidebar,
   * SvelteFlow canvas, live validation, Inline cycle rejection, and
   * YAML import/export. All graph logic lives in the pure helpers
   * (frontend/src/lib/workflow-nodes.ts) and is unit-tested there.
   */
  import { SvelteFlow } from "@xyflow/svelte";
  import type { Connection } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import type { NodeType } from "../../../src/orchestrator/graph.js";
  import {
    PALETTE,
    editorToYaml,
    flowEdgeFrom,
    graphEdgeFrom,
    makeEditorNode,
    validateEditorGraph,
    wouldCreateCycle,
    yamlToEditor,
  } from "../lib/workflow-nodes.js";
  import type { EditorNode, FlowEdge } from "../lib/workflow-nodes.js";

  let flowName = $state("demo");
  let nodes = $state<EditorNode[]>([]);
  let edges = $state<FlowEdge[]>([]);
  let yamlCode = $state("");
  let errorMessage = $state("");
  let validationErrors = $state<string[]>([]);
  const counters = new Map<string, number>();

  // Live engine validation of whatever is on the canvas right now.
  $effect(() => {
    validationErrors = validateEditorGraph(
      nodes,
      edges.map((edge) => graphEdgeFrom(edge)),
    );
  });

  function addNode(type: NodeType): void {
    const spacing = 28;
    nodes = [
      ...nodes,
      makeEditorNode(type, counters, {
        x: 40 + nodes.length * spacing,
        y: 80 + nodes.length * spacing,
      }),
    ];
  }

  function onConnect(connection: Connection): void {
    const source = connection.source;
    const target = connection.target;
    if (source === null || target === null) return;
    if (wouldCreateCycle({ nodes, edges: edges.map((e) => graphEdgeFrom(e)) }, source, target)) {
      errorMessage = `Connection ${source} -> ${target} would create a cycle and was rejected.`;
      return;
    }
    errorMessage = "";
    const edge = flowEdgeFrom({ from: source, to: target });
    edges = [...edges, { ...edge }];
  }

  function exportYaml(): void {
    if (nodes.length === 0) {
      errorMessage = "Nothing to export yet — add at least one node.";
      return;
    }
    errorMessage = "";
    yamlCode = editorToYaml(nodes, edges, flowName.trim() || "demo");
  }

  function importYaml(): void {
    const result = yamlToEditor(yamlCode);
    if (!result.ok) {
      errorMessage = result.error;
      return;
    }
    errorMessage = "";
    flowName = result.name;
    nodes = result.nodes;
    edges = result.edges;
  }
</script>

<section class="editor" data-testid="workflow-editor">
  <aside class="editor-palette" aria-label="Node palette">
    <h3>Palette</h3>
    <ul>
      {#each PALETTE as entry (entry.type)}
        <li>
          <button type="button" class="palette-item" data-palette={entry.type} onclick={() => addNode(entry.type)}>
            <strong>{entry.label}</strong>
            <span class="palette-desc">{entry.description}</span>
          </button>
        </li>
      {/each}
    </ul>
  </aside>

  <div class="editor-canvas" aria-label="Workflow canvas">
    <SvelteFlow
      bind:nodes
      bind:edges
      {onConnect}
      fitView
      minZoom={0.25}
      maxZoom={1.5}
      snapToGrid
      snapGrid={[16, 16]}
    />
  </div>

  <aside class="editor-panel" aria-label="Workflow properties">
    <h3>Workflow</h3>
    <label class="field">
      <span>Name</span>
      <input bind:value={flowName} data-testid="wf-name" placeholder="demo" />
    </label>

    {#if validationErrors.length > 0}
      <div class="errors" data-testid="wf-errors">
        <h4>Validation</h4>
        <ul>
          {#each validationErrors as err (err)}
            <li>{err}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if errorMessage !== ""}
      <p class="error" role="alert" data-testid="wf-error">{errorMessage}</p>
    {/if}

    <label class="field">
      <span>YAML</span>
      <textarea bind:value={yamlCode} rows={8} data-testid="wf-yaml" placeholder="Paste a workflow YAML doc or export one."></textarea>
    </label>
    <div class="actions">
      <button type="button" onclick={importYaml}>Import</button>
      <button type="button" onclick={exportYaml}>Export</button>
    </div>
  </aside>
</section>

<style>
  .editor {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr) 280px;
    gap: 12px;
    min-height: 460px;
  }
  .editor-palette ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .palette-item {
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    cursor: grab;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: border-color 150ms ease, background-color 150ms ease;
  }
  .palette-item:hover {
    border-color: var(--border-hover);
    background: var(--accent-soft);
  }
  .palette-desc {
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .editor-canvas {
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--bg-card);
    min-height: 460px;
    overflow: hidden;
  }
  .editor-panel h3,
  .editor-palette h3 {
    margin: 0 0 12px;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  .field span {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  input,
  textarea {
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: inherit;
    font: inherit;
    transition: border-color 150ms ease, background-color 150ms ease;
  }
  input:focus-visible,
  textarea:focus-visible {
    outline: none;
    border-color: var(--border-hover);
  }
  textarea {
    resize: vertical;
    background: var(--bg-code);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas;
    font-size: 0.78rem;
  }
  .errors {
    border: 1px solid var(--danger);
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 12px;
    color: var(--danger);
  }
  .errors ul {
    margin: 4px 0 0;
    padding-left: 20px;
    font-size: 0.82rem;
  }
  .error {
    color: var(--danger);
    font-size: 0.82rem;
    margin: 0 0 12px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: inherit;
    cursor: pointer;
    transition: border-color 150ms ease, background-color 150ms ease;
  }
  .actions button:hover {
    border-color: var(--border-hover);
    background: var(--accent-soft);
  }
  /* SvelteFlow ships light-theme defaults; remap its --xy-* variables to the
     dark Gentle-AI tokens so the canvas, nodes and controls blend with the
     editor surface. */
  .editor-canvas :global(.svelte-flow) {
    --xy-background-pattern-dots-color: var(--border);
    --xy-node-background-color: var(--bg-code);
    --xy-node-border: 1px solid var(--border);
    --xy-node-color: var(--text);
    --xy-handle-background-color: var(--accent);
    --xy-handle-border-color: var(--bg-card);
    --xy-edge-stroke: var(--text-tertiary);
    --xy-edge-stroke-selected: var(--accent);
    --xy-connectionline-stroke: var(--accent);
    --xy-selection-background-color: var(--accent-soft);
    --xy-controls-button-background-color: var(--bg-code);
    --xy-controls-button-background-color-hover: var(--bg-card);
    --xy-controls-button-color: var(--text);
    --xy-controls-button-color-hover: var(--text);
    --xy-controls-button-border-color: var(--border);
    --xy-controls-box-shadow: 0 0 0 1px var(--border);
  }
</style>