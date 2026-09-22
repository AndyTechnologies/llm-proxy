<script lang="ts">
  import Button from "../common/Button.svelte";
  import Icon from "../common/Icon.svelte";
  import StatusCard from "./StatusCard.svelte";
  import {
    ApiError,
    getApiOrigin,
    listModels,
    listWorkflows,
    runtimeStatus,
  } from "../../lib/api/index.js";
  import type { HealthStatus, ModelStatus } from "../../lib/api/index.js";
  import { buildOverviewSnapshot } from "../../lib/overview.js";
  import type { OverviewSnapshot } from "../../lib/overview.js";

  /** Poll cadence for the dashboard (10s). */
  const AUTO_REFRESH_MS = 10_000;
  /** How many active model ids the Models card lists before "+N more". */
  const MODELS_HINT_LIMIT = 3;

  type CardTone = "ok" | "error" | "neutral";

  const apiOrigin = getApiOrigin();

  let loading = $state(true);
  let snapshot = $state<OverviewSnapshot | null>(null);
  let health = $state<HealthStatus | null>(null);
  let models = $state<ModelStatus[]>([]);
  let runtimeError = $state<string | null>(null);
  let modelsError = $state<string | null>(null);
  let workflowsError = $state<string | null>(null);

  /** Bumped by Refresh/Retry — re-runs the poll effect (and its timer). */
  let attempt = $state(0);

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

    // allSettled: a failing service degrades its own card, never the dashboard.
    const [runtime, modelsResult, workflowsResult] = await Promise.allSettled([
      runtimeStatus(),
      listModels(),
      listWorkflows(),
    ]);

    if (seq !== requestSeq) return; // superseded by a newer refresh

    const healthValue = runtime.status === "fulfilled" ? (runtime.value.health ?? null) : null;
    const reachable = runtime.status === "fulfilled" ? runtime.value.reachable : false;
    const authEnabled = runtime.status === "fulfilled" ? runtime.value.authEnabled : false;
    const modelsValue = modelsResult.status === "fulfilled" ? modelsResult.value : [];
    const workflowsValue = workflowsResult.status === "fulfilled" ? workflowsResult.value : [];

    runtimeError = reachable ? null : "backend unreachable";
    modelsError = modelsResult.status === "rejected" ? errorText(modelsResult.reason) : null;
    workflowsError =
      workflowsResult.status === "rejected" ? errorText(workflowsResult.reason) : null;

    health = healthValue;
    models = modelsValue;
    snapshot = buildOverviewSnapshot({
      health: healthValue,
      authEnabled,
      reachable,
      models: modelsValue,
      workflows: workflowsValue,
      now: Date.now(),
    });
    loading = false;
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

  // ── Runtime card ---------------------------------------------------------

  function runtimeValue(s: OverviewSnapshot): string {
    return s.runtime.reachable ? "Online" : "Unavailable";
  }

  function runtimeStatusLabel(s: OverviewSnapshot): string {
    return runtimeValue(s);
  }

  function runtimeTone(s: OverviewSnapshot): CardTone {
    return s.runtime.reachable ? "ok" : "error";
  }

  function runtimeHint(s: OverviewSnapshot): string {
    const auth = s.runtime.authEnabled ? "enabled" : "disabled";
    const local = health?.localModels;
    const localLine =
      local === undefined
        ? ""
        : ` · ${local.length} local model${local.length === 1 ? "" : "s"} served`;
    return `${apiOrigin} · Bearer authentication: ${auth}${localLine}`;
  }

  // ── Models card ----------------------------------------------------------

  function modelsValue(s: OverviewSnapshot): string {
    return String(s.models.total);
  }

  function modelsStatusLabel(s: OverviewSnapshot): string {
    if (modelsError !== null) return "Unavailable";
    if (s.models.active > 0) return `${s.models.active} active`;
    return s.models.total > 0 ? "none active" : "No models";
  }

  function modelsTone(s: OverviewSnapshot): CardTone {
    if (modelsError !== null || s.models.error > 0) return "error";
    if (s.models.active > 0) return "ok";
    return "neutral";
  }

  function modelsHint(s: OverviewSnapshot): string {
    if (modelsError !== null) return modelsError;
    return `${s.models.active} active · ${s.models.error} in error of ${s.models.total} total`;
  }

  function activeModelIdsLabel(modelRows: ModelStatus[]): string {
    const active = modelRows.filter((m) => m.state === "active").map((m) => m.id);
    if (active.length === 0) return "";
    const shown = active.slice(0, MODELS_HINT_LIMIT).join(", ");
    return active.length > MODELS_HINT_LIMIT
      ? `${shown} +${active.length - MODELS_HINT_LIMIT} more`
      : shown;
  }

  // ── Workflows card -------------------------------------------------------

  function workflowsValue(s: OverviewSnapshot): string {
    return String(s.workflows.total);
  }

  function workflowsStatusLabel(s: OverviewSnapshot): string {
    if (workflowsError !== null) return "Unavailable";
    return s.workflows.total > 0 ? "ok" : "Empty";
  }

  function workflowsTone(s: OverviewSnapshot): CardTone {
    if (workflowsError !== null) return "error";
    return s.workflows.total > 0 ? "ok" : "neutral";
  }

  function workflowsHint(s: OverviewSnapshot): string {
    if (workflowsError !== null) return workflowsError;
    return s.workflows.total > 0
      ? "Newest first — up to 5 recent definitions"
      : "No stored workflow definitions";
  }

  // ── Formatting helpers ---------------------------------------------------

  function formatTime(epochMs: number): string {
    return new Date(epochMs).toLocaleTimeString([], { hour12: false });
  }

  function formatWorkflowDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
