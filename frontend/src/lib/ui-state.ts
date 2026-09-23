import { writable } from "svelte/store";

/**
 * Cross-island UI state. The shell renders Sidebar, Topbar, StatusBar and
 * CommandPalette as separate Svelte islands; these writable stores let them
 * coordinate without prop drilling (same module instance per page).
 */

/** Mobile drawer visibility — toggled from the Topbar hamburger. */
export const sidebarDrawerOpen = writable(false);

/** Command palette (Ctrl/Cmd+K quick navigation) visibility. */
export const commandPaletteOpen = writable(false);