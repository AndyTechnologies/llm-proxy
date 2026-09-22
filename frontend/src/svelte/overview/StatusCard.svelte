<script lang="ts">
  import type { Snippet } from "svelte";
  import StatusDot from "../common/StatusDot.svelte";

  const CARD_TONES = {
    ok: "ok",
    error: "error",
    neutral: "neutral",
  } as const;

  type CardTone = (typeof CARD_TONES)[keyof typeof CARD_TONES];

  /** StatusDot tone per card tone — neutral maps to the muted idle dot. */
  const DOT_TONE: Record<CardTone, "ok" | "error" | "idle"> = {
    ok: "ok",
    error: "error",
    neutral: "idle",
  };

  let {
    label,
    value,
    hint = "",
    tone = "neutral",
    statusLabel = "",
    children,
  }: {
    label: string;
    value: string;
    hint?: string;
    tone?: CardTone;
    /** Text beside the status dot; empty hides the dot row entirely. */
    statusLabel?: string;
    /** Optional slot: error retry actions, recent rows, extra detail. */
    children?: Snippet;
  } = $props();
</script>

<article class="status-card">
  <header class="card-head">
    <h2 class="card-label">{label}</h2>
    {#if statusLabel !== ""}
      <StatusDot tone={DOT_TONE[tone]} label={statusLabel} />
    {/if}
  </header>

  <p class="card-value">{value}</p>

  {#if hint !== ""}
    <p class="card-hint">{hint}</p>
  {/if}

  {#if children}
    <div class="card-children">
      {@render children()}
    </div>
  {/if}
</article>

<style>
  .status-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .card-label {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--secondary);
  }

  .card-value {
    margin: 0;
    /* min-height keeps the row stable while a skeleton loads (avoids CLS). */
    min-height: 2.05rem;
    font-size: 1.75rem;
    font-weight: 700;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .card-hint {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--secondary);
    word-break: break-word;
  }

  .card-children {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: auto;
    padding-top: var(--space-1);
  }
</style>