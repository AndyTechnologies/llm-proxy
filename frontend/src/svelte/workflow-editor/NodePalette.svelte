<script lang="ts">
  import {
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    WORKFLOW_NODE_TYPES,
    type NodeType,
  } from "../../lib/workflow-nodes.js";

  /**
   * Palette panel (U05): the 14 node types grouped by category, click-to-add.
   * Adding happens at the canvas center (native HTML5 dragging fights the
   * SvelteFlow pane panning, so drag-and-drop is deliberately not used).
   */

  let { onAdd }: { onAdd: (type: NodeType) => void } = $props();
</script>

<aside class="palette" aria-label="Node palette">
  <h2 class="panel-title">Add node</h2>

  {#each CATEGORY_ORDER as category (category)}
    <section class="palette-group" aria-label={CATEGORY_LABELS[category]}>
      <h3 class="palette-category">{CATEGORY_LABELS[category]}</h3>
      <ul>
        {#each WORKFLOW_NODE_TYPES.filter((entry) => entry.category === category) as entry (entry.id)}
          <li>
            <button
              type="button"
              class="palette-item"
              data-palette={entry.id}
              title={entry.description}
              onclick={() => onAdd(entry.id)}
            >
              <span
                class="palette-chip"
                style={`background: var(--${entry.color});`}
                aria-hidden="true"
              ></span>
              <span class="palette-copy">
                <strong class="palette-label">{entry.label}</strong>
                <span class="palette-desc">{entry.description}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</aside>

<style>
  .panel-title {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--text);
  }

  .palette {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
  }

  .palette-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .palette-category {
    margin: 0;
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .palette-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--card);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .palette-item:hover {
    border-color: var(--border-hover);
    background: var(--accent-subtle);
  }

  .palette-item:focus-visible {
    outline: none;
    border-color: var(--accent);
  }

  .palette-chip {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 4px;
    border-radius: var(--radius-full);
  }

  .palette-copy {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .palette-label {
    font-size: 0.82rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .palette-desc {
    color: var(--secondary);
    font-size: 0.72rem;
    line-height: 1.4;
  }
</style>