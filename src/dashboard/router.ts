/**
 * Dashboard REST + SSE router (Slice C — task 3.5, dashboard-api spec).
 *
 * Fetch handlers for the `/api/ui/*` surface:
 *   - GET  /api/ui/pipelines            → pipeline summaries
 *   - GET  /api/ui/models               → merged registered + detected models
 *   - GET  /api/ui/executions?limit=N   → bounded recent executions
 *   - POST /api/ui/pipelines/:id/validate → graph validation result
 *   - POST /api/ui/apply                → atomic config apply
 *   - POST /api/ui/executions/:execId/steps/:nodeId/retry → manual step retry
 *   - GET  /api/ui/events               → SSE event stream
 *
 * Every `/api/ui/*` error returns the normalized `{error:{message,type,param,
 * code}}` envelope (dashboard-api Req "Error envelope contract").
 *
 * The SSE endpoint disables the per-request idle timeout (like `/v1/*`
 * streams) via the injected server handle.
 *
 * Pure/injectable: all data sources (registry, tracker, metrics, event bus,
 * apply service, retry executor) are injected so routes are unit-testable
 * without touching disk or network.
 */
import type { GraphPipeline } from "../orchestrator/graph.js";
import type { ExecutionTracker } from "./execution-tracker.js";
import type { DashboardEventBus } from "./events.js";
import type { MetricsCollector } from "./metrics.js";
import type { ApplyService } from "./service.js";

/** A server handle the SSE route uses to disable the idle timeout. */
interface ServerHandle {
  timeout: (req: Request, ms: number) => void;
}

/** Result of a manual retry run (task 3.7). */
export interface RetryRunResult {
  ok: boolean;
  retryExecutionId?: string;
  error?: { message: string; type: string; code: string | null };
}

/** Injected dependencies for the dashboard router. */
export interface DashboardRouterDeps {
  /**
   * Resolve the ordered pipeline summaries. A function (not a static array) so
   * a runtime registry `reload()` is reflected on the next request.
   */
  chainSummaries: () => PipelineSummary[];
  /**
   * Resolve the registered (config.llama.models) model file names. A function
   * so re-applied configs update the list live.
   */
  registeredModels: () => string[];
  /** Resolve the detected (candidate-only) `.gguf` files from the watcher. */
  detectedModels: () => string[];
  /** The models directory (for the models list payload). */
  modelsDir: string;
  /** Whether the dashboard polls/refreshes models automatically. */
  autoRefresh: boolean;
  /** Execution history (task 3.1). */
  tracker: ExecutionTracker;
  /** SSE event bus (task 3.3). */
  bus: DashboardEventBus;
  /** Per-step metrics collector (task 3.2). */
  metrics: MetricsCollector;
  /** Graph validation for the validate endpoint. */
  validateGraph: (graph: GraphPipeline, opts?: { knownModels?: string[] }) => {
    ok: boolean;
    errors: string[];
  };
  /** The atomic apply service (task 3.4). */
  applyService: ApplyService;
  /** Manual step retry executor (task 3.7). Returns a verdict. */
  runRetry: (input: {
    executionId: string;
    nodeId: string;
  }) => Promise<RetryRunResult>;
  /** Resolve a node's type for a given execution (retry gating). */
  getNodeType: (executionId: string, nodeId: string) => string | undefined;
}

/** A pipeline summary for the /pipelines list. */
export interface PipelineSummary {
  id: string;
  description: string | null;
  nodeCount: number;
  lastExecution: string | null;
}

/** JSON response helper. */
function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The standard error envelope. */
function errorEnvelope(
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): Response {
  return json(
    { error: { message, type, param, code } },
    type === "invalid_request_error" ? 400 : 500,
  );
}