</script>

<div class="overview" data-testid="overview-dashboard">
  <div class="overview-toolbar">
    {#if snapshot !== null}
      <p class="updated-label">Last updated {formatTime(snapshot.fetchedAt)}</p>
    {:else}
      <p class="updated-label" aria-hidden="true">—</p>
    {/if}
    <Button
      variant="secondary"
      ariaLabel="Refresh overview"
      disabled={loading}
      onclick={refresh}
    >
      Refresh
    </Button>
  </div>

  <div class="cards" aria-busy={loading && snapshot === null}>
    {#if snapshot === null}
      <!-- Initial load: static skeleton only (no animation — reduced-motion safe). -->
      <StatusCard label="Runtime" value="…" hint="Loading…" />
      <StatusCard label="Models" value="…" hint="Loading…" />
      <StatusCard label="Workflows" value="…" hint="Loading…" />
    {:else}
      <StatusCard
        label="Runtime"
        value={runtimeValue(snapshot)}
        hint={runtimeHint(snapshot)}
        tone={runtimeTone(snapshot)}
        statusLabel={runtimeStatusLabel(snapshot)}
      >
        {#if runtimeError !== null}
          <Button
            variant="secondary"
            ariaLabel="Retry connecting to the runtime"
            onclick={refresh}
          >
            Retry
          </Button>
        {/if}
      </StatusCard>

      <StatusCard
        label="Models"
        value={modelsValue(snapshot)}
        hint={modelsHint(snapshot)}
        tone={modelsTone(snapshot)}
        statusLabel={modelsStatusLabel(snapshot)}
      >
        {#if modelsError !== null}
          <Button variant="secondary" ariaLabel="Retry loading models" onclick={refresh}>
            Retry
          </Button>
        {:else if activeModelIdsLabel(models) !== ""}
          <p class="card-sub">Active: {activeModelIdsLabel(models)}</p>
        {/if}
      </StatusCard>

      <StatusCard
        label="Workflows"
        value={workflowsValue(snapshot)}
        hint={workflowsHint(snapshot)}
        tone={workflowsTone(snapshot)}
        statusLabel={workflowsStatusLabel(snapshot)}
      >
        {#if workflowsError !== null}
          <Button variant="secondary" ariaLabel="Retry loading workflows" onclick={refresh}>
            Retry
          </Button>
        {:else if snapshot.workflows.recent.length > 0}
          <ul class="recent-list">
            {#each snapshot.workflows.recent as wf (wf.name)}
              <li class="recent-row">
                <a
                  class="recent-name"
                  href={`/workflows/${encodeURIComponent(wf.name)}`}
                  title={wf.name}
                >
                  {wf.name}
                </a>
                <span class="recent-meta">
                  v{wf.version} · {formatWorkflowDate(wf.updatedAt)}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </StatusCard>
    {/if}
  </div>

  <section class="quick-actions" aria-label="Quick actions">
    <h2 class="qa-title">Quick actions</h2>
    <div class="qa-list">
      <a class="qa-link" href="/workflows">
        <Icon name="workflows" size={16} />
        <span>New workflow</span>
      </a>
      <a class="qa-link" href="/models/catalog">
        <Icon name="catalog" size={16} />
        <span>Browse catalog</span>
      </a>
      <a class="qa-link" href="/api">
        <Icon name="api" size={16} />
        <span>API playground</span>
      </a>
      <a class="qa-link" href="/runtime">
        <Icon name="runtime" size={16} />
        <span>Runtime</span>
      </a>
    </div>
  </section>
</div>

<style>
  .overview-toolbar {
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

  /* Cards stack on narrow widths (auto-fit + min column). */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: var(--space-4);
    align-items: stretch;
  }

  .card-sub {
    margin: 0;
    color: var(--secondary);
    font-size: 0.75rem;
    line-height: 1.45;
    word-break: break-word;
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .recent-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--bg);
  }

  .recent-name {
    color: var(--text);
    font-size: 0.875rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-name:hover {
    color: var(--accent-hover);
  }

  .recent-meta {
    color: var(--muted);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .qa-title {
    margin: 0 0 var(--space-3);
    font-size: 1rem;
    font-weight: 600;
  }

  .qa-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  /* Anchor styled with the same recipe as Button (secondary variant) — the
     actions navigate, so <a> is the semantically correct element. */
  .qa-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--card);
    color: var(--text);
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
    transition:
      border-color 150ms ease,
      background-color 150ms ease,
      color 150ms ease;
  }

  .qa-link:hover {
    border-color: var(--border-hover);
    background: var(--accent-subtle);
    color: var(--text);
  }

  @media (max-width: 640px) {
    .qa-link {
      flex: 1 1 100%;
    }
  }
</style>