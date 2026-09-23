<script lang="ts">
  /**
   * Execution history for one workflow: real rows from GET
   * /api/workflows/:name/logs. Every executed run (ok or error) wrote a row
   * server-side, so this modal shows successes and failures honestly.
   */
  import { ApiError, workflowLogs } from "../../lib/api/index.js";
  import type { ExecutionLogRow } from "../../lib/api/index.js";
  import { formatMs, formatUpdatedAt } from "../../lib/workflows-ui.js";
  import Button from "../common/Button.svelte";
  import IconButton from "../common/IconButton.svelte";
  import StatusDot from "../common/StatusDot.svelte";
  import { trapFocus } from "../../lib/focus-trap.js";

  let {
    name,
    onClose,
  }: {
    name: string;
    /** Close without effects — logs are read-only; the row lifespan is short. */
    onClose: () => void;
  } = $props();

  /** Static skeleton rows shown while the first load is in flight. */
  const SKELETON_ROWS = 3;
  const skeletons = Array.from({ length: SKELETON_ROWS });

  let rows = $state<ExecutionLogRow[] | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let attempt = $state(0);
  let dialogEl = $state<HTMLDivElement>();
  let lastFocused: HTMLElement | null = null;

  /** Monotonic request id: a slower older refresh never overwrites a newer one. */
  let requestSeq = 0;

  function errorText(err: unknown): string {
    if (err instanceof ApiError) {
      return err.status > 0 ? `${err.message} (HTTP ${err.status})` : err.message;
    }
    return "request failed";
  }

  async function load(): Promise<void> {
    const seq = ++requestSeq;
    loading = true;
    error = null;
    try {
      rows = await workflowLogs(name);
    } catch (err) {
      if (seq === requestSeq) error = errorText(err);
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  // Initial load + manual retry (an attempt bump re-runs this effect).
  $effect(() => {
    void attempt;
    void load();
  });

  // Dialog wiring: capture focus, move it into the dialog, keep Tab inside it,
  // close on Escape. Focus restoration happens in close(), while the dialog
  // is still mounted.
  $effect(() => {
    lastFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => dialogEl?.focus());
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    const release = dialogEl === undefined ? undefined : trapFocus(dialogEl);
    return () => {
      window.removeEventListener("keydown", onKey);
      release?.();
    };
  });

  function close(): void {
    lastFocused?.focus();
    onClose();
  }

  function refresh(): void {
    attempt += 1;
  }
</script>

<div class="backdrop" onclick={close}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="logs-title"
    tabindex="-1"
    bind:this={dialogEl}
    onclick={(event) => event.stopPropagation()}
  >
    <div class="dialog-head">
      <h2 class="dialog-title" id="logs-title">Logs — {name}</h2>
      <IconButton name="close" label="Close" onclick={close} />
    </div>

    <div class="dialog-body">
      {#if error !== null}
        <div class="state" role="alert">
          <p class="error-text">{error}</p>
          <Button variant="secondary" onclick={refresh}>Retry</Button>
        </div>
      {:else if rows === null}
        <ul class="log-list" aria-busy="true">
          {#each skeletons as _skel, i (i)}
            <li class="log-row" aria-hidden="true">
              <span class="sk sk-status"></span>
              <span class="sk sk-started"></span>
              <span class="sk sk-ms"></span>
            </li>
          {/each}
        </ul>
        <p class="sr-only">Loading logs…</p>
      {:else if rows.length === 0}
        <p class="note">No runs yet. Run this workflow to see execution history here.</p>
      {:else}
        <ul class="log-list">
          {#each rows as entry (entry.id)}
            <li class="log-row">
              <StatusDot tone={entry.status} label={entry.status} />
              <span class="cell-started">{formatUpdatedAt(entry.startedAt)}</span>
              <span class="cell-ms">{formatMs(entry.ms)}</span>
              {#if entry.status === "error" && entry.error !== null && entry.error !== ""}
                <span class="cell-error">{entry.error}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="dialog-foot">
      <Button variant="primary" onclick={close}>Close</Button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 15vh var(--space-4) var(--space-4);
    background: rgba(0, 0, 0, 0.6);
  }

  .dialog {
    width: min(640px, 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }

  .dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-2);
  }

  .dialog-title {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
    font-weight: 600;
  }

  .dialog-body {
    padding: var(--space-2) var(--space-4);
  }

  .dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4) var(--space-4);
  }

  .log-list {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 320px;
    overflow-y: auto;
  }

  .log-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: "status started ms";
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .log-row:last-child {
    border-bottom: 0;
  }

  .log-row > :first-child {
    grid-area: status;
  }

  .cell-started {
    grid-area: started;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .cell-ms {
    grid-area: ms;
    justify-self: end;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  /* Error detail owns a second grid row when present. */
  .log-row:has(.cell-error) {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "status started ms"
      "status error error";
  }

  .cell-error {
    grid-area: error;
    align-self: start;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .note {
    margin: 0;
    padding: var(--space-2) 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  /* Static skeleton blocks — no animation (reduced-motion safe). */
  .sk {
    display: block;
    background: var(--code);
    border-radius: var(--radius-control);
  }

  .sk-status {
    width: 72px;
    height: 12px;
  }

  .sk-started {
    width: 140px;
    height: 12px;
  }

  .sk-ms {
    width: 56px;
    height: 12px;
    justify-self: end;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>