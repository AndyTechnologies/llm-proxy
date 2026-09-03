import { describe, it, expect } from "bun:test";
import { runStepRetry } from "./retry.js";
import type { RetryRunnerDeps } from "./retry.js";
import { createExecutionTracker } from "./execution-tracker.js";

function makeDeps(overrides: Partial<RetryRunnerDeps> = {}): RetryRunnerDeps {
  const tracker = createExecutionTracker();
  return {
    tracker,
    provider: {
      chat: async () => {
        return { content: "retried ok", status: 200 };
      },
    },
    getNodeType: (_execId, nodeId) => (nodeId === "cond-1" ? "condition" : "llm_call"),
    requestPayload: () => ({ model: "m1", stream: false }),
    model: "m1",
    executionId: "exec-1",
    nodeId: "llm-1",
    pipelineId: "p1",
    ...overrides,
  };
}

describe("runStepRetry", () => {
  it("runs a non-streaming llm_call retry and stores the result (ok)", async () => {
    const deps = makeDeps();
    // Seed a failed execution + step to retry.
    const id = deps.tracker.recordStart("p1");
    deps.tracker.recordStep(id, { nodeId: "llm-1", status: 500, latencyMs: 5 });
    deps.tracker.recordFailed(id);
    const runnerDeps = { ...deps, executionId: id };

    const result = await runStepRetry(runnerDeps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.retryExecutionId).toBeTruthy();

    // The step's retry counter incremented and the result was stored.
    expect(deps.tracker.retryAttempt(id, "llm-1")).toBe(1);
    const step = deps.tracker.getStep(id, "llm-1");
    expect(step).toBeDefined();
    expect(step!.content).toBe("retried ok");
  });

  it("refuses retry when already retried (max 1/step)", async () => {
    const deps = makeDeps();
    const id = deps.tracker.recordStart("p1");
    deps.tracker.recordStep(id, { nodeId: "llm-1", status: 500, latencyMs: 5 });
    deps.tracker.recordFailed(id);
    deps.tracker.recordRetry(id, "llm-1"); // already retried once

    const result = await runStepRetry({ ...deps, executionId: id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error?.code).toBe("already_retried");
  });

  it("refuses retry of a non-llm_call step", async () => {
    const deps = makeDeps();
    const id = deps.tracker.recordStart("p1");
    deps.tracker.recordStep(id, { nodeId: "cond-1", status: 500, latencyMs: 5 });
    deps.tracker.recordFailed(id);

    const result = await runStepRetry({ ...deps, executionId: id, nodeId: "cond-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error?.code).toBe("not_llm_call");
  });

  it("refuses retry of a successful step", async () => {
    const deps = makeDeps();
    const id = deps.tracker.recordStart("p1");
    deps.tracker.recordStep(id, { nodeId: "llm-1", status: 200, latencyMs: 5 });

    const result = await runStepRetry({ ...deps, executionId: id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error?.code).toBe("not_failed");
  });
});
