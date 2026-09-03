/**
 * Execution tracker (Slice C — task 3.1, dashboard-api Req "Execution list
 * endpoint").
 *
 * Bounded in-memory history of pipeline executions, N=100 by default. The
 * tracker records execution lifecycle (started → completed/failed/retrying),
 * per-step results (status, latency, content), and retry attempts. It feeds
 * the `/api/ui/executions` endpoint and the SSE events bus.
 *
 * Pure/injectable: no global state; the max-history bound is configurable so
 * tests can use a small bound to exercise eviction cheaply.
 */

/** Lifecycle status of an execution. */
export type ExecutionStatus = "running" | "completed" | "failed" | "retrying";

/** A recorded step result within an execution. */
export interface ExecutionStep {
  nodeId: string;
  status: number;
  latencyMs: number;
  content: string;
  /** Number of retries performed for this step (max 1 per spec). */
  retryAttempts: number;
}

/** A single recorded execution entry. */
export interface ExecutionEntry {
  id: string;
  pipelineId: string;
  status: ExecutionStatus;
  startedAt: number;
  completedAt: number | null;
  totalLatencyMs: number;
  steps: ExecutionStep[];
}

/** Input for recording a step result. */
export interface RecordStepInput {
  nodeId: string;
  status: number;
  latencyMs: number;
  content?: string;
}

/** Options for creating an execution tracker. */
export interface ExecutionTrackerOptions {
  /** Max executions kept in history (default 100 per spec). */
  maxHistory?: number;
}

/** The execution tracker surface. */
export interface ExecutionTracker {
  /** Begin tracking a new execution; returns its id. */
  recordStart(pipelineId: string): string;
  /** Mark an execution as completed (terminal). */
  recordComplete(id: string): void;
  /** Mark an execution as failed (terminal). */
  recordFailed(id: string): void;
  /** Mark an execution as retrying (non-terminal). */
  recordRetrying(id: string): void;
  /** Record a step result for an execution. */
  recordStep(id: string, input: RecordStepInput): void;
  /** Increment the retry counter for a step and set status retrying. */
  recordRetry(id: string, nodeId: string): void;
  /** List executions, most recent first, bounded by `limit`. */
  list(limit?: number): ExecutionEntry[];
  /** Get a single execution by id. */
  get(id: string): ExecutionEntry | undefined;
  /** Get a single recorded step by execution id + nodeId. */
  getStep(executionId: string, nodeId: string): ExecutionStep | undefined;
  /** Number of retries performed for a step. */
  retryAttempt(executionId: string, nodeId: string): number;
}

/** Create an execution tracker with bounded history. */
export function createExecutionTracker(
  options: ExecutionTrackerOptions = {},
): ExecutionTracker {
  const maxHistory = options.maxHistory ?? 100;

  // Newest first.
  let history: ExecutionEntry[] = [];

  function now(): number {
    return Date.now();
  }

  function upsert(id: string, mut: (entry: ExecutionEntry) => void): void {
    const entry = history.find((e) => e.id === id);
    if (!entry) return;
    mut(entry);
  }

  function pushBound(entry: ExecutionEntry): void {
    history = [entry, ...history].slice(0, maxHistory);
  }

  function finalize(id: string, status: "completed" | "failed"): void {
    upsert(id, (e) => {
      e.status = status;
      e.completedAt = now();
      e.totalLatencyMs = Math.max(0, e.completedAt - e.startedAt);
    });
  }

  function findStep(entry: ExecutionEntry, nodeId: string): ExecutionStep | undefined {
    return entry.steps.find((s) => s.nodeId === nodeId);
  }

  return {
    recordStart(pipelineId) {
      const id = `exec-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      pushBound({
        id,
        pipelineId,
        status: "running",
        startedAt: now(),
        completedAt: null,
        totalLatencyMs: 0,
        steps: [],
      });
      return id;
    },
    recordComplete(id) {
      finalize(id, "completed");
    },
    recordFailed(id) {
      finalize(id, "failed");
    },
    recordRetrying(id) {
      upsert(id, (e) => {
        e.status = "retrying";
      });
    },
    recordStep(id, input) {
      upsert(id, (entry) => {
        const existing = findStep(entry, input.nodeId);
        // Preserve the retry count if a prior attempt exists, else start at 0.
        const retryAttempts = existing?.retryAttempts ?? 0;
        if (existing) {
          existing.status = input.status;
          existing.latencyMs = input.latencyMs;
          existing.content = input.content ?? "";
        } else {
          entry.steps.push({
            nodeId: input.nodeId,
            status: input.status,
            latencyMs: input.latencyMs,
            content: input.content ?? "",
            retryAttempts,
          });
        }
      });
    },
    recordRetry(id, nodeId) {
      upsert(id, (entry) => {
        const step = findStep(entry, nodeId);
        if (step) step.retryAttempts += 1;
      });
    },
    list(limit) {
      if (limit !== undefined && limit >= 0) {
        return history.slice(0, limit);
      }
      return [...history];
    },
    get(id) {
      return history.find((e) => e.id === id);
    },
    getStep(executionId, nodeId) {
      const entry = history.find((e) => e.id === executionId);
      if (!entry) return undefined;
      return findStep(entry, nodeId);
    },
    retryAttempt(executionId, nodeId) {
      const step = this.getStep(executionId, nodeId);
      return step?.retryAttempts ?? 0;
    },  };
}
