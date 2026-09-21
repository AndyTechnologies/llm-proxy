<script lang="ts">
  import type { Snippet } from "svelte";
  import type { IconName } from "../../lib/navigation.js";
  import Icon from "./Icon.svelte";

  let {
    icon = "overview",
    title,
    description,
    children,
  }: {
    icon?: IconName;
    title: string;
    description: string;
    children?: Snippet;
  } = $props();
</script>

<div class="empty-state">
  <span class="empty-icon" aria-hidden="true">
    <Icon {icon} size={20} />
  </span>
  <h2 class="empty-title">{title}</h2>
  <p class="empty-description">{description}</p>
  {#if children}
    {@render children()}
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    max-width: 720px;
    padding: var(--space-12);
    border: 1px dashed var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
  }

  .empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-control);
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .empty-title {
    margin: var(--space-2) 0 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  .empty-description {
    margin: 0;
    max-width: 56ch;
    color: var(--secondary);
    font-size: 0.875rem;
    line-height: 1.5;
  }
</style>