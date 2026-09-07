/**
 * Shared fakes for svelte-ui component tests (tasks 3.3+).
 *
 * Pure TS, framework-free, no DOM access — only store/service fakes wired
 * through the same injectable seams the browser uses (dashboard api,
 * editor api, scheduler, EventSource factory). Component tests import these
 * to render views/App deterministically and offline.
 */
import { createDashboardStore, type DashboardApi, type DashboardStore } from "../stores/dashboard-store.js";
import { createEditorStore, type EditorApi, type EditorStore } from "../stores/editor-store.js";
import { createSseService, type SseService } from "../services/sse-service.js";
import { createTraceService, type TraceService } from "../services/trace-service.js";
import { applySseEvent } from "../lib/sse-effects.js";
import { SSE_STATE, type SSEEventName, type SSEState } from "../stores/types.js";
import type { AppDeps, AppStores } from "../app-types.js";
import type { GraphNode, GraphEdge } from "../lib/graph-model.js";

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export interface FakeEditorApiOptions {
  pipeline?: { id: string; name: string | null; nodes: GraphNode[]; edges: GraphEdge[] };
  validate?: { valid: boolean; errors?: string[] };
}

export function makeFakeEditorApi(options: FakeEditorApiOptions = {}): EditorApi & {
  calls: { getPipeline: number; validate: number; apply: number };
} {
  const calls = { getPipeline: 0, validate: 0, apply: 0 };
  return {
    calls,
    async getPipeline(id) {
      calls.getPipeline += 1;
      return (
        options.pipeline ?? {
          id,
          name: null,
          nodes: [
            { id: "n1", type: "start" as const, pos: { x: 40, y: 40 } },
            { id: "n2", type: "end" as const, pos: { x: 400, y: 40 } },
          ],
          edges: [{ id: "e1", from: "n1", to: "n2" }],
        }
      );
    },
    async validate(_payload) {
      calls.validate += 1;
      return options.validate ?? { valid: true };
    },
    async apply() {
      calls.apply += 1;
      return { ok: true };
    },
  };
}

