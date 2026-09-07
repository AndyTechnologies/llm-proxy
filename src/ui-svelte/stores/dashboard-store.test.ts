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
    retryStep: 0,
    applyConfig: 0,
    unloadAllModels: 0,
    configureAgent: 0,
  };
  return {
    calls,
    api: {
      pipelines: async () => ((calls.pipelines += 1), rows.pipelines),
      models: async () => ((calls.models += 1), rows.models),
      executions: async () => ((calls.executions += 1), rows.executions),
      agents: async () => ((calls.agents += 1), rows.agents),
      config: async () => ((calls.config += 1), rows.config),
      retryStep: async (_executionId: string, _nodeId: string) =>
        ((calls.retryStep += 1), { success: true, retryExecutionId: "ex2" }),
      applyConfig: async (_config: unknown) => ((calls.applyConfig += 1), undefined),
      unloadAllModels: async () => ((calls.unloadAllModels += 1), { unloaded: 2 }),
      configureAgent: async (_config: { agent: string; apiKey?: string }) =>
        ((calls.configureAgent += 1), { ok: true, requiresRestart: true }),
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
    expect(s.failedNodes).toEqual({});
    expect(s.retrying).toBe(false);
    expect(s.retryError).toBeNull();
    expect(s.applying).toBe(false);
    expect(s.applyError).toBeNull();
    expect(s.unloadingAll).toBe(false);
    expect(s.unloadAllError).toBeNull();
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

describe("dashboard store (action wiring: retry / apply / unload)", () => {
  it("recordStepFailed stores the failed node per execution", () => {
    const store = createDashboardStore(deps());
    store.actions.recordStepFailed("ex1", "n2");
    expect(store.getSnapshot().failedNodes).toEqual({ ex1: "n2" });
  });

  it("retryStep passes the execution id and the recorded node to the api", async () => {
    const seen: { executionId: string; nodeId: string }[] = [];
    const api = {
      ...fakeApi().api,
      retryStep: async (executionId: string, nodeId: string) => {
        seen.push({ executionId, nodeId });
        return { success: true };
      },
    };
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    store.actions.recordStepFailed("ex1", "n2");
    await store.actions.retryStep("ex1");
    expect(seen[0]).toEqual({ executionId: "ex1", nodeId: "n2" });
  });

  it("retryStep revalidates executions on success", async () => {
    const { api, calls } = fakeApi();
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    store.actions.recordStepFailed("ex1", "n2");
    await store.actions.retryStep("ex1");
    expect(calls.retryStep).toBe(1);
    expect(calls.executions).toBe(1);
    const s = store.getSnapshot();
    expect(s.retrying).toBe(false);
    expect(s.retryError).toBeNull();
    expect(s.executions).toEqual(rows.executions);
  });

  it("retryStep is a no-op when no failed node was recorded", async () => {
    const { api, calls } = fakeApi();
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    await store.actions.retryStep("ex-unknown");
    expect(calls.retryStep).toBe(0);
    expect(calls.executions).toBe(0);
  });

  it("retryStep stays in-flight until the api responds", async () => {
    let resolveRetry!: (result: { success: boolean; retryExecutionId?: string }) => void;
    const api = {
      ...fakeApi().api,
      retryStep: (_executionId: string, _nodeId: string) =>
        new Promise<{ success: boolean; retryExecutionId?: string }>((resolve) => {
          resolveRetry = resolve;
        }),
    };
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    store.actions.recordStepFailed("ex1", "n2");
    const pending = store.actions.retryStep("ex1");
    expect(store.getSnapshot().retrying).toBe(true);
    resolveRetry({ success: true });
    await pending;
    expect(store.getSnapshot().retrying).toBe(false);
  });

  it("retryStep surfaces the api error without breaking the store", async () => {
    const api = {
      ...fakeApi().api,
      retryStep: async (_executionId: string, _nodeId: string) => {
        throw new Error("boom");
      },
    };
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    store.actions.recordStepFailed("ex1", "n2");
    await store.actions.retryStep("ex1");
    const s = store.getSnapshot();
    expect(s.retryError).toMatch(/boom/);
    expect(s.retrying).toBe(false);
  });

  it("applyConfig posts the config and reloads config + models", async () => {
    const { api, calls } = fakeApi();
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    const cfg = { llama: { lifecycle: { ttl: 600, vram: { mode: "dynamic", freeGb: 2, capGb: 8 } } } };
    await store.actions.applyConfig(cfg);
    expect(calls.applyConfig).toBe(1);
    expect(calls.config).toBe(1);
    expect(calls.models).toBe(1);
    const s = store.getSnapshot();
    expect(s.applying).toBe(false);
    expect(s.applyError).toBeNull();
    expect(s.config).toEqual(rows.config);
  });

  it("applyConfig surfaces the api error", async () => {
    const api = {
      ...fakeApi().api,
      applyConfig: async (_config: unknown) => {
        throw new Error("boom");
      },
    };
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    await store.actions.applyConfig({});
    const s = store.getSnapshot();
    expect(s.applyError).toMatch(/boom/);
    expect(s.applying).toBe(false);
  });

  it("unloadAllModels posts the unload and reloads models", async () => {
    const { api, calls } = fakeApi();
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    await store.actions.unloadAllModels();
    expect(calls.unloadAllModels).toBe(1);
    expect(calls.models).toBe(1);
    const s = store.getSnapshot();
    expect(s.unloadingAll).toBe(false);
    expect(s.unloadAllError).toBeNull();
  });

  it("unloadAllModels surfaces the api error", async () => {
    const api = {
      ...fakeApi().api,
      unloadAllModels: async (): Promise<{ unloaded: number }> => {
        throw new Error("boom");
      },
    };
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    await store.actions.unloadAllModels();
    const s = store.getSnapshot();
    expect(s.unloadAllError).toMatch(/boom/);
    expect(s.unloadingAll).toBe(false);
  });

  it("configureAgent posts the agent id and reloads agents on success", async () => {
    const { api, calls } = fakeApi();
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    await store.actions.configureAgent("a1");
    expect(calls.configureAgent).toBe(1);
    expect(calls.agents).toBe(1);
    const s = store.getSnapshot();
    expect(s.configuring.a1).toBe(false);
    expect(s.configureErrors.a1).toBe("");
    expect(s.agents).toEqual(rows.agents);
  });

  it("configureAgent is per-agent pending until the api responds", async () => {
    let resolveConfigure!: (result: { ok: boolean; requiresRestart: boolean }) => void;
    const api = {
      ...fakeApi().api,
      configureAgent: (_config: { agent: string; apiKey?: string }) =>
        new Promise<{ ok: boolean; requiresRestart: boolean }>((resolve) => {
          resolveConfigure = resolve;
        }),
    };
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    const pending = store.actions.configureAgent("a1");
    expect(store.getSnapshot().configuring.a1).toBe(true);
    resolveConfigure({ ok: true, requiresRestart: true });
    await pending;
    expect(store.getSnapshot().configuring.a1).toBe(false);
  });

  it("configureAgent surfaces the api error next to the agent", async () => {
    const api = {
      ...fakeApi().api,
      configureAgent: async (_config: { agent: string; apiKey?: string }) => {
        throw new Error("boom");
      },
    };
    const store = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    await store.actions.configureAgent("a1");
    const s = store.getSnapshot();
    expect(s.configureErrors.a1).toMatch(/boom/);
    expect(s.configuring.a1).toBe(false);
  });
});