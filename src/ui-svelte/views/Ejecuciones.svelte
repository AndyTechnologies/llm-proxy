<script lang="ts">
  /**
   * Ejecuciones view — execution history + retry (tasks 3.3/3.6, verify
   * scenario 9).
   *
   * A failed row whose failed step node arrived via SSE step:failed
   * (recorded in the store's failedNodes map) gets a retry control; retrying
   * posts the retry through the dashboard store and revalidates the list.
   * The list API exposes no steps, so without the SSE record there is no
   * retry target (the store no-ops).
   */
  import type { DashboardStore } from "../stores/dashboard-store.js";

  let { store, hidden = false }: { store: DashboardStore; hidden?: boolean } = $props();

  /** Row whose retry is pending (drives the disabled/error rendering). */
  let activeRetryId = $state<string | null>(null);

  function statusTone(status: string): string {
    return status === "completed" ? "active" : "inactive";
  }

  function retry(executionId: string): void {
    activeRetryId = executionId;
    void store.actions.retryStep(executionId);
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
          {#if $store.failedNodes[execution.id]}
            <button
              type="button"
              class="btn btn-small"
              disabled={$store.retrying && activeRetryId === execution.id}
              onclick={() => retry(execution.id)}
              aria-label={`Reintentar ${execution.pipelineId}`}
              data-testid={`retry-step-${execution.id}`}
            >
              {#if $store.retrying && activeRetryId === execution.id}Reintentando…{:else}Reintentar{/if}
            </button>
            {#if activeRetryId === execution.id && $store.retryError}
              <span class="secondary" data-testid={`retry-error-${execution.id}`}>{$store.retryError}</span>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>