export function makeEditorStore(options: FakeEditorApiOptions = {}): EditorStore {
  return createEditorStore({ api: makeFakeEditorApi(options) });
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export interface FakeDashboardData {
  pipelines: import("../stores/types.js").PipelineSummary[];
  models: import("../stores/types.js").ModelEntry[];
  modelsDir: string;
  lifecycle: import("../stores/types.js").LifecycleData | null;
  executions: import("../stores/types.js").ExecutionEntry[];
  agents: import("../stores/types.js").AgentEntry[];
  config: import("../stores/types.js").LifecycleConfig;
}

export function makeFakeDashboardApi(
  data: Partial<FakeDashboardData> = {},
): DashboardApi & {
  calls: { [K in keyof DashboardApi]: number };
  /** Last config passed to applyConfig (asserted in component tests). */
  lastAppliedConfig: unknown;
  /** Last (executionId, nodeId) passed to retryStep. */
  lastRetry: { executionId: string; nodeId: string } | null;
} {
  const calls = {
    pipelines: 0,
    models: 0,
    executions: 0,
    agents: 0,
    config: 0,
    retryStep: 0,
    applyConfig: 0,
    unloadAllModels: 0,
    configureAgent: 0,
  };
  return {
    calls,
    lastAppliedConfig: undefined,
    lastRetry: null,
    async pipelines() {
      calls.pipelines += 1;
      return data.pipelines ?? [];
    },
    async models() {
      calls.models += 1;
      return {
        models: data.models ?? [],
        modelsDir: data.modelsDir ?? "",
        lifecycle: data.lifecycle ?? null,
      };
    },
    async executions() {
      calls.executions += 1;
      return data.executions ?? [];
    },
    async agents() {
      calls.agents += 1;
      return data.agents ?? [];
    },
    async config() {
      calls.config += 1;
      return data.config ?? {};
    },
    async retryStep(executionId: string, nodeId: string) {
      calls.retryStep += 1;
      this.lastRetry = { executionId, nodeId };
      return { success: true, retryExecutionId: "ex-retry" };
    },
    async applyConfig(config: unknown) {
      calls.applyConfig += 1;
      this.lastAppliedConfig = config;
    },
    async unloadAllModels() {
      calls.unloadAllModels += 1;
      return { unloaded: 0 };
    },
    async configureAgent(_config: { agent: string; apiKey?: string }) {
      calls.configureAgent += 1;
      return { ok: true, requiresRestart: true };
    },
  };
}

/** Component-test scheduler: real timer with a short window so the store's
 *  throttle/dedupe semantics stay observable (immediate scheduling would
 *  turn N events into N fetches). */
export function makeDashboardStore(data: Partial<FakeDashboardData> = {}): DashboardStore {
  return createDashboardStore({
    api: makeFakeDashboardApi(data),
    refreshWindowMs: 50,
  });
}

/* ------------------------------------------------------------------ */
/* Trace + SSE                                                         */
/* ------------------------------------------------------------------ */

export function makeTrace(): TraceService {
  return createTraceService();
}

/** Deterministic EventSource fake for SSE tests. */
export class FakeSource {
  listeners = new Map<string, Set<(ev: { data?: string }) => void>>();
  private _onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  /** Fires synchronously on assignment — mimics a browser that is already
   * connected when the service attaches its handler. */
  set onopen(handler: ((ev: unknown) => void) | null) {
    this._onopen = handler;
    handler?.({});
  }

  get onopen(): ((ev: unknown) => void) | null {
    return this._onopen;
  }

  addEventListener(type: string, listener: (ev: { data?: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (ev: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const ev = { data: JSON.stringify(data) };
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }
}

export interface FakeSseOptions {
  onEvent?: (type: SSEEventName, data: unknown) => void;
  onStateChange?: (state: SSEState) => void;
}

/** Injectable sse-service factory backed by FakeSource instances. */
export function makeFakeSse(options: FakeSseOptions = {}): {
  sse: SseService;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const sse = createSseService({
    sourceFactory: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    reconnectDelayMs: 5,
    onEvent: options.onEvent ?? (() => {}),
    onStateChange: options.onStateChange,
  });
  return { sse, sources };
}

/* ------------------------------------------------------------------ */
/* App                                                                */
/* ------------------------------------------------------------------ */

export interface MakeAppDepsResult {
  deps: AppDeps;
  /** Populated once App mounts (makeStores runs during instantiation). */
  stores: AppStores | null;
  /** Populated once App mounts (makeSse runs during instantiation). */
  sse: SseService | null;
  editorApi: ReturnType<typeof makeFakeEditorApi>;
  dashboardApi: ReturnType<typeof makeFakeDashboardApi>;
  sources: FakeSource[];
}

/**
 * AppDeps wired to fakes, plus handles so tests can assert call counts,
 * emit SSE events, and observe store state.
 */
export function makeAppDeps(data: Partial<FakeDashboardData> = {}): MakeAppDepsResult {
  const editorApi = makeFakeEditorApi();
  const dashboardApi = makeFakeDashboardApi(data);
  const result: MakeAppDepsResult = {
    deps: null as unknown as AppDeps,
    stores: null,
    sse: null,
    editorApi,
    dashboardApi,
    sources: [],
  };

  result.deps = {
    makeStores() {
      const stores: AppStores = {
        editor: createEditorStore({ api: editorApi }),
        dashboard: createDashboardStore({
          api: dashboardApi,
          refreshWindowMs: 50,
        }),
        trace: createTraceService(),
      };
      result.stores = stores;
      return stores;
    },
    makeSse(created) {
      const sse = createSseService({
        sourceFactory: () => {
          const source = new FakeSource();
          result.sources.push(source);
          return source;
        },
        reconnectDelayMs: 5,
        onEvent: (type, data) => {
          // Same mapping the browser wiring uses (lib/sse-effects.ts), so
          // harness and production can never drift.
          applySseEvent({ type, data }, created);
        },
      });
      result.sse = sse;
      return sse;
    },
  };

  return result;
}

// Re-export for tests that only need the state constant.
export { SSE_STATE };
export type { SSEState };