/** Normalized 404 for unmatched routes or missing resources. */
function notFound(message = "Not found"): Response {
  return json(
    {
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
    404,
  );
}

/** SSE headers reused by the events endpoint. */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Create the dashboard router as a fetch handler.
 *
 * The handler is invoked by the server dispatcher with the request, the
 * Bun.serve server handle, and the parsed URL. It matches `/api/ui/*` and
 * returns Responses (or a long-lived SSE stream for `/events`).
 */
export function createDashboardRouter(deps: DashboardRouterDeps) {
  return (
    req: Request,
    server: ServerHandle,
    url: URL,
  ): Promise<Response> | Response => {
    const parts = url.pathname.split("/").filter(Boolean); // e.g. api,ui,...

    // Only `/api/ui/*` routes are handled here.
    if (parts[0] !== "api" || parts[1] !== "ui") {
      return notFound();
    }

    const sub = parts.slice(2); // after api/ui

    async function handle(): Promise<Response> {
      // ── GET /api/ui/pipelines ──
      if (req.method === "GET" && sub.length === 1 && sub[0] === "pipelines") {
        return json(deps.chainSummaries());
      }

      // ── GET /api/ui/models ──
      if (req.method === "GET" && sub.length === 1 && sub[0] === "models") {
        const seen = new Set<string>();
        const models: { id: string; file: string; loaded: boolean }[] = [];
        for (const file of deps.registeredModels()) {
          models.push({ id: file, file, loaded: true });
          seen.add(file);
        }
        for (const file of deps.detectedModels()) {
          if (seen.has(file)) continue;
          models.push({ id: file, file, loaded: false });
        }
        return json({
          models,
          modelsDir: deps.modelsDir,
          autoRefresh: deps.autoRefresh,
        });
      }

      // ── GET /api/ui/executions?limit=N ──
      if (req.method === "GET" && sub.length === 1 && sub[0] === "executions") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam !== null ? Math.max(0, parseInt(limitParam, 10) || 0) : undefined;
        const list = deps.tracker.list(limit).map((e) => ({
          id: e.id,
          pipelineId: e.pipelineId,
          status: e.status,
          totalLatencyMs: e.totalLatencyMs,
        }));
        return json(list);
      }

      // ── POST /api/ui/pipelines/:id/validate ──
      if (
        req.method === "POST" &&
        sub.length === 3 &&
        sub[0] === "pipelines" &&
        sub[2] === "validate"
      ) {
        const raw = await readJson(req);
        if (!raw) {
          return errorEnvelope("Request body must be valid JSON", "invalid_request_error");
        }
        const graph = normalizeGraph(sub[1], raw);
        const result = deps.validateGraph(graph, {
          knownModels: deps.registeredModels(),
        });
        if (result.ok) return json({ valid: true });
        return json({ valid: false, errors: result.errors });
      }

      // ── POST /api/ui/apply ──
      if (req.method === "POST" && sub.length === 1 && sub[0] === "apply") {
        const raw = await readJson(req);
        if (!raw || !isRecord(raw) || !("config" in raw)) {
          return errorEnvelope(
            "Request body must be a { config: {...} } object",
            "invalid_request_error",
          );
        }
        try {
          const result = await deps.applyService.apply({ config: raw.config });
          return json(result);
        } catch (err) {
          const e = err as { message?: string; type?: string; code?: string | null };
          return errorEnvelope(
            e.message ?? "Apply failed",
            e.type ?? "server_error",
            e.code ?? null,
          );
        }
      }

      // ── POST /api/ui/executions/:execId/steps/:nodeId/retry ──
      if (
        req.method === "POST" &&
        sub.length === 5 &&
        sub[0] === "executions" &&
        sub[2] === "steps" &&
        sub[4] === "retry"
      ) {
        const execId = sub[1];
        const nodeId = sub[3];

        const execution = deps.tracker.get(execId);
        if (!execution) {
          return notFound(`Execution "${execId}" not found`);
        }

        const step = deps.tracker.getStep(execId, nodeId);
        if (!step) {
          return notFound(`Step "${nodeId}" not found on execution "${execId}"`);
        }

        // Retry gating (task 3.7): only failed `llm_call`, max 1 retry/step.
        const verdict = decideRetry({
          nodeType: deps.getNodeType(execId, nodeId),
          stepStatus: step.status,
          retryAttempts: step.retryAttempts,
        });
        if (!verdict.ok) {
          return errorEnvelope(verdict.message!, "invalid_request_error", verdict.code!);
        }

        const result = await deps.runRetry({ executionId: execId, nodeId });
        if (!result.ok) {
          return errorEnvelope(
            result.error?.message ?? "Retry failed",
            "server_error",
            result.error?.code ?? null,
          );
        }
        return json({ success: true, retryExecutionId: result.retryExecutionId });
      }

      // ── GET /api/ui/events (SSE) ──
      if (req.method === "GET" && sub.length === 1 && sub[0] === "events") {
        server.timeout(req, 0);
        return sseResponse(deps);
      }

      return notFound();
    }

    return handle();
  };
}

/** Decide whether a manual retry is permitted (pure, testable). */
export interface DecideRetryInput {
  nodeType: string | undefined;
  stepStatus: number;
  retryAttempts: number;
}

export type RetryVerdict =
  | { ok: true }
  | { ok: false; message: string; code: string };

export function decideRetry(input: DecideRetryInput): RetryVerdict {
  if (input.nodeType !== "llm_call") {
    return {
      ok: false,
      message: `Step is not a retryable llm_call (type: ${input.nodeType ?? "unknown"})`,
      code: "not_llm_call",
    };
  }
  if (input.stepStatus === 200) {
    return { ok: false, message: "Step did not fail; nothing to retry", code: "not_failed" };
  }
  if (input.retryAttempts >= 1) {
    return { ok: false, message: "Step has already been retried (max 1 retry)", code: "already_retried" };
  }
  return { ok: true };
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Read and parse a JSON request body, returning undefined on parse error. */
async function readJson(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    if (!text) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize a validate draft (`steps` linear or `nodes`/`edges` graph). */
function normalizeGraph(id: string, raw: unknown): GraphPipeline {
  if (isRecord(raw) && "nodes" in raw && isRecord((raw as Record<string, unknown>).nodes)) {
    return {
      id,
      name: id,
      nodes: (raw as Record<string, unknown>).nodes as GraphPipeline["nodes"],
      edges: ((raw as Record<string, unknown>).edges ?? []) as GraphPipeline["edges"],
    };
  }
  // Fall back to an empty/stub graph — a missing-structure draft is invalid.
  return { id, nodes: [], edges: [] };
}

/** Build the SSE Response wiring bus events to a stream with keepalive. */
function sseResponse(deps: DashboardRouterDeps): Response {
  const enc = new TextEncoder();

  // Drain the buffered events first, then keep the stream open for live
  // events + periodic heartbeat comments to keep the connection alive.
  const replay = deps.bus.drainBuffer();
  const initialFrames = replay.map((ev) => enc.encode(deps.bus.formatSSE(ev)));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of initialFrames) controller.enqueue(frame);

      const unsubscribe = deps.bus.subscribe({
        onEvent: (ev) => {
          try {
            controller.enqueue(enc.encode(deps.bus.formatSSE(ev)));
          } catch {
            // Client went away — the unsubscribe below handles cleanup.
            unsubscribe();
          }
        },
        onSlow: () => {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
          unsubscribe();
        },
      });

      // Heartbeat comment every 15s keeps the connection alive through proxies.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": keepalive\n\n"));
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 15000);
    },
    cancel() {
      // Stream teardown — nothing persistent to release beyond the subscribers
      // which unsubscribe on error/close.
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
