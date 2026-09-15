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
    gap: 6px;
  }
  .palette-item {
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    cursor: grab;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .palette-item:hover {
    border-color: var(--accent);
  }
  .palette-desc {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .editor-canvas {
    border: 1px solid var(--border);
    border-radius: 8px;
    min-height: 460px;
  }
  .editor-panel h3,
  .editor-palette h3 {
    margin: 0 0 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }
  .field span {
    font-size: 0.8rem;
    color: var(--muted);
  }
  input,
  textarea {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: inherit;
    font: inherit;
  }
  textarea {
    resize: vertical;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .errors {
    border: 1px solid var(--danger, #c0392b);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 10px;
  }
  .errors ul {
    margin: 4px 0 0;
    padding-left: 18px;
    font-size: 0.82rem;
  }
  .error {
    color: var(--danger, #c0392b);
    font-size: 0.82rem;
    margin: 0 0 10px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    cursor: pointer;
  }
  .actions button:hover {
    border-color: var(--accent);
  }
</style>