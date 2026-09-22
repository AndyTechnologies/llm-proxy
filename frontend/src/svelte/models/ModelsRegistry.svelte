<script lang="ts">
  /**
   * Models registry island (U08). Owns all data: every value comes from the
   * typed models client against the REAL /api/models surface — no local
   * truth, no invented telemetry (there is no GPU/VRAM/throughput data in
   * ModelStatus, so none is rendered). States are honest: static skeleton
   * rows while loading (no animation), the backend ApiError verbatim + Retry
   * on failure (with an explicit 401 "Authorization required" hint — the
   * models branch is auth-gated), "No models configured" only when the API
   * really returns []. Row actions POST the real activate/deactivate
   * endpoints with a transient per-row label, refresh the registry from the
   * API on success and report failures inline — never optimistic.
   */
  import {
    ApiError,
    activateModel,
    deactivateModel,
    listModels,
  } from "../../lib/api/index.js";
  import type { ModelStatus } from "../../lib/api/index.js";
  import {
    errorCell,
    formatPid,
    formatPort,
    modelRows,
    stateChip,
    summarizeModels,
  } from "../../lib/models-ui.js";
  import Button from "../common/Button.svelte";
  import EmptyState from "../common/EmptyState.svelte";
  import StatusDot from "../common/StatusDot.svelte";
  import ModelDetail from "./ModelDetail.svelte";

  /** Poll cadence for the registry (15s — models change rarely). */
  const AUTO_REFRESH_MS = 15_000;
  /** Skeleton rows rendered while the first load is in flight (static). */
  const SKELETON_ROWS = 4;

  const ACTION_KINDS = {
    activate: "activate",
    deactivate: "deactivate",
  } as const;

  type ActionKind = (typeof ACTION_KINDS)[keyof typeof ACTION_KINDS];

  const skeletons = Array.from({ length: SKELETON_ROWS });

  let rows = $state<ModelStatus[] | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** True when the last failure was HTTP 401 (auth-gated models branch). */
  let unauthorized = $state(false);
  let fetchedAt = $state<number | null>(null);
  /** Bumped by Refresh/Retry — re-runs the poll effect (and its timer). */
  let attempt = $state(0);

  /** Monotonic request id: a slower older refresh never overwrites a newer one. */
  let requestSeq = 0;

  /** Per-row in-flight action while a POST is outstanding. */
  let busy = $state<Record<string, ActionKind | undefined>>({});
  /** Per-row action failure — ApiError text, shown verbatim inline. */
  let rowActionError = $state<Record<string, string>>({});

  let detailId = $state<string | null>(null);

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
    unauthorized = false;
    try {
      const list = await listModels();
      if (seq !== requestSeq) return; // superseded by a newer refresh
      rows = list;
      fetchedAt = Date.now();
    } catch (err) {
      if (seq !== requestSeq) return;
      error = errorText(err);
      unauthorized = err instanceof ApiError && err.status === 401;
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  // Poll cycle: initial load + auto-refresh. The cleanup clears the timer on
  // teardown and whenever `attempt` (manual Refresh/Retry) re-runs the effect.
  // Auto-refresh itself is not animation, so it stays on for reduced-motion
  // users; nothing here animates.
  $effect(() => {
    void attempt;
    void load();
    const timer = setInterval(() => {
      void load();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  });

  function refresh(): void {
    attempt += 1;
  }

  function busyLabel(kind: ActionKind): string {
    return kind === ACTION_KINDS.activate ? "Activating…" : "Deactivating…";
  }

  /**
   * Run one real mutation (POST activate/deactivate), then refresh the
   * registry from the API. Failures land in the row verbatim; the row state
   * itself is never mutated optimistically.
   */
  async function runAction(model: ModelStatus, kind: ActionKind): Promise<void> {
    if (busy[model.id] !== undefined) return;
    delete rowActionError[model.id];
    busy[model.id] = kind;
    try {
      if (kind === ACTION_KINDS.activate) await activateModel(model.id);
      else await deactivateModel(model.id);
      await load(); // truth comes back from the API after every mutation
    } catch (err) {
      rowActionError[model.id] = errorText(err);
    } finally {
      delete busy[model.id];
    }
  }

  function openDetails(id: string): void {
    detailId = id;
  }

  function closeDetails(): void {
    detailId = null;
  }

  function formatClock(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString([], { hour12: false });
  }
</script>

<div class="registry" data-testid="models-registry">
  <div class="registry-toolbar">
    <p class="updated-label">
      {#if rows !== null && error === null && fetchedAt !== null}
        {rows.length} model{rows.length === 1 ? "" : "s"} ·
        Last updated {formatClock(fetchedAt)}
      {:else if error !== null}
        Registry unavailable
      {:else}
        —
      {/if}
    </p>
    <Button variant="secondary" ariaLabel="Refresh models" disabled={loading} onclick={refresh}>
      Refresh
    </Button>
  </div>

  {#if rows === null}
    {#if error !== null}
      <EmptyState icon="models" title="Unable to load models" description={error}>
        {#if unauthorized}
          <p class="auth-hint">
            Authorization required — configure WEAVELLM_AUTH properly on the
            backend to unlock this surface.
          </p>
        {/if}
        <Button variant="secondary" ariaLabel="Retry loading models" onclick={refresh}>
          Retry
        </Button>
      </EmptyState>
    {:else}
      <div class="rows" aria-busy="true">
        {#each skeletons as _skel, i (i)}
          <div class="row row-skeleton" aria-hidden="true">
            <span class="sk sk-id"></span>
            <span class="sk sk-state"></span>
            <span class="sk sk-pid"></span>
            <span class="sk sk-port"></span>
            <span class="sk sk-error"></span>
            <span class="sk sk-actions"></span>
          </div>
        {/each}
      </div>
      <p class="sr-only">Loading models…</p>
    {/if}
  {:else if rows.length === 0}
    <EmptyState
      icon="models"
      title="No models configured"
      description="Models registered in the backend appear here with their activation state."
    />
  {:else}
    {@const counts = summarizeModels(rows)}

    <div class="summary" aria-label="Registry summary">
      <div class="summary-cell">
        <span class="summary-value">{counts.total}</span>
        <span class="summary-label">Total</span>
      </div>
      <div class="summary-cell">
        <span class="summary-value">{counts.active}</span>
        <span class="summary-label">Active</span>
      </div>
      <div class="summary-cell">
        <span class="summary-value">{counts.disabled}</span>
        <span class="summary-label">Disabled</span>
      </div>
      <div class="summary-cell">
        <span class="summary-value">{counts.error}</span>
        <span class="summary-label">Error</span>
      </div>
    </div>

    {#if error !== null}
      <p class="error-banner" role="alert">{error}</p>
    {/if}

    <div class="rows" aria-busy={loading}>
      <div class="row row-head" aria-hidden="true">
        <span class="col-id">Model</span>
        <span class="col-state">State</span>
        <span class="col-pid">PID</span>
        <span class="col-port">Port</span>
        <span class="col-error">Error</span>
        <span class="col-actions">Actions</span>
      </div>

      {#each modelRows(rows) as row (row.id)}
        {@const chip = stateChip(row.state)}
        {@const kind = busy[row.id]}
        <div class="row">
          <span class="row-id" title={row.id}>{row.id}</span>
          <span class="row-state"><StatusDot tone={chip.tone} label={chip.label} /></span>
          <span class="row-pid mono">{formatPid(row.pid)}</span>
          <span class="row-port mono">{formatPort(row.port)}</span>
          <span class="row-error">
            {#if row.state === "error"}
              <span class="error-cell mono" title={row.error ?? ""}
                >{errorCell(row.error)}</span
              >
            {:else}
              <span class="muted">—</span>
            {/if}
          </span>
          <span class="row-actions">
            {#if row.state === "disabled"}
              <Button
                variant="secondary"
                disabled={kind !== undefined}
                ariaLabel={`Activate ${row.id}`}
                onclick={() => runAction(row, ACTION_KINDS.activate)}
              >
                {kind === ACTION_KINDS.activate ? busyLabel(kind) : "Activate"}
              </Button>
            {:else if row.state === "active"}
              <Button
                variant="secondary"
                disabled={kind !== undefined}
                ariaLabel={`Deactivate ${row.id}`}
                onclick={() => runAction(row, ACTION_KINDS.deactivate)}
              >
                {kind === ACTION_KINDS.deactivate ? busyLabel(kind) : "Deactivate"}
              </Button>
            {/if}
            <Button
              variant="ghost"
              ariaLabel={`Details for ${row.id}`}
              onclick={() => openDetails(row.id)}
            >
              Details
            </Button>
          </span>
          {#if rowActionError[row.id] !== undefined && rowActionError[row.id] !== ""}
            <span class="row-action-error" role="alert">{rowActionError[row.id]}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if detailId !== null}
  <ModelDetail modelId={detailId} onClose={closeDetails} />
{/if}

<style>
  .registry-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }

  .updated-label {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .auth-hint {
    margin: 0;
    max-width: 56ch;
    color: var(--secondary);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .error-banner {
    margin: 0 0 var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--danger);
    border-radius: var(--radius-control);
    background: var(--accent-subtle);
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  /* Summary strip — four counters, wrapping on narrow widths. */
  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .summary-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--card);
  }

  .summary-value {
    font-size: 1.25rem;
    font-weight: 700;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .summary-label {
    color: var(--secondary);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* Wide layout is a table-like grid; rows collapse to stacked cards below. */
  .row {
    display: grid;
    grid-template-columns:
      minmax(0, 1.5fr) minmax(96px, auto) minmax(56px, auto)
      minmax(64px, auto) minmax(0, 1.4fr) auto;
    grid-template-areas: "id state pid port error actions";
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--card);
  }

  .row-head {
    border: 0;
    background: transparent;
    padding-top: 0;
    padding-bottom: 0;
  }

  .row-head span {
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .col-id,
  .row-id {
    grid-area: id;
  }

  .col-state,
  .row-state {
    grid-area: state;
  }

  .col-pid,
  .row-pid {
    grid-area: pid;
  }

  .col-port,
  .row-port {
    grid-area: port;
  }

  .col-error,
  .row-error {
    grid-area: error;
  }

  .col-actions,
  .row-actions {
    grid-area: actions;
    justify-self: end;
  }

  .row-id {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .row-pid,
  .row-port {
    color: var(--secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .row-error {
    min-width: 0;
  }

  .error-cell {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--danger);
    font-size: 0.8125rem;
  }

  .muted {
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .row-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .row-action-error {
    grid-column: 1 / -1;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
    word-break: break-word;
  }

  /* Static skeleton blocks — no animation (reduced-motion safe). */
  .row-skeleton {
    padding-block: var(--space-3);
  }

  .sk {
    display: block;
    height: 14px;
    background: var(--code);
    border-radius: var(--radius-control);
  }

  .sk-id {
    width: 55%;
  }

  .sk-state {
    width: 72px;
  }

  .sk-pid {
    width: 48px;
  }

  .sk-port {
    width: 56px;
  }

  .sk-error {
    width: 40%;
  }

  .sk-actions {
    width: 140px;
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

  /* Narrow widths: the table becomes stacked cards — no horizontal scroll. */
  @media (max-width: 767px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "id state"
        "pid port"
        "error error"
        "actions actions";
      gap: var(--space-1) var(--space-3);
    }

    .row-head {
      display: none;
    }

    .row-actions {
      justify-self: start;
    }

    /* Column labels move into the cells once the header row is gone. */
    .row-pid::before {
      content: "PID ";
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 0.75rem;
    }

    .row-port::before {
      content: "Port ";
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 0.75rem;
    }
  }
</style>
