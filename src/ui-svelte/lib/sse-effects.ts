/**
 * SSE → store mapping (svelte-ui verify scenarios 9 and 11).
 *
 * The single mapping shared by the browser wiring (App's makeSse) and the
 * test harness (fakes' makeSse), so they can never drift: every dashboard
 * event funnels into the batched store refresh, and `step:failed`
 * additionally feeds the retry wiring — the dashboard store records the
 * failed step's node per execution, which is the ONLY presentation-safe
 * source for the failed-row retry control (the executions list API does not
 * expose steps).
 *
 * Framework-free: no svelte imports (lint + purity.test.ts guard).
 */
import type { AppStores } from "../app-types.js";
import type { SSEEventName } from "../stores/types.js";

/** One parsed SSE frame from the service. */
export interface SseEventFrame {
  type: SSEEventName;
  data?: unknown;
}

/** Map an SSE frame onto the store layer. */
export function applySseEvent(
  frame: SseEventFrame,
  stores: Pick<AppStores, "dashboard" | "trace">,
): void {
  stores.trace.log("sse", frame.type);
  const data = frame.data as { executionId?: string; nodeId?: string } | null | undefined;
  if (frame.type === "step:failed" && data?.executionId && data?.nodeId) {
    stores.dashboard.actions.recordStepFailed(data.executionId, data.nodeId);
  }
  if (frame.type === "pipeline:reloaded") stores.dashboard.actions.scheduleRefresh("pipelines");
  else if (frame.type === "models:changed") stores.dashboard.actions.scheduleRefresh("models");
  else stores.dashboard.actions.scheduleRefresh("executions");
}