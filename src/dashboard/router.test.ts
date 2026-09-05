import { describe, it, expect } from "bun:test";
import { createDashboardRouter, decideRetry } from "./router.js";
import type { DashboardRouterDeps } from "./router.js";
import { createExecutionTracker } from "./execution-tracker.js";
import { createEventBus } from "./events.js";
import { createMetricsCollector } from "./metrics.js";
import { createApplyService } from "./service.js";
import { validateGraph } from "../orchestrator/graph.js";

function makeDeps(overrides: Partial<DashboardRouterDeps> = {}): DashboardRouterDeps {
  const tracker = createExecutionTracker({ maxHistory: 100 });
  const bus = createEventBus({ bufferSize: 16 });
  const metrics = createMetricsCollector();
  const applyService = createApplyService({
    configPath: "/tmp/llm-proxy.config.yaml",
    persist: async () => "yaml",
    reload: () => {},
    getCurrentChains: () => ["c1"],
  });
  return {
    chainSummaries: () => [
      { id: "c1", description: "chain one", nodeCount: 3, lastExecution: "2026-09-01T00:00:00Z" },
      { id: "c2", description: "chain two", nodeCount: 5, lastExecution: null },
    ],
    getPipeline: (id) =>
      id === "c1"
        ? {
            id: "c1",
            name: "c1",
            nodes: [
              { id: "a", type: "start" },
              { id: "b", type: "llm_call", model: "m1.gguf" },
              { id: "d", type: "end" },
            ],
            edges: [
              { from: "a", to: "b" },
              { from: "b", to: "d" },
            ],
          }
        : undefined,
    registeredModels: () => ["m1.gguf", "m2.gguf"],
    modelDetails: () => [
      { id: "m1.gguf", file: "m1.gguf", ctx: 4096, temp: 0.1, ggufContextLength: 8192, hardwareMaxCtx: 16384, effectiveCtx: 4096 },
      { id: "m2.gguf", file: "m2.gguf", ctx: 8192, temp: 0.7, ggufContextLength: null, hardwareMaxCtx: 16384, effectiveCtx: 8192 },
    ],
    detectedModels: () => ["m3.gguf"],
    fileModelDetails: (fileName) =>
      fileName === "m3.gguf"
        ? { ggufContextLength: 65536, hardwareMaxCtx: 32768, effectiveCtx: 32768 }
        : undefined,
    modelsDir: "/models",
    autoRefresh: true,
    tracker,
    bus,
    metrics,
    validateGraph: () => ({ ok: true, errors: [] }),
    applyService,
    runRetry: async () => ({ ok: true, retryExecutionId: "exec-retry-1" }),
    getNodeType: () => undefined,
    ...overrides,
  };
}

function call(
  deps: DashboardRouterDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const handler = createDashboardRouter(deps);
  const url = new URL(path, "http://localhost");
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const req = new Request(url.toString(), opts);
  const server = { timeout: (_req: Request, _ms: number) => {} } as unknown as {
    timeout: (req: Request, ms: number) => void;
  };
  return Promise.resolve(handler(req, server, url));
}

/** Typed body read for tests (bun types `res.json()` as unknown). */
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface PipelineSummary {
  id: string;
  description: string | null;
  nodeCount: number;
  lastExecution: string | null;
}

interface ModelSummary {
  id: string;
  file: string;
  loaded: boolean;
  /** F2: a live worker process was observed for this model. */
  processLoaded: boolean;
  /** F2: ISO timestamp of the last tracked activity, or null. */
  lastUsed: string | null;
  ctx?: number;
  temp?: number;
  ggufContextLength: number | null;
  hardwareMaxCtx?: number;
  effectiveCtx?: number;
}

interface ModelListPayload {
  models: ModelSummary[];
  modelsDir: string;
  autoRefresh: boolean;
  /** F2: lifecycle state block (null when the controller is absent). */
  lifecycle: unknown;
}

interface ExecutionListItem {
  id: string;
  pipelineId: string;
  status: string;
  totalLatencyMs: number;
}

interface ErrorEnvelope {
  error: { message: string; type: string; code: string | null; param: string | null };
}

interface ApplyPayload {
  status: string;
  reloadedChains: string[];
}

