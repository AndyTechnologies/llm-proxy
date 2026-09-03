/**
 * Per-step execution metrics (Slice C — task 3.2).
 *
 * Aggregate counters per step node: count, successes (HTTP 200), failures,
 * and latency aggregates. Fed by the engine/events during execution and
 * exported via a snapshot for the dashboard.
 *
 * Pure/injectable: no global state; `recordStep` mutates an internal map and
 * `snapshot` returns a deep copy of the current aggregates.
 */

/** Result of a recorded step (fed by the graph/linear engine). */
export interface StepMetricInput {
  nodeId: string;
  status: number;
  latencyMs: number;
  contentLength?: number;
}

/** Aggregated metrics for a single step node. */
export interface StepMetrics {
  count: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  totalLatencyMs: number;
  latestContentLength: number;
}

/** The metrics collector surface. */
export interface MetricsCollector {
  /** Record one completed step observation. */
  recordStep(nodeId: string, status: number, latencyMs: number, contentLength?: number): void;
  /** Snapshot of all current step aggregates (deep copy). */
  snapshot(): Record<string, StepMetrics>;
  /** Hard reset of all collected metrics. */
  reset(): void;
}

/** Create a per-step metrics collector. */
export function createMetricsCollector(): MetricsCollector {
  const steps = new Map<string, StepMetrics>();

  return {
    recordStep(nodeId, status, latencyMs, contentLength) {
      const cur = steps.get(nodeId) ?? {
        count: 0,
        successes: 0,
        failures: 0,
        avgLatencyMs: 0,
        totalLatencyMs: 0,
        latestContentLength: 0,
      };
      cur.count += 1;
      cur.totalLatencyMs += latencyMs;
      cur.avgLatencyMs = cur.totalLatencyMs / cur.count;
      if (status === 200) {
        cur.successes += 1;
      } else {
        cur.failures += 1;
      }
      if (contentLength !== undefined) {
        cur.latestContentLength = contentLength;
      }
      steps.set(nodeId, cur);
    },
    snapshot() {
      const out: Record<string, StepMetrics> = {};
      for (const [nodeId, m] of steps) {
        out[nodeId] = {
          count: m.count,
          successes: m.successes,
          failures: m.failures,
          avgLatencyMs: m.avgLatencyMs,
          totalLatencyMs: m.totalLatencyMs,
          latestContentLength: m.latestContentLength,
        };
      }
      return out;
    },
    reset() {
      steps.clear();
    },
  };
}
