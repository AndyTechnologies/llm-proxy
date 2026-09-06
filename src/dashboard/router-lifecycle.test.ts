import { describe, it, expect } from "bun:test";
import { createDashboardRouter } from "./router.js";
import type { DashboardRouterDeps } from "./router.js";
import { createExecutionTracker } from "./execution-tracker.js";
import { createEventBus } from "./events.js";
import { createMetricsCollector } from "./metrics.js";
import { createApplyService } from "./service.js";
import type { GatewayConfig, LifecycleConfig } from "../config/schema.js";
import type { LifecycleStatus } from "../backend/lifecycle.js";

/** Typed body read for tests (bun types `res.json()` as unknown). */
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Base deps copied from router.test.ts, plus F2 lifecycle deps. */
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
    chainSummaries: () => [],
    getPipeline: () => undefined,
    registeredModels: () => ["m1.gguf", "m2.gguf"],
    modelDetails: () => [
      { id: "m1.gguf", file: "m1.gguf", ctx: 4096, temp: 0.1, ggufContextLength: 8192, hardwareMaxCtx: 16384, effectiveCtx: 4096 },
      { id: "m2.gguf", file: "m2.gguf", ctx: 8192, temp: 0.7, ggufContextLength: null, hardwareMaxCtx: 16384, effectiveCtx: 8192 },
    ],
    detectedModels: () => ["m3.gguf"],
    fileModelDetails: () => undefined,
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

const F2_LIFECYCLE: LifecycleStatus = {
  loaded: ["m1.gguf"],
  lastUsed: { "m1.gguf": "2026-09-01T00:00:02Z" },
  recentUnloads: [
    { modelId: "m2.gguf", pid: 4242, reason: "manual", ok: true, at: "2026-09-01T00:00:01Z" },
  ],
  vramPolicyActive: true,
  lastVramSample: { totalMiB: 6144, usedMiB: 165, at: "2026-09-01T00:00:00Z" },
};

const F2_CONFIG: GatewayConfig = {
  server: { host: "127.0.0.1", port: 5315, corsOrigins: "*", jsonLimit: "10mb" },
  llama: {
    binary: "/opt/llama/bin/llama-server",
    host: "127.0.0.1",
    port: 5316,
    autoStart: true,
    startupTimeoutMs: 30000,
    stopTimeoutMs: 5000,
    requestTimeoutMs: 300000,
    healthPollIntervalMs: 1000,
    portParseTimeoutMs: 5000,
    backoffCapMs: 30000,
    maxRestartAttempts: 5,
    modelsDir: "/models",
    autoload: true,
    router: {
      ctx: 8192,
      n: 2048,
      nGpuLayers: -1,
      flashAttn: true,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      batch: 2048,
      ubatch: 512,
      tools: "all",
      parallel: 1,
    },
    models: {
      "m1.gguf": { file: "m1.gguf", ctx: 4096, temp: 0.1 },
    },
    lifecycle: { ttl: 600, vram: { mode: "dynamic", freeGb: 1, capGb: 5 } },
  },
  chains: {},
  providers: {},
};

describe("dashboard router — F2 lifecycle routes", () => {
  it("GET /api/ui/config returns the live gateway config", async () => {
    const deps = makeDeps({ getConfig: () => F2_CONFIG });
    const res = await call(deps, "GET", "/api/ui/config");
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      llama: { lifecycle: LifecycleConfig };
    }>(res);
    expect(body.llama.lifecycle).toEqual({
      ttl: 600,
      vram: { mode: "dynamic", freeGb: 1, capGb: 5 },
    });
  });

  it("GET /api/ui/config → 404 when getConfig is absent", async () => {
    const res = await call(makeDeps(), "GET", "/api/ui/config");
    expect(res.status).toBe(404);
  });

  it("POST /api/ui/models/:id/unload unloads a loaded model", async () => {
    const unloaded: string[] = [];
    const deps = makeDeps({
      unloadModel: async (id) => {
        unloaded.push(id);
        return id === "m1.gguf";
      },
    });
    const res = await call(deps, "POST", "/api/ui/models/m1.gguf/unload");
    expect(res.status).toBe(200);
    expect(await jsonBody<{ modelId: string; unloaded: boolean }>(res)).toEqual({
      modelId: "m1.gguf",
      unloaded: true,
    });
    expect(unloaded).toEqual(["m1.gguf"]);
  });

  it("POST /api/ui/models/:id/unload → 404 when the model is not loaded", async () => {
    const deps = makeDeps({ unloadModel: async () => false });
    const res = await call(deps, "POST", "/api/ui/models/m1.gguf/unload");
    expect(res.status).toBe(404);
  });

  it("POST /api/ui/models/:id/unload → 404 when unloadModel is absent", async () => {
    const res = await call(makeDeps(), "POST", "/api/ui/models/m1.gguf/unload");
    expect(res.status).toBe(404);
  });

  it("POST /api/ui/models/unload-all unloads every worker", async () => {
    const deps = makeDeps({ unloadAllModels: async () => 2 });
    const res = await call(deps, "POST", "/api/ui/models/unload-all");
    expect(res.status).toBe(200);
    expect(await jsonBody<{ unloaded: number }>(res)).toEqual({ unloaded: 2 });
  });

  it("POST /api/ui/models/unload-all → 404 when unloadAllModels is absent", async () => {
    const res = await call(makeDeps(), "POST", "/api/ui/models/unload-all");
    expect(res.status).toBe(404);
  });

  it("GET /api/ui/models includes processLoaded, lastUsed and lifecycle block", async () => {
    const deps = makeDeps({
      lifecycleStatus: () => F2_LIFECYCLE,
    });
    const res = await call(deps, "GET", "/api/ui/models");
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      models: { id: string; processLoaded: boolean; lastUsed?: string }[];
      lifecycle: { vramPolicyActive: boolean; lastVramSample: unknown; recentUnloads: unknown };
    }>(res);
    expect(body.lifecycle).toMatchObject({
      vramPolicyActive: true,
      lastVramSample: { totalMiB: 6144, usedMiB: 165 },
      recentUnloads: [{ modelId: "m2.gguf", reason: "manual", ok: true }],
    });
    const m1 = body.models.find((m) => m.id === "m1.gguf")!;
    expect(m1.processLoaded).toBe(true);
    expect(m1.lastUsed).toBe("2026-09-01T00:00:02Z");
    const m2 = body.models.find((m) => m.id === "m2.gguf")!;
    expect(m2.processLoaded).toBe(false);
  });
});