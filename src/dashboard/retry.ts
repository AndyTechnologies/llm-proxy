/**
 * Manual step retry executor (Slice C — task 3.7, dashboard-api Req "Step
 * retry endpoint").
 *
 * Retries a failed `llm_call` step manually:
 *   - Only failed `llm_call` steps are retryable (RED: non-llm_call refused).
 *   - Max 1 retry per step (RED: already-retried refused).
 *   - The retry runs NON-streaming and the result is stored back into the
 *     execution tracker (content + retry counter + updated status).
 *
 * The provider call is injected so the runner is unit-testable without a real
 * backend. `decideRetry` (in router.ts) is reused as the single gating source
 * so the router path and this runner share identical retry rules.
 */
import { decideRetry } from "./router.js";
import type { ExecutionTracker } from "./execution-tracker.js";

/** A minimal provider abstraction for the non-streaming retry call. */
export interface RetryProvider {
  chat(payload: Record<string, unknown>, model?: string): Promise<Record<string, unknown>>;
}

/** Injected dependencies for the retry runner. */
export interface RetryRunnerDeps {
  /** Execution history used to gate + store the retry. */
  tracker: ExecutionTracker;
  /** Provider used to re-run the failed llm_call (non-streaming). */
  provider: RetryProvider;
  /** Resolve a node's type to gate non-llm_call steps. */
  getNodeType: (executionId: string, nodeId: string) => string | undefined;
  /** Build the non-streaming payload for the llm_call retry. */
  requestPayload: (nodeId: string) => Record<string, unknown>;
  /** The model id to pass to the provider. */
  model: string;
  /** The execution id being retried. */
  executionId: string;
  /** The step (node) id being retried. */
  nodeId: string;
  /** The pipeline/chain id, used for a new tracking record. */
  pipelineId: string;
}

/** Result of a retry run (matches the router's `RetryRunResult`). */
export interface RetryResult {
  ok: boolean;
  retryExecutionId?: string;
  error?: { message: string; type: string; code: string | null };
}

/** Run a manual step retry with the injected deps. */
export async function runStepRetry(deps: RetryRunnerDeps): Promise<RetryResult> {
  const step = deps.tracker.getStep(deps.executionId, deps.nodeId);
  const nodeType = deps.getNodeType(deps.executionId, deps.nodeId);
  const stepStatus = step?.status ?? 500;

  // Gate with the same rules as the router: failed llm_call, max 1 retry.
  const verdict = decideRetry({
    nodeType,
    stepStatus,
    retryAttempts: step?.retryAttempts ?? 0,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      error: {
        message: verdict.message,
        type: "invalid_request_error",
        code: verdict.code,
      },
    };
  }

  // Non-streaming retry: build the payload, run the provider, store the result.
  const payload = { ...deps.requestPayload(deps.nodeId), stream: false };
  const start = Date.now();
  try {
    const result = await deps.provider.chat(payload, deps.model);
    const latencyMs = Date.now() - start;
    const content = extractContent(result);
    const status = typeof result.status === "number" ? result.status : 200;

    deps.tracker.recordRetry(deps.executionId, deps.nodeId);
    deps.tracker.recordStep(deps.executionId, {
      nodeId: deps.nodeId,
      status,
      latencyMs,
      content,
    });

    // Open a fresh tracking record representing the retry execution.
    const retryExecutionId = deps.tracker.recordStart(deps.pipelineId);
    deps.tracker.recordComplete(retryExecutionId);

    return { ok: true, retryExecutionId };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : "Retry failed",
        type: "server_error",
        code: null,
      },
    };
  }
}

/** Extract the text content from a provider result (mirrors engine util). */
function extractContent(result: Record<string, unknown>): string {
  const c = result.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          return typeof p.text === "string" ? p.text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}
