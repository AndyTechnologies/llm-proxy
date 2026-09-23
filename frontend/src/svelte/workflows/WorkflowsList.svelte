<script lang="ts">
  /**
   * Workflow library island (U04). Owns all data: every value comes from the
   * typed workflows client against /api/workflows — no local truth. States
   * are honest: static skeleton while loading, "No workflows yet" only when
   * the API really returns [], ApiError text + Retry on failure. After any
   * mutation (create/delete/run) the list refreshes from the API.
   */
  import { ApiError, deleteWorkflow, listWorkflows } from "../../lib/api/index.js";
  import type { WorkflowRecord } from "../../lib/api/index.js";
  import { formatUpdatedAt, workflowRow } from "../../lib/workflows-ui.js";
  import { trapFocus } from "../../lib/focus-trap.js";
  import Button from "../common/Button.svelte";
  import EmptyState from "../common/EmptyState.svelte";
  import IconButton from "../common/IconButton.svelte";
  import NewWorkflowModal from "./NewWorkflowModal.svelte";
  import RunWorkflowModal from "./RunWorkflowModal.svelte";
  import WorkflowLogsModal from "./WorkflowLogsModal.svelte";

  const MODAL_KINDS = {
    none: "none",
    new: "new",
    run: "run",
    logs: "logs",
    delete: "delete",
  } as const;

  type ModalKind = (typeof MODAL_KINDS)[keyof typeof MODAL_KINDS];

  /** Skeleton rows rendered while the first load is in flight (static, no animation). */
  const SKELETON_ROWS = 4;

  /** Action glyphs stay local: run/logs/delete are not in the shared Icon
      registry, and Icon.svelte is frozen this phase. Same stroke recipe. */
  interface MiniGlyph {
    d: string;
  }

  const RUN_GLYPH: readonly MiniGlyph[] = [{ d: "M8 5.5v13l11-6.5z" }];
  const LOGS_GLYPH: readonly MiniGlyph[] = [
    { d: "M9 6h11" },
    { d: "M9 12h11" },
    { d: "M9 18h11" },
    { d: "M5.5 6h.01" },
    { d: "M5.5 12h.01" },
    { d: "M5.5 18h.01" },
  ];
  const DELETE_GLYPH: readonly MiniGlyph[] = [
    { d: "M5 7h14" },
    { d: "M10 4h4" },
    { d: "M7 7l1 13h8l1-13" },
  ];

  const skeletons = Array.from({ length: SKELETON_ROWS });

  let rows = $state<WorkflowRecord[] | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let attempt = $state(0);
  let modal = $state<ModalKind>(MODAL_KINDS.none);
  let modalName = $state("");
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  // Delete-confirm dialog wiring (the run/logs/new modals own their own).
  let deleteDialogEl = $state<HTMLDivElement>();
  let deleteFocus: HTMLElement | null = null;

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
      rows = await listWorkflows();
    } catch (err) {
      if (seq === requestSeq) error = errorText(err);
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
    attempt += 1;
  }

  function openNew(): void {
    modal = MODAL_KINDS.new;
  }

  function openRun(name: string): void {
    modalName = name;
    modal = MODAL_KINDS.run;
  }

  function openLogs(name: string): void {
    modalName = name;
    modal = MODAL_KINDS.logs;
  }

  function openDelete(name: string): void {
    deleteError = null;
    modalName = name;
    modal = MODAL_KINDS.delete;
  }

  function closeRun(changed: boolean): void {
    modal = MODAL_KINDS.none;
    modalName = "";
    // Every executed run wrote a log row — refresh so the list reflects reality.
    if (changed) void load();
  }

  function closeLogs(): void {
    modal = MODAL_KINDS.none;
    modalName = "";
  }

  function closeNew(): void {
    modal = MODAL_KINDS.none;
  }

  function restoreDeleteFocus(): void {
    deleteFocus?.focus();
    deleteFocus = null;
  }

  async function confirmDelete(): Promise<void> {
    deleting = true;
    deleteError = null;
    try {
      await deleteWorkflow(modalName);
      restoreDeleteFocus();
      modal = MODAL_KINDS.none;
      modalName = "";
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Already gone — the store and the list disagreed; refresh silently.
        restoreDeleteFocus();
        modal = MODAL_KINDS.none;
        modalName = "";
        void load();
      } else {
        deleteError = errorText(err);
      }
    } finally {
      deleting = false;
    }
  }

  function cancelDelete(): void {
    if (deleting) return;
    restoreDeleteFocus();
    modal = MODAL_KINDS.none;
    modalName = "";
  }

  // Focus moves into the delete dialog on open, Tab stays inside it, Escape
  // cancels; focus returns to the trigger on close (cancelDelete /
  // confirmDelete).
  $effect(() => {
    if (modal !== MODAL_KINDS.delete) return;
    deleteFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => deleteDialogEl?.focus());
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDelete();
      }
    }
    window.addEventListener("keydown", onKey);
    const release = deleteDialogEl === undefined ? undefined : trapFocus(deleteDialogEl);
    return () => {
      window.removeEventListener("keydown", onKey);
      release?.();
    };
  });
