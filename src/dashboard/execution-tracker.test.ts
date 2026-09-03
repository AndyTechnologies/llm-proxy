import { describe, it, expect } from "bun:test";
import { createExecutionTracker } from "./execution-tracker.js";
import type { ExecutionStatus } from "./execution-tracker.js";

describe("execution-tracker", () => {
  it("records an execution and retrieves it", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    tracker.recordComplete(id);

    const list = tracker.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].pipelineId).toBe("pipeline-1");
    expect(list[0].status).toBe("completed");
    expect(list[0].totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns execution not found for unknown id", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const exec = tracker.get("nonexistent");
    expect(exec).toBeUndefined();
  });

  it("records failure status", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    tracker.recordFailed(id);

    const exec = tracker.get(id);
    expect(exec).toBeDefined();
    expect(exec!.status).toBe("failed");
  });

  it("records retrying status", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    tracker.recordRetrying(id);

    const exec = tracker.get(id);
    expect(exec!.status).toBe("retrying");
  });

  it("records step results", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    tracker.recordStep(id, { nodeId: "n1", status: 200, latencyMs: 42, content: "ok" });

    const exec = tracker.get(id);
    expect(exec).toBeDefined();
    expect(exec!.steps).toHaveLength(1);
    expect(exec!.steps[0].nodeId).toBe("n1");
    expect(exec!.steps[0].status).toBe(200);
    expect(exec!.steps[0].latencyMs).toBe(42);
  });

  it("enforces N=100 bound — oldest evicted first", () => {
    const tracker = createExecutionTracker({ maxHistory: 5 });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(tracker.recordStart(`pipeline-${i}`));
      tracker.recordComplete(ids[i]);
    }

    const list = tracker.list();
    expect(list).toHaveLength(5);
    // Newest first: pipeline-9 is the most recent, pipeline-5 the oldest kept.
    expect(list[0].pipelineId).toBe("pipeline-9");
    expect(list[4].pipelineId).toBe("pipeline-5");
    // Evicted IDs should be gone.
    expect(tracker.get(ids[0])).toBeUndefined();
    expect(tracker.get(ids[4])).toBeUndefined();
    // Kept IDs should still exist.
    expect(tracker.get(ids[5])).toBeDefined();
    expect(tracker.get(ids[9])).toBeDefined();
  });

  it("list supports limit parameter", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    for (let i = 0; i < 15; i++) {
      const id = tracker.recordStart(`pipeline-${i}`);
      tracker.recordComplete(id);
    }

    const list = tracker.list(10);
    expect(list).toHaveLength(10);
    // Most recent first
    expect(list[0].pipelineId).toBe("pipeline-14");
  });

  it("list returns most recent first", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id1 = tracker.recordStart("first");
    const id2 = tracker.recordStart("second");
    tracker.recordComplete(id1);
    tracker.recordComplete(id2);

    const list = tracker.list();
    expect(list[0].id).toBe(id2);
    expect(list[1].id).toBe(id1);
  });

  it("getStep returns a specific step by nodeId", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    tracker.recordStep(id, { nodeId: "n1", status: 200, latencyMs: 10, content: "a" });
    tracker.recordStep(id, { nodeId: "n2", status: 500, latencyMs: 20, content: "b" });

    const step = tracker.getStep(id, "n2");
    expect(step).toBeDefined();
    expect(step!.nodeId).toBe("n2");
    expect(step!.status).toBe(500);
  });

  it("getStep returns undefined for unknown step", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    expect(tracker.getStep(id, "unknown")).toBeUndefined();
  });

  it("retryAttempt returns 0 for no retries", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    tracker.recordStep(id, { nodeId: "n1", status: 500, latencyMs: 10, content: "fail" });
    tracker.recordFailed(id);

    expect(tracker.retryAttempt(id, "n1")).toBe(0);
  });

  it("retryAttempt increments after retry", () => {
    const tracker = createExecutionTracker({ maxHistory: 100 });
    const id = tracker.recordStart("pipeline-1");
    tracker.recordStep(id, { nodeId: "n1", status: 500, latencyMs: 10, content: "fail" });
    tracker.recordFailed(id);
    tracker.recordRetry(id, "n1");

    expect(tracker.retryAttempt(id, "n1")).toBe(1);
  });
});
