<script lang="ts">
  import StatusDot from "../common/StatusDot.svelte";

  /**
   * Bottom status strip. Static markup (no hydration): it only echoes the
   * configured API origin and app version — no telemetry, no fake health.
   */
  let {
    origin,
    version,
  }: {
    origin: string;
    version: string;
  } = $props();
</script>

<footer class="statusbar">
  <span class="sb-text">WeaveLLM v{version}</span>
  <div class="sb-right">
    <StatusDot tone="idle" label="api" />
    <code class="endpoint">{origin}</code>
    <span class="sb-hint">Ctrl K to jump</span>
  </div>
</footer>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: 32px;
    padding: 0 var(--space-4);
    border-top: 1px solid var(--border);
    background: var(--bg);
    font-size: 0.75rem;
    color: var(--secondary);
  }

  .sb-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .endpoint {
    font-size: 0.75rem;
    color: var(--secondary);
  }

  .sb-hint {
    color: var(--muted);
  }

  @media (max-width: 767px) {
    .sb-hint {
      display: none;
    }
  }
</style>