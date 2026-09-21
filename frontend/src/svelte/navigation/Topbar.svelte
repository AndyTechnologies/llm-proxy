<script lang="ts">
  import Icon from "../common/Icon.svelte";
  import IconButton from "../common/IconButton.svelte";
  import StatusDot from "../common/StatusDot.svelte";
  import { sidebarDrawerOpen, commandPaletteOpen } from "../../lib/ui-state.js";

  const GITHUB_URL = "https://github.com/AndyTechnologies/llm-proxy";

  let {
    breadcrumb = [],
    origin,
  }: {
    breadcrumb?: string[];
    origin: string;
  } = $props();

  // Only the last crumb is the current page; the earlier ones are context.
  const lastIndex = $derived(breadcrumb.length - 1);
</script>

<header class="topbar">
  <div class="topbar-left">
    <IconButton
      class="hamburger"
      name="menu"
      label="Open navigation menu"
      onclick={() => sidebarDrawerOpen.set(true)}
    />

    <nav class="breadcrumb" aria-label="Breadcrumb">
      {#each breadcrumb as crumb, i (crumb)}
        {#if i > 0}<span class="crumb-sep" aria-hidden="true"><Icon name="chevron" size={12} /></span>{/if}
        <span class="crumb" class:current={i === lastIndex}>{crumb}</span>
      {/each}
    </nav>
  </div>

  <div class="topbar-right">
    <div class="runtime-hint" title={`API origin: ${origin}`}>
      <StatusDot tone="idle" label="runtime" />
      <code class="endpoint">{origin}</code>
    </div>

    <a
      class="github-link"
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      aria-label="WeaveLLM on GitHub"
      title="WeaveLLM on GitHub"
    >
      <Icon name="github" size={16} />
    </a>

    <button
      type="button"
      class="palette-trigger"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+KeyK Meta+KeyK"
      onclick={() => commandPaletteOpen.set(true)}
    >
      <Icon name="search" size={14} />
      <span class="palette-text">Jump to…</span>
      <kbd class="kbd-hint">Ctrl K</kbd>
    </button>
  </div>
</header>

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: 56px;
    padding: 0 var(--space-4);
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }

  .topbar-left,
  .topbar-right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .hamburger {
    display: none;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    overflow: hidden;
  }

  .crumb {
    font-size: 0.875rem;
    color: var(--secondary);
    white-space: nowrap;
  }

  .crumb.current {
    color: var(--text);
    font-weight: 600;
  }

  .crumb-sep {
    display: inline-flex;
    color: var(--muted);
  }

  .runtime-hint {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .endpoint {
    font-size: 0.75rem;
    color: var(--secondary);
  }

  .github-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--secondary);
    transition:
      color 150ms ease,
      background-color 150ms ease,
      border-color 150ms ease;
  }

  .github-link:hover {
    color: var(--text);
    background: var(--accent-subtle);
    border-color: var(--border);
  }

  .palette-trigger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 196px;
    height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--card);
    color: var(--secondary);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .palette-trigger:hover {
    border-color: var(--border-hover);
    background: var(--accent-subtle);
  }

  .palette-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kbd-hint {
    padding: 1px var(--space-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--code);
    color: var(--muted);
    font-size: 0.6875rem;
  }

  @media (max-width: 767px) {
    .hamburger {
      display: inline-flex;
    }

    .palette-trigger {
      width: 36px;
      padding: 0;
      justify-content: center;
      border-color: transparent;
      background: transparent;
    }

    .palette-text,
    .kbd-hint {
      display: none;
    }

    .endpoint {
      display: none;
    }
  }
</style>