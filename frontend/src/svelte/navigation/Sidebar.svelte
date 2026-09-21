<script lang="ts">
  import { get } from "svelte/store";
  import Icon from "../common/Icon.svelte";
  import { NAV_GROUPS, isRouteActive } from "../../lib/navigation.js";
  import { sidebarDrawerOpen } from "../../lib/ui-state.js";

  let { current }: { current: string } = $props();

  /** Mobile drawer visibility, mirrored from the shared store. */
  let drawerOpen = $state(false);

  $effect(() => {
    drawerOpen = get(sidebarDrawerOpen);
  });

  function closeDrawer(): void {
    sidebarDrawerOpen.set(false);
  }

  // Escape closes the drawer once it is open (keyboard parity with the scrim).
  $effect(() => {
    if (!drawerOpen) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") closeDrawer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<aside
  class="sidebar"
  class:open-drawer={drawerOpen}
  aria-label="Primary navigation"
>
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">WeaveLLM</span>
  </div>

  <nav class="nav">
    {#each NAV_GROUPS as group (group.section)}
      <div class="nav-group">
        <span class="nav-group-label">{group.section}</span>
        <ul class="nav-list">
          {#each group.items as item (item.href)}
            <li>
              <a
                href={item.href}
                class="nav-item"
                class:active={isRouteActive(item.href, current)}
                title={item.label}
                aria-current={isRouteActive(item.href, current) ? "page" : undefined}
              >
                <Icon name={item.icon} size={16} />
                <span class="nav-item-label">{item.label}</span>
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </nav>

  <footer class="sidebar-footer">
    <span class="footer-text">Local AI runtime console</span>
  </footer>
</aside>

<!-- Full-screen scrim, visible only for the mobile drawer. -->
<button
  type="button"
  class="scrim"
  class:visible={drawerOpen}
  aria-label="Close navigation menu"
  tabindex={drawerOpen ? 0 : -1}
  onclick={closeDrawer}
></button>

<style>
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    width: 240px;
    background: var(--bg);
    border-right: 1px solid var(--border);
    transition: transform 200ms ease;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: 56px;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .brand-mark {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    background: var(--accent);
  }

  .brand-name {
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .nav {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4) var(--space-3);
  }

  .nav-group {
    margin-bottom: var(--space-5);
  }

  .nav-group-label {
    display: block;
    margin: 0 var(--space-2) var(--space-2);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    white-space: nowrap;
  }

  .nav-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    color: var(--secondary);
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    transition:
      color 150ms ease,
      background-color 150ms ease;
  }

  .nav-item:hover {
    color: var(--text);
    background: var(--accent-subtle);
  }

  .nav-item.active {
    color: var(--text);
    background: var(--accent-subtle);
  }

  .nav-item.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 25%;
    height: 50%;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
  }

  .sidebar-footer {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .footer-text {
    font-size: 0.75rem;
    color: var(--muted);
    white-space: nowrap;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: rgba(0, 0, 0, 0.55);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 200ms ease;
  }

  .scrim.visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }

  /* Icon rail on medium screens */
  @media (min-width: 768px) and (max-width: 1023px) {
    .sidebar {
      width: 64px;
    }

    .brand {
      justify-content: center;
      padding: 0;
    }

    .brand-name,
    .nav-group-label,
    .nav-item-label,
    .footer-text {
      display: none;
    }

    .nav-group {
      margin-bottom: var(--space-3);
    }

    .nav-item {
      justify-content: center;
      padding: var(--space-2);
    }

    .nav-item.active::before {
      left: 0;
      top: 20%;
      height: 60%;
    }
  }

  /* Off-canvas drawer below 768px */
  @media (max-width: 767px) {
    .sidebar {
      width: 240px;
      transform: translateX(-100%);
    }

    .sidebar.open-drawer {
      transform: translateX(0);
      box-shadow: 0 0 0 1px var(--border), 0 16px 48px rgba(0, 0, 0, 0.5);
    }
  }

  @media (min-width: 768px) {
    .scrim {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar,
    .scrim {
      transition: none;
    }
  }
</style>