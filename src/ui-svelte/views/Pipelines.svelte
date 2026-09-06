<script lang="ts">
  /**
   * Pipelines view (svelte-ui task 3.3).
   *
   * Lists declared pipelines from the dashboard store; opening one loads it
   * into the editor store and routes to the editor view.
   */
  import type { DashboardStore } from "../stores/dashboard-store.js";
  import type { EditorStore } from "../stores/editor-store.js";

  let { store, editor, hidden = false }: { store: DashboardStore; editor: EditorStore; hidden?: boolean } = $props();

  function openPipeline(id: string): void {
    void editor.actions.loadPipeline(id);
    window.location.hash = "editor";
  }
</script>

<section
  id="pipelines"
  class="view"
  aria-label="Pipelines"
  data-testid="view-pipelines"
  hidden={hidden || undefined}
>
  <h2 class="panel-title">Pipelines</h2>
  {#if $store.pipelines.length === 0}
    <p class="hint">No hay pipelines registrados.</p>
  {:else}
    <div id="pipelines-list" class="list" role="list" data-testid="pipelines-list">
      {#each $store.pipelines as pipeline (pipeline.id)}
        <button
          type="button"
          role="listitem"
          class="list-item"
          data-pipeline-id={pipeline.id}
          data-testid={`pipeline-row-${pipeline.id}`}
          onclick={() => openPipeline(pipeline.id)}
        >
          <span class="primary">{pipeline.displayName ?? pipeline.id}</span>
          {#if pipeline.nodeCount !== undefined}
            <span class="secondary">{pipeline.nodeCount} nodos</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</section>