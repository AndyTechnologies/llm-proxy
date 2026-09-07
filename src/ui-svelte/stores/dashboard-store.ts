/**
 * Consolidated dashboard store factory (svelte-ui task 3.1, MINOR-B).
 *
 * One store layer owns the five REST refresh domains (pipelines, models,
 * executions, agents, config). SSE events and intervals all funnel through
 * `scheduleRefresh`, which **throttles/dedupes triggers inside a window**:
 * N events arriving in 500 ms produce ONE fetch per domain (the spec's
 * "batched rather than per-event refetch" — no jank under SSE load).
 *
 * Everything is injected (fetchers + scheduler), so tests run deterministic
 * and offline; the browser wiring passes real rest-service fetchers and
 * setTimeout/clearTimeout-backed scheduling.
 */
import { writable, get } from "svelte/store";
import type {
  PipelineSummary,
  ModelEntry,
  ExecutionEntry,
  AgentEntry,
  LifecycleConfig,
  LifecycleData,
  RetryStepResult,
} from "./types.js";

export interface DashboardApi {
  pipelines(): Promise<PipelineSummary[]>;
  models(): Promise<{ models: ModelEntry[]; modelsDir: string; lifecycle: LifecycleData | null }>;
  executions(limit?: number): Promise<ExecutionEntry[]>;
  agents(): Promise<AgentEntry[]>;
  config(): Promise<LifecycleConfig>;
  retryStep(executionId: string, nodeId: string): Promise<RetryStepResult>;
  applyConfig(config: unknown): Promise<unknown>;
  unloadAllModels(): Promise<{ unloaded: number }>;
  configureAgent(config: { agent: string; apiKey?: string }): Promise<unknown>;
}

export type RefreshDomain = "pipelines" | "models" | "executions" | "agents" | "config";
export type DomainErrors = Partial<Record<RefreshDomain, string>>;

/** Scheduler contract: run `fn` after `ms`, return a cancel function. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

export interface DashboardState {
  pipelines: PipelineSummary[];
  models: ModelEntry[];
  modelsDir: string | null;
  lifecycle: LifecycleData | null;
  executions: ExecutionEntry[];
  agents: AgentEntry[];
  config: LifecycleConfig | null;
  errors: DomainErrors;
  /** executionId → failed step nodeId recorded from SSE step:failed. */
  failedNodes: Record<string, string>;
  retrying: boolean;
  retryError: string | null;
  applying: boolean;
  applyError: string | null;
  unloadingAll: boolean;
  unloadAllError: string | null;
  /** agent id → configure in flight. */
  configuring: Record<string, boolean>;
  /** agent id → inline configure error (null when none). */
  configureErrors: Record<string, string>;
}

export interface DashboardActions {
  loadPipelines(): Promise<void>;
  loadModels(): Promise<void>;
  loadExecutions(limit?: number): Promise<void>;
  loadAgents(): Promise<void>;
  loadConfig(): Promise<void>;
  /** Throttled/deduped single-domain refresh (SSE + interval path). */
  scheduleRefresh(domain: RefreshDomain): void;
  /** Immediate reload of every interval domain (boot path). */
  refreshAll(): Promise<void>;
  /** Record an SSE step:failed payload so failed rows know their retry node. */
  recordStepFailed(executionId: string, nodeId: string): void;
  /** Retry the failed step of an execution (nodeId taken from the SSE record). */
  retryStep(executionId: string): Promise<void>;
  /** Apply a full config payload; reload config + models on success. */
  applyConfig(config: unknown): Promise<void>;
  /** Unload every loaded model; reload models on success. */
  unloadAllModels(): Promise<void>;
  /** Configure (sync) an agent's provider with the gateway; reload agents on success. */
  configureAgent(agentId: string): Promise<void>;
  reset(): void;
}

export interface DashboardDeps {
  api: DashboardApi;
  /** Scheduling primitive; default set in the browser wiring. In tests a
   * manual scheduler keeps the throttle deterministic. */
  schedule?: Scheduler;
  /** Throttle window in ms; triggers inside it collapse into one fetch. */
  refreshWindowMs?: number;
  /** Called with (domain, error) instead of throwing into the UI. */
  onError?: (domain: RefreshDomain, error: unknown) => void;
}

export interface DashboardStore {
  subscribe: (run: (value: DashboardState) => void) => () => void;
  getSnapshot(): DashboardState;
  actions: DashboardActions;
}

const DEFAULT_WINDOW_MS = 500;

const INITIAL: DashboardState = {
  pipelines: [],
  models: [],
  modelsDir: null,
  lifecycle: null,
  executions: [],
  agents: [],
  config: null,
  errors: {},
  failedNodes: {},
  retrying: false,
  retryError: null,
  applying: false,
  applyError: null,
  unloadingAll: false,
  unloadAllError: null,
  configuring: {},
  configureErrors: {},
};

