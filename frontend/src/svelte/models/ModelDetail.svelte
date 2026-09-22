<script lang="ts">
  /**
   * Model detail side panel (U08) — a drawer in the registry page.
   *
   * Uses api.models.getModel(id), which reads GET /api/models/:id/status —
   * the same ModelStatus row the registry list serves, re-read fresh on
   * open (the /api surface has no richer per-model detail endpoint, and the
   * typed client exposes no other getter). Fields shown are exactly the
   * real ModelStatus contract: id, state, pid, port, error — verbatim, with
   * "—" for absent values. No invented telemetry.
   *
   * Focus wiring mirrors the other drawers (RunPanel): focus moves in on
   * open, Escape closes, focus returns to the trigger on close.
   */
  import { ApiError, getModel } from "../../lib/api/index.js";
  import type { ModelStatus } from "../../lib/api/index.js";
  import {
    formatError,
    formatPid,
    formatPort,
    stateChip,
  } from "../../lib/models-ui.js";
  import Button from "../common/Button.svelte";
  import IconButton from "../common/IconButton.svelte";
  import StatusDot from "../common/StatusDot.svelte";

  let {
    modelId,
    onClose,
  }: {
    modelId: string;
    /** Called when the panel is closed (focus restored by the panel). */
    onClose: () => void;
  } = $props();

  let status = $state<ModelStatus | null>(null);
  let error = $state<string | null>(null);
  /** Bumped by Retry — re-runs the load effect. */
  let attempt = $state(0);

  let panelEl = $state<HTMLDivElement>();
  let lastFocused: HTMLElement | null = null;

  function errorText(err: unknown): string {
    if (err instanceof ApiError) {
      return err.status > 0 ? `${err.message} (HTTP ${err.status})` : err.message;
    }
    return err instanceof Error ? err.message : "request failed";
  }

  async function load(): Promise<void> {
    error = null;
    try {
      status = await getModel(modelId);
    } catch (err) {
      status = null;
      error = errorText(err);
    }
  }

  $effect(() => {
    void attempt;
    void load();
  });

  function refresh(): void {
    attempt += 1;
  }

  // Drawer wiring: focus in, Escape out, focus restore on close.
  $effect(() => {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => panelEl?.focus());
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function closePanel(): void {
    lastFocused?.focus();
    onClose();
  }
</script>

<aside
  class="detail-panel"
  role="region"
  aria-label={`Model details — ${modelId}`}
  tabindex="-1"
  bind:this={panelEl}
  data-testid="model-detail"
>
  <div class="panel-head">
    <h2 class="panel-title" id="model-detail-title">{modelId}</h2>
    <IconButton name="close" label="Close model details" onclick={closePanel} />
  </div>

  <div class="panel-body">
    {#if status === null}
      {#if error !== null}
        <p class="panel-error" role="alert">{error}</p>
        <Button
          variant="secondary"
          ariaLabel={`Retry loading model ${modelId}`}
          onclick={refresh}
        >
          Retry
        </Button>
      {:else}
        <p class="panel-note">Loading…</p>
      {/if}
    {:else}
      {@const chip = stateChip(status.state)}
      <dl class="detail-list">
        <div class="detail-row">
          <dt>Model</dt>
          <dd class="mono">{status.id}</dd>
        </div>
        <div class="detail-row">
          <dt>State</dt>
          <dd><StatusDot tone={chip.tone} label={chip.label} /></dd>
        </div>
        <div class="detail-row">
          <dt>PID</dt>
          <dd class="mono">{formatPid(status.pid)}</dd>
        </div>
        <div class="detail-row">
          <dt>Port</dt>
          <dd class="mono">{formatPort(status.port)}</dd>
        </div>
        <div class="detail-row">
          <dt>Error</dt>
          <dd class="mono detail-error">{formatError(status.error)}</dd>
        </div>
      </dl>
    {/if}
  </div>
</aside>

<style>
  .detail-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    width: min(420px, 100%);
    border-left: 1px solid var(--border);
    background: var(--card);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-2);
    border-bottom: 1px solid var(--border);
  }

  .panel-title {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 1rem;
    font-weight: 600;
  }

  .panel-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
    overflow-y: auto;
  }

  .panel-note {
    margin: 0;
    color: var(--secondary);
    font-size: 0.875rem;
  }

  .panel-error {
    margin: 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
    word-break: break-word;
  }

  .detail-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
  }

  .detail-row {
    display: grid;
    grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
    gap: var(--space-3);
    align-items: baseline;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--bg);
  }

  .detail-row dt {
    color: var(--secondary);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .detail-row dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: break-word;
    color: var(--text);
    font-size: 0.875rem;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .detail-error {
    color: var(--danger);
  }
</style>