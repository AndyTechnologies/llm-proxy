/**
 * App composition-root contracts (svelte-ui task 3.3).
 *
 * Kept in a plain .ts module (no svelte imports) so tests and fakes can
 * reference AppDeps/AppStores without importing a `.svelte` file through
 * the root-tsc typecheck gate (see svelte-shim.d.ts).
 */
import type { DashboardStore } from "./stores/dashboard-store.js";
import type { EditorStore } from "./stores/editor-store.js";
import type { SseService } from "./services/sse-service.js";
import type { TraceService } from "./services/trace-service.js";

/** The store layer App owns and shares with the five views. */
export interface AppStores {
  editor: EditorStore;
  dashboard: DashboardStore;
  trace: TraceService;
}

/** Injectable App dependencies (tests wire fakes; browser uses rest/SSE). */
export interface AppDeps {
  makeStores(): AppStores;
  makeSse(stores: AppStores): SseService;
}

/** Hash-route identifiers used by the app nav. */
export const NAV_VIEWS = ["editor", "pipelines", "models", "executions", "agents"] as const;
export type ViewId = (typeof NAV_VIEWS)[number];