describe("dashboard router", () => {
  it("GET /api/ui/pipelines returns pipeline summaries", async () => {
    const res = await call(makeDeps(), "GET", "/api/ui/pipelines");
    expect(res.status).toBe(200);
    const data = await jsonBody<PipelineSummary[]>(res);
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      id: "c1",
      description: "chain one",
      nodeCount: 3,
      lastExecution: "2026-09-01T00:00:00Z",
    });
    expect(data[1]).toEqual({
      id: "c2",
      description: "chain two",
      nodeCount: 5,
      lastExecution: null,
    });
  });

  it("GET /api/ui/pipelines/:id returns the full graph for an existing pipeline", async () => {
    const res = await call(makeDeps(), "GET", "/api/ui/pipelines/c1");
    expect(res.status).toBe(200);
    const data = await jsonBody<{ id: string; name: string | null; nodes: unknown[]; edges: unknown[] }>(res);
    expect(data.id).toBe("c1");
    expect(data.nodes).toHaveLength(3);
    expect(data.nodes[1]).toEqual({ id: "b", type: "llm_call", model: "m1.gguf" });
    expect(data.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "d" },
    ]);
  });

  it("GET /api/ui/pipelines/:id returns 404 for an unknown pipeline", async () => {
    const res = await call(makeDeps(), "GET", "/api/ui/pipelines/nope");
    expect(res.status).toBe(404);
  });

  it("GET /api/ui/models returns merged registered + detected models", async () => {
    const res = await call(makeDeps(), "GET", "/api/ui/models");
    expect(res.status).toBe(200);
    const data = await jsonBody<ModelListPayload>(res);
    expect(data.modelsDir).toBe("/models");
    expect(data.autoRefresh).toBe(true);
    expect(data.models).toHaveLength(3);
    expect(data.models[0]).toEqual({ id: "m1.gguf", file: "m1.gguf", loaded: true, processLoaded: false, lastUsed: null, ctx: 4096, temp: 0.1, ggufContextLength: 8192, hardwareMaxCtx: 16384, effectiveCtx: 4096 });
    expect(data.models[1]).toEqual({ id: "m2.gguf", file: "m2.gguf", loaded: true, processLoaded: false, lastUsed: null, ctx: 8192, temp: 0.7, ggufContextLength: null, hardwareMaxCtx: 16384, effectiveCtx: 8192 });
    // Detected model carries its REAL parsed metadata (GGUF native window +
    // hardware ceiling from the per-file resolver).
    expect(data.models[2]).toEqual({ id: "m3.gguf", file: "m3.gguf", loaded: false, processLoaded: false, lastUsed: null, ggufContextLength: 65536, hardwareMaxCtx: 32768, effectiveCtx: 32768 });
  });

  it("GET /api/ui/models dedupes a registered model against its detected file", async () => {
    // Registered key is a short id, but the physical file is what the watcher
    // reports — the same model must appear once, as the loaded entry.
    const deps = makeDeps({
      registeredModels: () => ["short-id"],
      modelDetails: () => [
        { id: "short-id", file: "SmolLM3-3B-Q4_K_M.gguf", ctx: 4096, temp: 0.1, ggufContextLength: 8192, hardwareMaxCtx: 16384, effectiveCtx: 4096 },
      ],
      detectedModels: () => ["SmolLM3-3B-Q4_K_M.gguf", "other-model.gguf"],
    });
    const res = await call(deps, "GET", "/api/ui/models");
    expect(res.status).toBe(200);
    const data = await jsonBody<ModelListPayload>(res);
    expect(data.models).toHaveLength(2);
    expect(data.models[0]).toEqual({
      id: "short-id",
      file: "SmolLM3-3B-Q4_K_M.gguf",
      loaded: true,
      processLoaded: false,
      lastUsed: null,
      ctx: 4096,
      temp: 0.1,
      ggufContextLength: 8192,
      hardwareMaxCtx: 16384,
      effectiveCtx: 4096,
    });
    // Detected model without parsed metadata yet → no fabricated ceiling.
    expect(data.models[1]).toEqual({ id: "other-model.gguf", file: "other-model.gguf", loaded: false, processLoaded: false, lastUsed: null, ggufContextLength: null });
  });

  it("GET /api/ui/executions returns bounded recent executions", async () => {
    const deps = makeDeps();
    const id1 = deps.tracker.recordStart("c1");
    const id2 = deps.tracker.recordStart("c2");
    deps.tracker.recordComplete(id1);
    deps.tracker.recordComplete(id2);

    const res = await call(deps, "GET", "/api/ui/executions?limit=1");
    expect(res.status).toBe(200);
    const data = await jsonBody<ExecutionListItem[]>(res);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(id2);
    expect(data[0].pipelineId).toBe("c2");
    expect(data[0].status).toBe("completed");
    expect(typeof data[0].totalLatencyMs).toBe("number");
  });

  it("POST /api/ui/pipelines/g-1/validate returns valid for a valid graph", async () => {
    const deps = makeDeps({
      validateGraph: () => ({ ok: true, errors: [] }),
    });
    const res = await call(deps, "POST", "/api/ui/pipelines/g-1/validate", {
      nodes: [{ id: "s", type: "start" }],
      edges: [],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  it("POST /api/ui/pipelines/g-1/validate returns invalid with errors", async () => {
    const deps = makeDeps({
      validateGraph: () => ({ ok: false, errors: ["missing start"] }),
    });
    const res = await call(deps, "POST", "/api/ui/pipelines/g-1/validate", {
      nodes: [],
      edges: [],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false, errors: ["missing start"] });
  });

  it("POST validate accepts an array payload and validates it with the real validator", async () => {
    // Regression: normalizeGraph previously rejected ARRAY `nodes` (isRecord
    // returns false for arrays), so every draft collapsed to an empty graph and
    // even valid pipelines reported "exactly one start node (found 0)".
    const deps = makeDeps({ validateGraph });
    const res = await call(deps, "POST", "/api/ui/pipelines/g-1/validate", {
      nodes: [
        { id: "s", type: "start" },
        { id: "b", type: "llm_call", model: "m1.gguf" },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "b" },
        { from: "b", to: "e" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  it("POST /api/ui/apply returns applied with reloaded chains", async () => {
    const res = await call(makeDeps(), "POST", "/api/ui/apply", {
      config: {
        chains: {
          c1: {
            nodes: [
              { id: "start", type: "start" },
              { id: "a", type: "llm_call", model: "m", mode: "generate" },
              { id: "end", type: "end" },
            ],
            edges: [
              { from: "start", to: "a" },
              { from: "a", to: "end" },
            ],
          },
        },
      },
    });
    expect(res.status).toBe(200);
    const data = await jsonBody<ApplyPayload>(res);
    expect(data.status).toBe("applied");
    expect(data.reloadedChains).toEqual(["c1"]);
  });

  it("unknown route returns normalized error envelope", async () => {
    const res = await call(makeDeps(), "GET", "/api/ui/nope");
    expect(res.status).toBe(404);
    const data = await jsonBody<ErrorEnvelope>(res);
    expect(data.error).toBeDefined();
    expect(data.error.type).toBe("invalid_request_error");
    expect(data.error.message).toBeTruthy();
  });

  it("POST retry on a non-llm_call step returns error envelope (RED)", async () => {
    const deps = makeDeps({
      getNodeType: (_execId, nodeId) => (nodeId === "cond-1" ? "condition" : "llm_call"),
    });
    // Record an execution with a non-llm_call failed step.
    const id = deps.tracker.recordStart("c1");
    deps.tracker.recordStep(id, { nodeId: "cond-1", status: 500, latencyMs: 5 });
    deps.tracker.recordFailed(id);

    const res = await call(
      deps,
      "POST",
      `/api/ui/executions/${id}/steps/cond-1/retry`,
    );
    expect(res.status).toBe(400);
    const data = await jsonBody<ErrorEnvelope>(res);
    expect(data.error).toBeDefined();
    expect(data.error.type).toBe("invalid_request_error");
  });

  it("POST retry on an already-retried step returns error envelope (RED)", async () => {
    const deps = makeDeps({
      getNodeType: () => "llm_call",
    });
    const id = deps.tracker.recordStart("c1");
    deps.tracker.recordStep(id, { nodeId: "llm-1", status: 500, latencyMs: 5 });
    deps.tracker.recordFailed(id);
    deps.tracker.recordRetry(id, "llm-1"); // already retried once

    const res = await call(
      deps,
      "POST",
      `/api/ui/executions/${id}/steps/llm-1/retry`,
    );
    expect(res.status).toBe(400);
    const data = await jsonBody<ErrorEnvelope>(res);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe("already_retried");
  });

  it("POST retry on a failed llm_call runs retry and returns success", async () => {
    let ran = false;
    const deps = makeDeps({
      runRetry: async () => {
        ran = true;
        return { ok: true, retryExecutionId: "exec-retry-1" };
      },
      getNodeType: () => "llm_call",
    });
    const id = deps.tracker.recordStart("c1");
    deps.tracker.recordStep(id, { nodeId: "llm-1", status: 500, latencyMs: 5 });
    deps.tracker.recordFailed(id);

    const res = await call(
      deps,
      "POST",
      `/api/ui/executions/${id}/steps/llm-1/retry`,
    );
    expect(res.status).toBe(200);
    const data = await jsonBody<{ success: boolean; retryExecutionId: string }>(res);
    expect(data).toEqual({ success: true, retryExecutionId: "exec-retry-1" });
    expect(ran).toBe(true);
  });

  it("POST retry on an unknown execution returns 404 envelope", async () => {
    const deps = makeDeps({ getNodeType: () => "llm_call" });
    const res = await call(deps, "POST", "/api/ui/executions/nope/steps/x/retry");
    expect(res.status).toBe(404);
    const data = await jsonBody<ErrorEnvelope>(res);
    expect(data.error).toBeDefined();
  });

  it("GET /api/ui/events returns an SSE response with periodic keepalive", async () => {
    const deps = makeDeps();
    const res = await call(deps, "GET", "/api/ui/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  describe("decideRetry (pure retry gating)", () => {
    it("allows retry on failed llm_call with zero attempts", () => {
      const v = decideRetry({ nodeType: "llm_call", stepStatus: 500, retryAttempts: 0 });
      expect(v).toEqual({ ok: true });
    });

    it("refuses non-llm_call step", () => {
      const v = decideRetry({ nodeType: "condition", stepStatus: 500, retryAttempts: 0 });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("not_llm_call");
    });

    it("refuses already-retried step (attempt >= 1)", () => {
      const v = decideRetry({ nodeType: "llm_call", stepStatus: 500, retryAttempts: 1 });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("already_retried");
    });

    it("refuses a successful (non-failed) step", () => {
      const v = decideRetry({ nodeType: "llm_call", stepStatus: 200, retryAttempts: 0 });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("not_failed");
    });
  });
});
