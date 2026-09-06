/**
 * RED→GREEN tests for the consolidated dashboard store (svelte-ui task 3.1,
 * MINOR-B).
 *
 * One store layer owns the five REST refresh domains (pipelines, models,
 * executions, agents, config) with a **consolidated throttled refresh**: N
 * triggers inside the refresh window collapse into a single fetch. Fetchers
 * and the scheduler are injected, so tests stay deterministic (no real
 * timers, no network).
 */
import { describe, it, expect } from "bun:test";
import { createDashboardStore } from "./dashboard-store.js";
import type { DashboardDeps } from "./dashboard-store.js";

const rows = {
  pipelines: [{ id: "p1" }, { id: "p2" }],
  models: {
    models: [{ id: "qwen:7b", loaded: true }],
    modelsDir: "/models",
    lifecycle: { vramPolicyActive: true },
  },
  executions: [{ id: "e1", pipelineId: "p1", status: "ok" }],
  agents: [{ id: "a1", label: "A", configPath: "/cfg" }],
  config: { llama: { lifecycle: { ttl: 300 } } },
};

function fakeApi() {
  const calls: Record<string, number> = {
    pipelines: 0,
    models: 0,
    executions: 0,
    agents: 0,
    config: 0,
  };
  return {
    calls,
    api: {
      pipelines: async () => ((calls.pipelines += 1), rows.pipelines),
      models: async () => ((calls.models += 1), rows.models),
      executions: async () => ((calls.executions += 1), rows.executions),
      agents: async () => ((calls.agents += 1), rows.agents),
      config: async () => ((calls.config += 1), rows.config),
    },
  };
}

/** Manual scheduler: records callbacks, the test flushes them. */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: ((fn: () => void, _ms: number) => {
      queue.push(fn);
      return () => {
        const i = queue.indexOf(fn);
        if (i >= 0) queue.splice(i, 1);
      };
    }) as DashboardDeps["schedule"],
    flush: () => {
      while (queue.length > 0) queue.shift()!();
    },
    drain: () => {
      queue.length = 0;
    },
  };
}

function deps(overrides: Partial<DashboardDeps> = {}): DashboardDeps {
  const { api } = fakeApi();
  return {
    api,
    schedule: manualScheduler().schedule,
    onError: () => {},
    ...overrides,
  };
}

describe("dashboard store (consolidated domains)", () => {
  it("factory returns fresh, isolated stores", async () => {
    const a = createDashboardStore(deps());
    const b = createDashboardStore(deps());
    expect(a).not.toBe(b);
    await a.actions.loadPipelines();
    expect(a.getSnapshot().pipelines).toHaveLength(2);
    expect(b.getSnapshot().pipelines).toHaveLength(0);
  });

  it("starts empty with no errors", () => {
    const s = createDashboardStore(deps()).getSnapshot();
    expect(s.pipelines).toEqual([]);
    expect(s.models).toEqual([]);
    expect(s.executions).toEqual([]);
    expect(s.agents).toEqual([]);
    expect(s.config).toBeNull();
    expect(s.errors).toEqual({});
  });

  it("loadPipelines stores the summary rows", async () => {
    const store = createDashboardStore(deps());
    await store.actions.loadPipelines();
    expect(store.getSnapshot().pipelines).toEqual(rows.pipelines);
  });

  it("loadModels stores models, modelsDir and lifecycle", async () => {
    const store = createDashboardStore(deps());
    await store.actions.loadModels();
    const s = store.getSnapshot();
    expect(s.models).toEqual(rows.models.models);
    expect(s.modelsDir).toBe("/models");
    expect(s.lifecycle).toEqual({ vramPolicyActive: true });
  });

  it("loadExecutions stores the rows", async () => {
    const store = createDashboardStore(deps());
    await store.actions.loadExecutions();
    expect(store.getSnapshot().executions).toEqual(rows.executions);
  });

  it("loadAgents stores the rows", async () => {
    const store = createDashboardStore(deps());
    await store.actions.loadAgents();
    expect(store.getSnapshot().agents).toEqual(rows.agents);
  });

  it("loadConfig stores the live config", async () => {
    const store = createDashboardStore(deps());
    await store.actions.loadConfig();
    expect(store.getSnapshot().config).toEqual(rows.config);
  });

  it("a failed refresh records a per-domain error and stays usable", async () => {
    const store = createDashboardStore(
      deps({
        api: {
          ...deps().api,
          agents: async () => {
            throw new Error("boom");
          },
        },
      }),
    );
    await store.actions.loadAgents();
    const s = store.getSnapshot();
    expect(s.errors.agents).toMatch(/boom/);
    expect(s.agents).toEqual([]);
    // other domains still work
    await store.actions.loadPipelines();
    expect(store.getSnapshot().pipelines).toHaveLength(2);
  });

  it("scheduleRefresh batches N triggers into a single fetch per domain", async () => {
    const { api, calls } = fakeApi();
    const sched = manualScheduler();
    const store = createDashboardStore({ api, schedule: sched.schedule, onError: () => {} });

    store.actions.scheduleRefresh("pipelines");
    store.actions.scheduleRefresh("pipelines");
    store.actions.scheduleRefresh("models");
    store.actions.scheduleRefresh("pipelines");
    expect(calls.pipelines).toBe(0);
    expect(calls.models).toBe(0);

    sched.flush(); // the throttled window elapses once
    // The triggered fetches resolve on microtasks after the flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.pipelines).toBe(1);
    expect(calls.models).toBe(1);
    expect(store.getSnapshot().pipelines).toHaveLength(2);
  });

  it("refreshAll reloads the five interval domains", async () => {
    const { api, calls } = fakeApi();
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    await store.actions.refreshAll();
    expect(calls.pipelines).toBe(1);
    expect(calls.models).toBe(1);
    expect(calls.executions).toBe(1);
    expect(calls.agents).toBe(1);
    expect(calls.config).toBe(1);
  });

  it("reset clears every domain and error", async () => {
    const store = createDashboardStore(deps());
    await store.actions.refreshAll();
    store.actions.reset();
    const s = store.getSnapshot();
    expect(s.pipelines).toEqual([]);
    expect(s.models).toEqual([]);
    expect(s.executions).toEqual([]);
    expect(s.agents).toEqual([]);
    expect(s.config).toBeNull();
    expect(s.errors).toEqual({});
  });
});