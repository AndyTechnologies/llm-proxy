<script lang="ts">
  import { formatBytes, formatContext } from "../lib/format.js";

  let { name, quant, ctx, sizeBytes = 0 }: {
    name: string;
    quant: string;
    ctx: number | null;
    sizeBytes?: number;
  } = $props();
</script>

<article class="model-card" data-testid="model-badge">
  <h3 class="model-name">{name}</h3>
  <div class="model-meta">
    <span class="chip chip-quant">{quant}</span>
    <span class="chip chip-ctx">ctx {formatContext(ctx)}</span>
  </div>
  {#if sizeBytes > 0}
    <div class="model-size">{formatBytes(sizeBytes)}</div>
  {/if}
</article>

<style>
  .model-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    max-width: 320px;
  }
  .model-name {
    margin: 0 0 8px;
    font-size: 1rem;
  }
  .model-meta {
    display: flex;
    gap: 8px;
  }
  .chip {
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .chip-quant {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .chip-ctx {
    background: var(--muted);
    color: var(--text-muted);
  }
  .model-size {
    margin-top: 8px;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
</style>