export function createDashboardStore(deps: DashboardDeps): DashboardStore {
  const windowMs = deps.refreshWindowMs ?? DEFAULT_WINDOW_MS;
  const schedule: Scheduler =
    deps.schedule ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  const onError = deps.onError ?? (() => {});

  const store = writable<DashboardState>({ ...INITIAL });

  /** One pending throttled trigger per domain (dedupe set). */
  const pending = new Set<RefreshDomain>();

  function run(domain: RefreshDomain, loader: () => Promise<void>): Promise<void> {
    return loader().catch((err: unknown) => {
      store.update((s) => ({
        ...s,
        errors: { ...s.errors, [domain]: err instanceof Error ? err.message : String(err) },
      }));
      onError(domain, err);
    });
  }

  const loaders: Record<RefreshDomain, () => Promise<void>> = {
    pipelines: () =>
      run("pipelines", async () => {
        const rows = await deps.api.pipelines();
        store.update((s) => ({ ...s, pipelines: rows }));
      }),
    models: () =>
      run("models", async () => {
        const res = await deps.api.models();
        store.update((s) => ({ ...s, models: res.models, modelsDir: res.modelsDir, lifecycle: res.lifecycle }));
      }),
    executions: () =>
      run("executions", async () => {
        const rows = await deps.api.executions();
        store.update((s) => ({ ...s, executions: rows }));
      }),
    agents: () =>
      run("agents", async () => {
        const rows = await deps.api.agents();
        store.update((s) => ({ ...s, agents: rows }));
      }),
    config: () =>
      run("config", async () => {
        const cfg = await deps.api.config();
        store.update((s) => ({ ...s, config: cfg }));
      }),
  };

  const actions: DashboardActions = {
    loadPipelines: loaders.pipelines,
    loadModels: loaders.models,
    loadExecutions: (limit) => run("executions", async () => {
      const rows = await deps.api.executions(limit);
      store.update((s) => ({ ...s, executions: rows }));
    }),
    loadAgents: loaders.agents,
    loadConfig: loaders.config,

    recordStepFailed(executionId, nodeId) {
      store.update((s) => ({ ...s, failedNodes: { ...s.failedNodes, [executionId]: nodeId } }));
    },

    async retryStep(executionId) {
      const nodeId = get(store).failedNodes[executionId];
      if (!nodeId) return;
      store.update((s) => ({ ...s, retrying: true, retryError: null }));
      try {
        await deps.api.retryStep(executionId, nodeId);
        await actions.loadExecutions();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.update((s) => ({ ...s, retryError: message }));
      } finally {
        store.update((s) => ({ ...s, retrying: false }));
      }
    },

    async applyConfig(config) {
      store.update((s) => ({ ...s, applying: true, applyError: null }));
      try {
        await deps.api.applyConfig(config);
        await Promise.all([actions.loadConfig(), actions.loadModels()]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.update((s) => ({ ...s, applyError: message }));
      } finally {
        store.update((s) => ({ ...s, applying: false }));
      }
    },

    async unloadAllModels() {
      store.update((s) => ({ ...s, unloadingAll: true, unloadAllError: null }));
      try {
        await deps.api.unloadAllModels();
        await actions.loadModels();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.update((s) => ({ ...s, unloadAllError: message }));
      } finally {
        store.update((s) => ({ ...s, unloadingAll: false }));
      }
    },

    async configureAgent(agentId) {
      store.update((s) => ({
        ...s,
        configuring: { ...s.configuring, [agentId]: true },
        configureErrors: { ...s.configureErrors, [agentId]: "" },
      }));
      try {
        await deps.api.configureAgent({ agent: agentId });
        await actions.loadAgents();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.update((s) => ({
          ...s,
          configureErrors: { ...s.configureErrors, [agentId]: message },
        }));
      } finally {
        store.update((s) => ({
          ...s,
          configuring: { ...s.configuring, [agentId]: false },
        }));
      }
    },

    scheduleRefresh(domain) {
      if (pending.has(domain)) return;
      pending.add(domain);
      schedule(() => {
        pending.delete(domain);
        void loaders[domain]();
      }, windowMs);
    },

    async refreshAll() {
      await Promise.all([
        actions.loadPipelines(),
        actions.loadModels(),
        actions.loadExecutions(),
        actions.loadAgents(),
        actions.loadConfig(),
      ]);
    },

    reset() {
      pending.clear();
      store.update(() => ({ ...INITIAL }));
    },
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: () => get(store),
    actions,
  };
}