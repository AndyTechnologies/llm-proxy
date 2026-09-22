/**
 * Console navigation registry — single source of truth for sidebar links,
 * command palette entries and active-route matching. Pure data + pure
 * functions, so the same module serves Astro SSR, Svelte islands and tests.
 */

export const NAV_SECTIONS = {
  overview: "Overview",
  build: "Build",
  manage: "Manage",
  observe: "Observe",
  system: "System",
} as const;

export type NavSection = (typeof NAV_SECTIONS)[keyof typeof NAV_SECTIONS];

/** Inline SVG icon names (geometry lives in svelte/common/Icon.svelte). */
export const ICON_NAMES = {
  overview: "overview",
  workflows: "workflows",
  models: "models",
  catalog: "catalog",
  downloads: "downloads",
  providers: "providers",
  executions: "executions",
  api: "api",
  runtime: "runtime",
  settings: "settings",
  about: "about",
  search: "search",
  github: "github",
  menu: "menu",
  close: "close",
  back: "back",
  chevron: "chevron",
  plus: "plus",
  play: "play",
  check: "check",
} as const;

export type IconName = (typeof ICON_NAMES)[keyof typeof ICON_NAMES];

export interface NavItem {
  href: string;
  label: string;
  description: string;
  icon: IconName;
  section: NavSection;
}

export interface NavGroup {
  section: NavSection;
  items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    section: "overview",
    items: [
      {
        href: "/",
        label: "Overview",
        description: "Runtime overview and quick actions",
        icon: "overview",
        section: "overview",
      },
    ],
  },
  {
    section: "build",
    items: [
      {
        href: "/workflows",
        label: "Workflows",
        description: "Graph workflow library and editor",
        icon: "workflows",
        section: "build",
      },
    ],
  },
  {
    section: "manage",
    items: [
      {
        href: "/models",
        label: "Models",
        description: "Local model registry",
        icon: "models",
        section: "manage",
      },
      {
        href: "/models/catalog",
        label: "Model catalog",
        description: "Curated and community models",
        icon: "catalog",
        section: "manage",
      },
      {
        href: "/models/downloads",
        label: "Downloads",
        description: "Checksum-verified GGUF downloads",
        icon: "downloads",
        section: "manage",
      },
      {
        href: "/providers",
        label: "Providers",
        description: "External provider connections",
        icon: "providers",
        section: "manage",
      },
    ],
  },
  {
    section: "observe",
    items: [
      {
        href: "/executions",
        label: "Executions",
        description: "Workflow run logs",
        icon: "executions",
        section: "observe",
      },
      {
        href: "/playground",
        label: "API",
        description: "OpenAI-compatible playground",
        icon: "api",
        section: "observe",
      },
      {
        href: "/runtime",
        label: "Runtime",
        description: "Backend health and endpoint",
        icon: "runtime",
        section: "observe",
      },
    ],
  },
  {
    section: "system",
    items: [
      {
        href: "/settings",
        label: "Settings",
        description: "Application configuration",
        icon: "settings",
        section: "system",
      },
      {
        href: "/about",
        label: "About",
        description: "Version and credits",
        icon: "about",
        section: "system",
      },
    ],
  },
];

/** Flat list over every group (sidebar renders groups, palette renders flat). */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap(
  (group) => group.items,
);

/**
 * Active-route rule: exact match, or a path nested under the item. The root
 * href ("/") never prefix-matches, so Overview only highlights on `/`.
 */
export function isRouteActive(href: string, current: string): boolean {
  if (href === "/") return current === "/";
  return current === href || current.startsWith(`${href}/`);
}