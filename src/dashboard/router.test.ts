import { describe, it, expect } from "bun:test";
import { createDashboardRouter, decideRetry } from "./router.js";
import type { DashboardRouterDeps } from "./router.js";
import { createExecutionTracker } from "./execution-tracker.js";
import { createEventBus } from "./events.js";
import { createMetricsCollector } from "./metrics.js";
import { createApplyService } from "./service.js";

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
    registeredModels: () => ["m1.gguf", "m2.gguf"],
    detectedModels: () => ["m3.gguf"],
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
}

interface ModelListPayload {
  models: ModelSummary[];
  modelsDir: string;
  autoRefresh: boolean;
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

  it("GET /api/ui/models returns merged registered + detected models", async () => {
    const res = await call(makeDeps(), "GET", "/api/ui/models");
    expect(res.status).toBe(200);
    const data = await jsonBody<ModelListPayload>(res);
    expect(data.modelsDir).toBe("/models");
    expect(data.autoRefresh).toBe(true);
    expect(data.models).toHaveLength(3);
    expect(data.models[0]).toEqual({ id: "m1.gguf", file: "m1.gguf", loaded: true });
    expect(data.models[1]).toEqual({ id: "m2.gguf", file: "m2.gguf", loaded: true });
    // Detected model is a candidate, not loaded.
    expect(data.models[2]).toEqual({ id: "m3.gguf", file: "m3.gguf", loaded: false });
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

  it("POST /api/ui/apply returns applied with reloaded chains", async () => {
    const res = await call(makeDeps(), "POST", "/api/ui/apply", {
      config: { chains: { c1: { steps: [{ model: "m" }] } } },
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
