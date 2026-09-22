<script lang="ts">
  /**
   * Executions island (U10) — per-workflow run history from the REAL backend
   * logs (GET /api/workflows/:name/logs through the typed client).
   *
   * Honest-aggregate discipline: there is no global executions endpoint, so
   * the summary strip sums exactly the per-workflow log rows this page
   * actually fetched — bounded concurrency (max 2 in flight at a time),
   * lazy per-row fetches, honest per-row loading/error states, and copy
   * labeled as a per-workflow view, never "all-time".
   *
   * NO auto-refresh by design: a completed run is immutable — its log row is
   * written once server-side (runner.ts records before the request resolves),
   * so polling would only add noise. Refresh re-fetches the workflow list
   * and every workflow's logs on demand.
   */
  import { ApiError, listWorkflows, workflowLogs } from "../../lib/api/index.js";
  import type { ExecutionLogRow, WorkflowRecord } from "../../lib/api/index.js";
  import {
    executionRowView,
    latestRun,
    summarizeExecutions,
  } from "../../lib/executions-ui.js";
  import { formatUpdatedAt } from "../../lib/workflows-ui.js";
  import Button from "../common/Button.svelte";
  import EmptyState from "../common/EmptyState.svelte";
  import Icon from "../common/Icon.svelte";
  import StatusDot from "../common/StatusDot.svelte";

  interface LogCell {
    status: "loading" | "loaded" | "error";
    rows: ExecutionLogRow[];
    error: string | null;
  }

  interface StripTotals {
    total: number;
    loaded: number;
    withRuns: number;
    ok: number;
    error: number;
  }

  /** Bounded concurrency for the per-workflow log fetches. */
  const CONCURRENCY = 2;
  /** Static skeleton rows while the workflow list loads (no animation). */
  const SKELETON_ROWS = 4;

  const skeletons = Array.from({ length: SKELETON_ROWS });

  let rows = $state<WorkflowRecord[] | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let attempt = $state(0);
  /** Per-workflow log cells, keyed by workflow name. */
  let cells = $state<Record<string, LogCell>>({});
  /** Expanded rows (each expansion triggers a fresh fetch). */
  let expanded = $state<Record<string, boolean>>({});

  /** Monotonic list request id — a slower older refresh never overwrites. */
  let requestSeq = 0;

  /**
   * Monotonic cell-fetch generation. A fetch started before a Refresh
   * completes without touching state (generation guard at write time).
   */
  let refreshSeq = 0;
  /** Names being fetched right now, with their generation (dedupes enqueues). */
  const runningSeq = new Map<string, number>();
  /** Pool queue: names waiting for a free slot. */
  const queue: string[] = [];
  let active = 0;

  function errorText(err: unknown): string {
    if (err instanceof ApiError) {
      return err.status > 0 ? `${err.message} (HTTP ${err.status})` : err.message;
    }
    return "request failed";
  }

  function enqueueCell(name: string): void {
    queue.push(name);
    pump();
  }

  /**
   * Fetch one workflow's log rows inside the bounded pool. Only the latest
   * generation may write state; a duplicate enqueue for a name whose fresh
   * fetch is already running is a no-op.
   */
  async function fetchCell(name: string, seq: number): Promise<void> {
    if (runningSeq.get(name) === seq) return;
    runningSeq.set(name, seq);
    cells[name] = { status: "loading", rows: [], error: null };
    try {
      const logs = await workflowLogs(name);
      if (seq === refreshSeq) {
        cells[name] = { status: "loaded", rows: logs, error: null };
      }
    } catch (err) {
      if (seq === refreshSeq) {
        cells[name] = { status: "error", rows: [], error: errorText(err) };
      }
    } finally {
      if (runningSeq.get(name) === seq) runningSeq.delete(name);
    }
  }

  /** Pool loop: keep up to CONCURRENCY fetches in flight, drain on completion. */
  function pump(): void {
    while (active < CONCURRENCY && queue.length > 0) {
      const name = queue.shift();
      if (name === undefined) break;
      active += 1;
      void fetchCell(name, refreshSeq).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function load(): Promise<void> {
    const seq = ++requestSeq;
    loading = true;
    error = null;
    try {
      const list = await listWorkflows();
      if (seq !== requestSeq) return;
      rows = list;
      for (const wf of list) enqueueCell(wf.name);
    } catch (err) {
      if (seq === requestSeq) {
        error = errorText(err);
        // A refresh that fails keeps the previous list — but every row must
        // report a state honestly, so the cells degrade to per-row errors
        // instead of showing "Loading…" forever with no fetch behind it.
        if (rows !== null) {
          const failed: Record<string, LogCell> = {};
          for (const wf of rows) {
            failed[wf.name] = { status: "error", rows: [], error: errorText(err) };
          }
          cells = failed;
        }
      }
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  // Initial load + manual refresh/retry (an attempt bump re-runs this effect).
  $effect(() => {
    void attempt;
    void load();
  });

  function refresh(): void {
    refreshSeq += 1; // invalidate every in-flight cell fetch
    queue.length = 0;
    cells = {};
    attempt += 1; // re-run load(), which re-enqueues every cell
  }

  function retryCell(name: string): void {
    enqueueCell(name);
  }

  function toggleExpand(name: string): void {
    const next = !(expanded[name] ?? false);
    expanded[name] = next;
    // Fresh fetch on expand — the pool dedupes when one is already running.
    if (next) enqueueCell(name);
  }

  /** Summary strip — derived ONLY from cells this page actually loaded. */
  function strip(): StripTotals {
    const totals: StripTotals = { total: 0, loaded: 0, withRuns: 0, ok: 0, error: 0 };
    if (rows === null) return totals;
    totals.total = rows.length;
    for (const wf of rows) {
      const cell = cells[wf.name];
      if (cell === undefined || cell.status !== "loaded") continue;
      totals.loaded += 1;
      if (cell.rows.length > 0) totals.withRuns += 1;
      const runs = summarizeExecutions(cell.rows);
      totals.ok += runs.ok;
      totals.error += runs.error;
    }
    return totals;
  }

  function runsId(name: string): string {
    return `runs-${encodeURIComponent(name)}`;
  }
</script>

<div class="executions" data-testid="executions-list">
  {#if rows === null}
    {#if error !== null}
      <EmptyState
        icon="executions"
        title="Unable to load workflows"
        description={error}
      >
        <Button variant="secondary" ariaLabel="Retry loading workflows" onclick={refresh}>
          Retry
        </Button>
      </EmptyState>
    {:else}
      <div class="rows" aria-busy="true">
        {#each skeletons as _skel, i (i)}
          <div class="card card-skeleton" aria-hidden="true">
            <span class="sk sk-summary"></span>
          </div>
        {/each}
      </div>
      <p class="sr-only">Loading executions…</p>
    {/if}
  {:else if rows.length === 0}
    <EmptyState
      icon="executions"
      title="No workflows yet"
      description="Run history appears here, grouped per workflow. Create a workflow first, then run it to see its executions."
    >
      <a class="link-primary" href="/workflows">Go to workflows</a>
    </EmptyState>
  {:else}
    {@const totals = strip()}

    <div class="exec-toolbar">
      <p class="scope-note">
        Per-workflow run history, newest first — from the backend workflow logs.
      </p>
      <Button
        variant="secondary"
        ariaLabel="Refresh executions"
        disabled={loading}
        onclick={refresh}
      >
        Refresh
      </Button>
    </div>

    <div class="strip" aria-label="Executions summary">
      <div class="stat">
        <span class="stat-value">{totals.total}</span>
        <span class="stat-label">Workflows</span>
      </div>
      <div class="stat">
        <span class="stat-value">{totals.withRuns}</span>
        <span class="stat-label">With runs</span>
      </div>
      <div class="stat">
        <span class="stat-value">{totals.ok}</span>
        <span class="stat-label">OK runs</span>
      </div>
      <div class="stat">
        <span class="stat-value">{totals.error}</span>
        <span class="stat-label">Error runs</span>
      </div>
    </div>
    <p class="strip-caption">
      Counts cover the logs fetched for {totals.loaded} of {totals.total} workflows
      loaded below — per-workflow history, not a global aggregate.
    </p>

    {#if error !== null}
      <p class="error-banner" role="alert">{error}</p>
    {/if}

    <div class="rows" aria-busy={loading}>
      {#each rows as wf (wf.name)}
        {@const isOpen = expanded[wf.name] === true}
        {@const cell = cells[wf.name]}
        {@const id = runsId(wf.name)}
        <div class="card">
          <div class="card-main">
            <button
              type="button"
              class:expanded={isOpen}
              class="expand-btn"
              aria-expanded={isOpen}
              aria-controls={id}
              aria-label={`${isOpen ? "Hide" : "Show"} runs for ${wf.name}`}
              title={`${isOpen ? "Hide" : "Show"} runs for ${wf.name}`}
              onclick={() => toggleExpand(wf.name)}
            >
              <Icon name="chevron" size={16} />
            </button>

            <div class="card-id">
              <a
                class="wf-name"
                href={`/workflows/${encodeURIComponent(wf.name)}`}
                title={wf.name}
              >
                {wf.name}
              </a>
              <span class="wf-meta">
                <span class="version-badge" title={`Version ${wf.version}`}>
                  v{wf.version}
                </span>
                <span class="wf-updated">{formatUpdatedAt(wf.updatedAt)}</span>
              </span>
            </div>

            <div class="card-summary">
              {#if cell === undefined || cell.status === "loading"}
                <span class="summary-note">Loading…</span>
              {:else if cell.status === "error"}
                <span class="summary-error" title={cell.error ?? ""}>{cell.error}</span>
                <Button
                  variant="ghost"
                  ariaLabel={`Retry loading runs for ${wf.name}`}
                  onclick={() => retryCell(wf.name)}
                >
                  Retry
                </Button>
              {:else if cell.rows.length === 0}
                <span class="summary-note">No runs yet</span>
              {:else}
                {@const latest = latestRun(cell.rows)}
                {#if latest !== null}
                  {@const view = executionRowView(latest)}
                  <StatusDot tone={view.chip.tone} label={view.chip.label} />
                  <span class="summary-started">{view.startedAt}</span>
                  <span class="summary-duration">{view.duration}</span>
                  {#if view.error !== null}
                    <span class="summary-error" title={view.error}>{view.errorCell}</span>
                  {/if}
                {/if}
              {/if}
            </div>
          </div>

          {#if isOpen}
            <div class="runs-panel" id={id} role="region" aria-label={`Recent runs for ${wf.name}`}>
              {#if cell === undefined || cell.status === "loading"}
                <p class="runs-note">Loading runs…</p>
              {:else if cell.status === "error"}
                <div class="runs-error" role="alert">
                  <p class="error-text">{cell.error}</p>
                  <Button
                    variant="secondary"
                    ariaLabel={`Retry loading runs for ${wf.name}`}
                    onclick={() => retryCell(wf.name)}
                  >
                    Retry
                  </Button>
                </div>
              {:else if cell.rows.length === 0}
                <p class="runs-note">No runs yet for this workflow.</p>
              {:else}
                <ul class="runs-list">
                  {#each cell.rows as run (run.id)}
                    {@const v = executionRowView(run)}
                    <li class="run-row">
                      <StatusDot tone={v.chip.tone} label={v.chip.label} />
                      <span class="run-started">{v.startedAt}</span>
                      <span class="run-duration">{v.duration}</span>
                      {#if v.error !== null}
                        <span class="run-error" title={v.error}>{v.error}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .exec-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }

  .scope-note {
    margin: 0;
    color: var(--secondary);
    font-size: 0.8125rem;
  }

  /* Summary strip: four stat blocks, 2×2 on narrow widths. */
  .strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .stat-label {
    color: var(--muted);
    font-size: 0.75rem;
  }

  .strip-caption {
    margin: var(--space-2) 0 var(--space-4);
    color: var(--muted);
    font-size: 0.75rem;
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

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
  }

  .card-main {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(0, auto);
    grid-template-areas: "expand id summary";
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  /* Expand toggle: keyboard native (button), state exposed via aria-expanded,
     chevron rotates to point down when open. */
  .expand-btn {
    grid-area: expand;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--secondary);
    cursor: pointer;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      border-color 150ms ease;
  }

  .expand-btn:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-subtle);
    border-color: var(--border);
  }

  .expand-btn :global(svg) {
    transition: transform 150ms ease;
  }

  .expand-btn.expanded :global(svg) {
    transform: rotate(90deg);
  }

  .card-id {
    grid-area: id;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .wf-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .wf-name:hover {
    color: var(--accent-hover);
  }

  .wf-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .version-badge {
    padding: 1px var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--code);
    color: var(--secondary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .wf-updated {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  /* Latest-run summary line: wraps on narrow widths, never overflows. */
  .card-summary {
    grid-area: summary;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    min-width: 0;
  }

  .summary-note {
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .summary-started {
    color: var(--secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .summary-duration {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .summary-error {
    flex-basis: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  /* Expanded run list (same visual recipe as the workflow logs modal). */
  .runs-panel {
    border-top: 1px solid var(--border);
    padding: var(--space-3);
  }

  .runs-note {
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .runs-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .runs-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .run-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: "status started ms";
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .run-row:last-child {
    border-bottom: 0;
  }

  .run-row > :first-child {
    grid-area: status;
  }

  .run-started {
    grid-area: started;
    color: var(--secondary);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .run-duration {
    grid-area: ms;
    justify-self: end;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  /* Error detail owns a second grid row when present (full text, wrapped). */
  .run-row:has(.run-error) {
    grid-template-areas:
      "status started ms"
      "status error error";
  }

  .run-error {
    grid-area: error;
    align-self: start;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.4;
    word-break: break-word;
  }

  /* Static skeleton blocks — no animation (reduced-motion safe). */
  .card-skeleton {
    padding: var(--space-4) var(--space-3);
  }

  .sk {
    display: block;
    background: var(--code);
    border-radius: var(--radius-control);
  }

  .sk-summary {
    height: 14px;
    width: 45%;
  }

  /* Anchor styled with the Button primary recipe — it navigates, so <a> is
     the semantically correct element. */
  .link-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--accent);
    border-radius: var(--radius-control);
    background: var(--accent);
    color: #ffffff;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.2;
    text-decoration: none;
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .link-primary:hover {
    border-color: var(--accent-hover);
    background: var(--accent-hover);
    color: #ffffff;
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

  @media (max-width: 767px) {
    /* Row collapses to stacked cards: expand + identity up top, summary
       underneath — no horizontal scroll on mobile. */
    .card-main {
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        "expand id"
        "summary summary";
    }

    .card-summary {
      justify-content: flex-start;
      padding-top: var(--space-1);
    }

    .strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>