</script>

<div class="workflows" data-testid="workflows-library">
  {#if rows === null}
    {#if error !== null}
      <EmptyState
        icon="workflows"
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
          <div class="row row-skeleton" aria-hidden="true">
            <span class="sk sk-name"></span>
            <span class="sk sk-version"></span>
            <span class="sk sk-updated"></span>
          </div>
        {/each}
      </div>
      <p class="sr-only">Loading workflows…</p>
    {/if}
  {:else if rows.length === 0}
    <EmptyState
      icon="workflows"
      title="No workflows yet"
      description="Workflow definitions you create appear here — start with a new workflow and edit it in the visual editor."
    >
      <Button variant="primary" ariaLabel="Create a new workflow" onclick={openNew}>
        New workflow
      </Button>
    </EmptyState>
  {:else}
    <div class="list-head">
      <p class="count">{rows.length} workflow{rows.length === 1 ? "" : "s"}</p>
      <Button variant="primary" ariaLabel="Create a new workflow" onclick={openNew}>
        New workflow
      </Button>
    </div>

    {#if error !== null}
      <p class="error-banner" role="alert">{error}</p>
    {/if}

    <div class="rows" aria-busy={loading}>
      <div class="row row-head" aria-hidden="true">
        <span class="col-name">Name</span>
        <span class="col-version">Version</span>
        <span class="col-updated">Updated</span>
        <span class="col-actions">Actions</span>
      </div>

      {#each rows as wf (wf.name)}
        {@const row = workflowRow(wf)}
        <div class="row">
          <a
            class="row-name"
            href={`/workflows/${encodeURIComponent(row.name)}`}
            title={row.name}
          >
            {row.name}
          </a>
          <span class="version-badge" title={`Version ${row.version}`}>v{row.version}</span>
          <span class="row-updated">{formatUpdatedAt(row.updatedAt)}</span>
          <span class="row-actions">
            <button
              type="button"
              class="icon-button"
              aria-label={`Run ${row.name}`}
              title={`Run ${row.name}`}
              onclick={() => openRun(row.name)}
            >
              {@render actionGlyph(RUN_GLYPH)}
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={`View logs for ${row.name}`}
              title={`View logs for ${row.name}`}
              onclick={() => openLogs(row.name)}
            >
              {@render actionGlyph(LOGS_GLYPH)}
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={`Delete ${row.name}`}
              title={`Delete ${row.name}`}
              onclick={() => openDelete(row.name)}
            >
              {@render actionGlyph(DELETE_GLYPH)}
            </button>
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#snippet actionGlyph(paths: readonly MiniGlyph[])}
  <svg
    class="action-glyph"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#each paths as path (path.d)}
      <path d={path.d} />
    {/each}
  </svg>
{/snippet}

{#if modal === MODAL_KINDS.run && modalName !== ""}
  <RunWorkflowModal name={modalName} onClose={closeRun} />
{/if}
{#if modal === MODAL_KINDS.logs && modalName !== ""}
  <WorkflowLogsModal name={modalName} onClose={closeLogs} />
{/if}
{#if modal === MODAL_KINDS.new}
  <NewWorkflowModal onClose={closeNew} />
{/if}
{#if modal === MODAL_KINDS.delete && modalName !== ""}
  <div class="backdrop" onclick={cancelDelete}>
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-delete-title"
      tabindex="-1"
      bind:this={deleteDialogEl}
      onclick={(event) => event.stopPropagation()}
    >
      <div class="dialog-head">
        <h2 class="dialog-title" id="workflow-delete-title">Delete workflow</h2>
        <IconButton name="close" label="Cancel" onclick={cancelDelete} />
      </div>
      <div class="dialog-body">
        <p class="delete-text">Delete workflow "{modalName}"? This cannot be undone.</p>
        {#if deleteError !== null}
          <p class="error-text" role="alert">{deleteError}</p>
        {/if}
      </div>
      <div class="dialog-foot">
        <Button variant="secondary" disabled={deleting} onclick={cancelDelete}>
          Cancel
        </Button>
        <button type="button" class="btn-danger" disabled={deleting} onclick={confirmDelete}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
  }

  .count {
    margin: 0;
    color: var(--secondary);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
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

  /* Wide layout is a table-like grid; rows collapse to stacked cards below. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(110px, auto) auto;
    grid-template-areas: "name version updated actions";
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

  .col-name {
    grid-area: name;
  }

  .col-version {
    grid-area: version;
  }

  .col-updated {
    grid-area: updated;
    justify-self: end;
  }

  .col-actions {
    grid-area: actions;
    justify-self: end;
  }

  .row-name {
    grid-area: name;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .row-name:hover {
    color: var(--accent-hover);
  }

  .version-badge {
    grid-area: version;
    justify-self: start;
    padding: 1px var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--code);
    color: var(--secondary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .row-updated {
    grid-area: updated;
    justify-self: end;
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  .row-actions {
    grid-area: actions;
    display: flex;
    justify-content: flex-end;
    gap: var(--space-1);
  }

  /* Same recipe as common IconButton — that component only takes registry
     icons, and run/logs/delete glyphs are local this phase. */
  .icon-button {
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

  .icon-button:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-subtle);
    border-color: var(--border);
  }

  .icon-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-glyph {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  /* Static skeleton blocks — no animation (reduced-motion safe). */
  .row-skeleton {
    padding-block: var(--space-3);
  }

  .sk {
    display: block;
    background: var(--code);
    border-radius: var(--radius-control);
  }

  .sk-name {
    height: 14px;
    width: 45%;
  }

  .sk-version {
    height: 18px;
    width: 42px;
  }

  .sk-updated {
    height: 14px;
    width: 96px;
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

  /* Modal shell (delete confirm lives here; dialog styles match the modals). */
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
    width: min(480px, 100%);
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
    font-size: 1rem;
    font-weight: 600;
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4) var(--space-4);
  }

  .dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-4);
  }

  .delete-text {
    margin: 0;
    color: var(--text);
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .error-text {
    margin: 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  /* Destructive action button — Button has no danger variant and is frozen,
     so the recipe is reproduced here with the danger token. */
  .btn-danger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--danger);
    border-radius: var(--radius-control);
    background: var(--danger);
    color: #09090b;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 639px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "name actions"
        "version updated";
      gap: var(--space-1) var(--space-3);
    }

    .row-head {
      display: none;
    }

    .row-updated {
      justify-self: start;
    }

    .row-actions {
      justify-self: end;
    }
  }
</style>