import { describe, it, expect } from "bun:test";
import { createMetricsCollector } from "./metrics.js";

describe("metrics", () => {
  it("collects per-step aggregates with count and avg latency", () => {
    const metrics = createMetricsCollector();
    metrics.recordStep("n1", 100, 200); // status 100, latency 200ms
    metrics.recordStep("n1", 200, 400);
    metrics.recordStep("n2", 200, 50);

    const result = metrics.snapshot();
    const n1 = result["n1"];
    const n2 = result["n2"];

    expect(n1).toBeDefined();
    expect(n1.count).toBe(2);
    expect(n1.successes).toBe(1); // only status 200
    expect(n1.failures).toBe(1); // status 100
    expect(n1.avgLatencyMs).toBe(300); // (200 + 400) / 2
    expect(n1.totalLatencyMs).toBe(600);

    expect(n2).toBeDefined();
    expect(n2.count).toBe(1);
    expect(n2.successes).toBe(1);
    expect(n2.failures).toBe(0);
    expect(n2.avgLatencyMs).toBe(50);
  });

  it("returns empty snapshot when nothing recorded", () => {
    const metrics = createMetricsCollector();
    const result = metrics.snapshot();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("tracks latest content length", () => {
    const metrics = createMetricsCollector();
    metrics.recordStep("n1", 200, 10, 500);
    metrics.recordStep("n1", 200, 20, 900);

    const n1 = metrics.snapshot()["n1"];
    expect(n1).toBeDefined();
    expect(n1.latestContentLength).toBe(900);
  });

  it("reset clears all metrics", () => {
    const metrics = createMetricsCollector();
    metrics.recordStep("n1", 200, 10);
    metrics.recordStep("n2", 500, 30);
    metrics.reset();

    expect(Object.keys(metrics.snapshot())).toHaveLength(0);
  });
});
