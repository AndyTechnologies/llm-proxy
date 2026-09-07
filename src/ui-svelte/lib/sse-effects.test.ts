/**
 * RED→GREEN tests for the SSE→store mapping (svelte-ui verify scenarios 9
 * and 11).
 *
 * `applySseEvent` is the single mapping used by BOTH the browser wiring
 * (App's makeSse) and the test harness (fakes' makeSse), so the two can
 * never drift: every dashboard event funnels into the batched store refresh
 * and `step:failed` additionally feeds the retry wiring through
 * `recordStepFailed`.
 */
import { describe, it, expect } from "bun:test";
import { createDashboardStore, type DashboardDeps } from "../stores/dashboard-store.js";
import { createTraceService } from "../services/trace-service.js";
import { applySseEvent } from "./sse-effects.js";

/** Deterministic harness: throttled refresh flushable on demand. */
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
  };
}

function harness() {
  const calls = { pipelines: 0, models: 0, executions: 0, agents: 0, config: 0 };
  const api = {
    pipelines: async () => ((calls.pipelines += 1), []),
    models: async () => ((calls.models += 1), { models: [], modelsDir: "", lifecycle: null }),
    executions: async () => ((calls.executions += 1), []),
    agents: async () => ((calls.agents += 1), []),
    config: async () => ((calls.config += 1), {}),
    retryStep: async () => ({ success: true }),
    applyConfig: async () => undefined,
    unloadAllModels: async () => ({ unloaded: 0 }),
    configureAgent: async () => ({ ok: true, requiresRestart: true }),
  };
  return { calls, api };
}

/** Flush the throttled triggers and let the triggered fetches resolve. */
async function settle(sched: ReturnType<typeof manualScheduler>): Promise<void> {
  sched.flush();
  await new Promise((r) => setTimeout(r, 0));
}

describe("applySseEvent (SSE → store mapping)", () => {
  it("records step:failed into the dashboard store for the retry wiring", () => {
    const { api } = harness();
    const sched = manualScheduler();
    const dashboard = createDashboardStore({ api, schedule: sched.schedule, onError: () => {} });
    const trace = createTraceService();

    applySseEvent({ type: "step:failed", data: { executionId: "ex1", nodeId: "n2" } }, { dashboard, trace });

    expect(dashboard.getSnapshot().failedNodes).toEqual({ ex1: "n2" });
    expect(trace.getEntries().some((t) => t.kind === "sse" && t.message === "step:failed")).toBe(true);
  });

  it("ignores step:failed frames without execution/node ids", () => {
    const { api } = harness();
    const dashboard = createDashboardStore({ api, schedule: manualScheduler().schedule, onError: () => {} });
    const trace = createTraceService();

    applySseEvent({ type: "step:failed", data: {} }, { dashboard, trace });

    expect(dashboard.getSnapshot().failedNodes).toEqual({});
  });

  it("funnels execution/step events into a single executions refresh", async () => {
    const { api, calls } = harness();
    const sched = manualScheduler();
    const dashboard = createDashboardStore({ api, schedule: sched.schedule, onError: () => {} });
    const trace = createTraceService();
    const stores = { dashboard, trace };

    applySseEvent({ type: "step:failed", data: { executionId: "ex1", nodeId: "n2" } }, stores);
    applySseEvent({ type: "execution:completed", data: { executionId: "ex1" } }, stores);
    await settle(sched);

    expect(calls.executions).toBe(1);
  });

  it("routes pipeline:reloaded and models:changed to their own domains", async () => {
    const { api, calls } = harness();
    const sched = manualScheduler();
    const dashboard = createDashboardStore({ api, schedule: sched.schedule, onError: () => {} });
    const trace = createTraceService();
    const stores = { dashboard, trace };

    applySseEvent({ type: "pipeline:reloaded" }, stores);
    await settle(sched);
    expect(calls.pipelines).toBe(1);

    applySseEvent({ type: "models:changed" }, stores);
    await settle(sched);
    expect(calls.models).toBe(1);
  });
});