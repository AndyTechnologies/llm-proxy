<script lang="ts">
  const STATUS_TONES = {
    ok: "ok",
    warn: "warn",
    error: "error",
    idle: "idle",
  } as const;

  type StatusTone = (typeof STATUS_TONES)[keyof typeof STATUS_TONES];

  let {
    tone = "idle",
    label = "",
    title,
  }: {
    tone?: StatusTone;
    label?: string;
    title?: string;
  } = $props();
</script>

<span class="status" role={label !== "" ? "status" : undefined} title={title}>
  <span class="dot dot-{tone}" aria-hidden="true"></span>
  {#if label !== ""}
    <span class="status-label">{label}</span>
  {/if}
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    background: var(--muted);
  }

  .dot-ok {
    background: var(--success);
  }

  .dot-warn {
    background: var(--accent);
  }

  .dot-error {
    background: var(--danger);
  }

  .dot-idle {
    background: var(--muted);
  }

  .status-label {
    color: var(--secondary);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
</style>