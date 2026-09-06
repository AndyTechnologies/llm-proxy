<script lang="ts">
  /**
   * Ejecuciones view (svelte-ui task 3.3).
   *
   * Execution history rows from the dashboard store; failed-execution retry
   * lands with task 3.6.
   */
  import type { DashboardStore } from "../stores/dashboard-store.js";

  let { store, hidden = false }: { store: DashboardStore; hidden?: boolean } = $props();

  function statusTone(status: string): string {
    return status === "completed" ? "active" : "inactive";
  }
</script>

<section
  id="executions"
  class="view"
  aria-label="Ejecuciones"
  data-testid="view-executions"
  hidden={hidden || undefined}
>
  <h2 class="panel-title">Ejecuciones</h2>
  {#if $store.executions.length === 0}
    <p class="hint">No hay ejecuciones registradas.</p>
  {:else}
    <div id="executions-list" class="list" role="list" data-testid="executions-list">
      {#each $store.executions as execution (execution.id)}
        <div class="list-item" role="listitem" data-execution-id={execution.id}>
          <span class="primary">{execution.pipelineId}</span>
          <span class="status status--{statusTone(execution.status)}">{execution.status}</span>
          {#if execution.totalLatencyMs !== undefined}
            <span class="secondary">{execution.totalLatencyMs} ms</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>