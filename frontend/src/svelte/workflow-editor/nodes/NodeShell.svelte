<script lang="ts">
  import { Handle, Position } from "@xyflow/svelte";
  import {
    hasSourceHandle,
    hasTargetHandle,
    type WorkflowNodeTypeDef,
  } from "../../../lib/workflow-nodes.js";

  /**
   * Shared chrome for every custom canvas node (U05): the type chip + label
   * header, the summary body lines, the mono id footer and the connection
   * handles (target left / source right, per the engine edge semantics).
   * Group components pass their own `entry` + `lines`; no DOM knowledge
   * lives in the taxonomy module.
   */

  let {
    entry,
    nodeId,
    selected,
    lines,
  }: {
    entry: WorkflowNodeTypeDef;
    nodeId: string;
    selected: boolean;
    lines: { key: string; value: string }[];
  } = $props();
</script>

<div class="w-node" class:selected>
  {#if hasTargetHandle(entry.id)}
    <Handle type="target" position={Position.Left} />
  {/if}

  <div class="w-node-head">
    <span class="w-node-chip" style={`background: var(--${entry.color});`}></span>
    <span class="w-node-title">{entry.label}</span>
  </div>

  <div class="w-node-body">
    {#if lines.length > 0}
      {#each lines as line (entry.id + line.key)}
        <div class="w-line" title={`${line.key}: ${line.value}`}>
          <span class="w-line-key">{line.key}</span>
          <span class="w-line-val">{line.value}</span>
        </div>
      {/each}
    {:else}
      <p class="w-node-note">{entry.description}</p>
    {/if}
  </div>

  <div class="w-node-id">{nodeId}</div>

  {#if hasSourceHandle(entry.id)}
    <Handle type="source" position={Position.Right} />
  {/if}
</div>

<style>
  .w-node {
    width: 208px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--bg-code);
    color: var(--text);
    font-family: var(--font-sans);
    box-shadow: 0 0 0 0 transparent;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .w-node.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-subtle);
  }

  .w-node-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .w-node-chip {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    flex: none;
  }

  .w-node-title {
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.2;
  }

  .w-node-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
  }

  .w-line {
    display: flex;
    gap: var(--space-2);
    max-width: 100%;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    line-height: 1.4;
  }

  .w-line-key {
    flex: none;
    color: var(--muted);
  }

  .w-line-val {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--secondary);
  }

  .w-node-note {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--muted);
  }

  .w-node-id {
    padding: 0 var(--space-3) var(--space-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    color: var(--muted);
  }
</style>