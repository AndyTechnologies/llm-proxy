<script lang="ts">
  import { get } from "svelte/store";
  import Icon from "../common/Icon.svelte";
  import { trapFocus } from "../../lib/focus-trap.js";
  import { NAV_ITEMS } from "../../lib/navigation.js";
  import { commandPaletteOpen } from "../../lib/ui-state.js";

  /**
   * Ctrl/Cmd+K quick navigation between console routes. No entity search in
   * this phase — the palette filters static routes only.
   */
  let open = $state(false);
  let query = $state("");
  let activeIndex = $state(0);
  let inputEl = $state<HTMLInputElement>();
  let listEl = $state<HTMLUListElement>();
  let dialogEl = $state<HTMLDivElement>();
  let lastFocused: HTMLElement | null = null;

  const filtered = $derived(
    NAV_ITEMS.filter((item) => {
      const q = query.trim().toLowerCase();
      if (q === "") return true;
      return `${item.label} ${item.description} ${item.href}`.toLowerCase().includes(q);
    }),
  );

  // Keep the selection inside the list when filtering shrinks it.
  $effect(() => {
    if (activeIndex >= filtered.length) {
      activeIndex = Math.max(0, filtered.length - 1);
    }
  });

  // Mirror the shared store (Topbar trigger writes it).
  $effect(() => {
    const next = get(commandPaletteOpen);
    if (next && !open) {
      lastFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      activeIndex = 0;
      query = "";
    }
    open = next;
  });

  // Focus the input on open, restore the trigger's focus on close, and keep
  // Tab inside the palette while it is open (dialog focus containment).
  $effect(() => {
    if (open) {
      requestAnimationFrame(() => inputEl?.focus());
      const dialog = dialogEl;
      return dialog === undefined ? undefined : trapFocus(dialog);
    }
    lastFocused?.focus();
    lastFocused = null;
  });

  // Global shortcut: Ctrl/Cmd+K toggles, Escape closes.
  $effect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        commandPaletteOpen.set(!get(commandPaletteOpen));
        return;
      }
      if (event.key === "Escape" && get(commandPaletteOpen)) {
        commandPaletteOpen.set(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function close(): void {
    commandPaletteOpen.set(false);
  }

  function move(delta: number): void {
    if (filtered.length === 0) return;
    activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
    const el = listEl?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }

  function go(): void {
    const item = filtered[activeIndex];
    if (item === undefined) return;
    close();
    window.location.assign(item.href);
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      go();
    }
  }
</script>

{#if open}
  <div class="palette-backdrop" onclick={close}>
    <div
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Quick navigation"
      bind:this={dialogEl}
      onclick={(event) => event.stopPropagation()}
    >
      <div class="palette-input-row">
        <Icon name="search" size={16} />
        <input
          bind:this={inputEl}
          bind:value={query}
          class="palette-input"
          type="text"
          placeholder="Jump to a page…"
          aria-label="Filter pages"
          onkeydown={onInputKeydown}
        />
        <kbd class="kbd-hint">Esc</kbd>
      </div>

      {#if filtered.length === 0}
        <p class="palette-empty">No matching pages.</p>
      {:else}
        <ul class="palette-list" bind:this={listEl} aria-label="Pages">
          {#each filtered as item, i (item.href)}
            <li>
              <a
                href={item.href}
                class="palette-item"
                class:active={i === activeIndex}
                onmouseenter={() => {
                  activeIndex = i;
                }}
                onfocus={() => {
                  activeIndex = i;
                }}
                onclick={(event) => event.stopPropagation()}
              >
                <Icon name={item.icon} size={16} />
                <span class="palette-item-text">
                  <span class="palette-item-label">{item.label}</span>
                  <span class="palette-item-desc">{item.description}</span>
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 15vh var(--space-4) var(--space-4);
    background: rgba(0, 0, 0, 0.6);
  }

  .palette {
    width: min(560px, 100%);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    background: var(--card);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }

  .palette-input-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
  }

  .palette-input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.9375rem;
  }

  .palette-input::placeholder {
    color: var(--muted);
  }

  .palette-input:focus {
    outline: none;
  }

  .kbd-hint {
    padding: 1px var(--space-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--code);
    color: var(--muted);
    font-size: 0.6875rem;
  }

  .palette-list {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
    max-height: 320px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .palette-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    color: var(--secondary);
  }

  .palette-item:hover {
    color: var(--text);
    background: var(--accent-subtle);
  }

  .palette-item.active {
    color: var(--text);
    background: var(--accent-subtle);
  }

  .palette-item-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .palette-item-label {
    font-size: 0.875rem;
    font-weight: 600;
  }

  .palette-item-desc {
    font-size: 0.75rem;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .palette-empty {
    margin: 0;
    padding: var(--space-4);
    color: var(--muted);
    font-size: 0.875rem;
  }
</style>