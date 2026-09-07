#!/usr/bin/env bun
/**
 * E2E harness for Playwright — mounts the REAL gateway `createApp` with FAKE
 * dependencies (no real llama-server backend, no network) and serves the real
 * `/ui` SPA from disk on a fixed ephemeral port.
 *
 * Why not `bun run src/index.ts` for E2E? The real entry point boots the
 * managed `llama-server` backend (spawned from the binary + models dir), which
 * is not available in CI. This harness substitutes a fake manager + empty
 * provider map so the dashboard REST/SSE surface and the SPA can be exercised
 * end-to-end in a browser, deterministically.
 *
 * Run with: `bun run e2e-server` (wired in package.json) — matches
 * playwright.config.ts `webServer.command`. The process stays alive via
 * Bun.serve and logs its bound port; Playwright waits for the baseURL to be
 * reachable before running specs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server.js";
import type { ServerDeps } from "../src/server.js";
import type { LlamaServeManager } from "../src/backend/manager.js";
import type { GraphPipeline } from "../src/orchestrator/graph.js";
import { createDashboardRouter } from "../src/dashboard/router.js";
import { createExecutionTracker } from "../src/dashboard/execution-tracker.js";
import { createEventBus } from "../src/dashboard/events.js";
import { createMetricsCollector } from "../src/dashboard/metrics.js";
import { createApplyService } from "../src/dashboard/service.js";

/** Port that matches playwright.config.ts baseURL. */
const PORT = Number(process.env.E2E_PORT ?? 8099);
const HOST = process.env.E2E_HOST ?? "127.0.0.1";

/** Deterministic example graph loaded into the editor via /pipelines/:id. */
const EXAMPLE_PIPELINE: GraphPipeline = {
  id: "customer-support",
  name: "customer-support",
  nodes: [
    { id: "start", type: "start" },
    { id: "triage", type: "llm_call", model: "llama-3.1-8b.gguf" },
    { id: "escalate", type: "condition", condition: { op: "compare", field: "lastResponse.status", op2: "==", value: 429 } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "triage" },
    { from: "triage", to: "escalate" },
    { from: "escalate", to: "end" },
  ],
};

/** Deterministic example chain summary list. */
function exampleChainSummaries() {
  return [
    {
      id: "customer-support",
      description: "Example triage pipeline",
      nodeCount: 4,
      lastExecution: "2026-09-01T10:00:00.000Z",
    },
    {
      id: "summarize",
      description: "Summarization chain",
      nodeCount: 3,
      lastExecution: null,
    },
  ];
}

/** A fake manager — never talks to a real llama-server process. */
function fakeManager(): LlamaServeManager {
  return {
    status: () => ({
      state: "running",
      pid: 0,
      models: ["llama-3.1-8b.gguf"],
      baseUrl: "http://127.0.0.1:0",
    }),
    start: async () => {},
    stop: async () => {},
  } as unknown as LlamaServeManager;
}

/** Point uiDir at the compiled Svelte SPA output under the repo root
 *  (svelte-ui 2.4): `dist/ui` built with `bun run build:ui`. UI_DIR
 *  overrides when set. */
const UI_DIR = process.env.UI_DIR ?? join(import.meta.dir, "..", "dist", "ui");

/**
 * Build the full ServerDeps with the dashboard wired using deterministic
 * fakes, mirroring the wiring in src/index.ts and src/dashboard/router.test.ts.
 *
 * `tracker` and `bus` live at module scope so the SSE-live debug seam
 * (`POST /api/ui/_e2e/complete`) can record + publish deterministically.
 */
let tracker = createExecutionTracker({ maxHistory: 100 });
let bus = createEventBus({ bufferSize: 100 });

/**
 * Chains applied through the editor (magic "applies" in the harness): the
 * simulated persist/reload writes them here, and the Pipelines list is
 * derived from `exampleChainSummaries() + appliedChains` so the editor's
 * apply round-trip is observable end-to-end.
 */
let appliedChains: string[] = [];

function buildDeps(): ServerDeps {
  const metrics = createMetricsCollector();

  // Seed one deterministic completed execution so the Executions view loads.
  const execId = tracker.recordStart("customer-support");
  tracker.recordStep(execId, { nodeId: "triage", status: 200, latencyMs: 120 });
  tracker.recordComplete(execId);

  const applyService = createApplyService({
    configPath: "/tmp/e2e-llm-proxy.config.yaml",
    persist: async () => "yaml",
    // The harness simulates persistence: chains applied through the editor
    // join the pipeline summaries so the Pipelines list reflects them.
    reload: (chains) => {
      appliedChains.length = 0;
      appliedChains.push(...chains);
    },
    getCurrentChains: () => ["customer-support"],
  });

  const dashboardHandler = createDashboardRouter({
    chainSummaries: () => [
      ...exampleChainSummaries(),
      ...appliedChains
        .filter((id) => !["customer-support", "summarize"].includes(id))
        .map((id) => ({
          id,
          description: "Applied from the editor",
          nodeCount: 1,
          lastExecution: null as string | null,
        })),
    ],
    getPipeline: (id) => (id === EXAMPLE_PIPELINE.id ? EXAMPLE_PIPELINE : undefined),
    registeredModels: () => ["llama-3.1-8b.gguf", "llama-3.1-70b.gguf"],
    modelDetails: () => [
      { id: "llama-3.1-8b.gguf", file: "llama-3.1-8b.gguf", ctx: 8192, temp: 0.1, ggufContextLength: null, hardwareMaxCtx: 65536 },
      { id: "llama-3.1-70b.gguf", file: "llama-3.1-70b.gguf", ctx: 16384, temp: 0.7, ggufContextLength: null, hardwareMaxCtx: 65536 },
    ],
    detectedModels: () => ["llama-3.2-1b.gguf"],
    modelsDir: "/models",
    autoRefresh: true,
    tracker,
    bus,
    metrics,
    validateGraph: () => ({ ok: true, errors: [] }),
    applyService,
    runRetry: async () => ({ ok: true, retryExecutionId: "exec-retry-1" }),
    getNodeType: () => undefined,
  });

  return {
    config: {
      server: { host: HOST, port: PORT, corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
      chains: {},
    } as unknown as ServerDeps["config"],
    providers: new Map(),
    manager: fakeManager(),
    dashboard: { handler: dashboardHandler },
    uiDir: UI_DIR,
  } as ServerDeps;
}

let app = createApp(buildDeps());

// ── SSE-live debug seam (harness only, svelte-ui 2.4) ──
// `POST /api/ui/_e2e/complete` records one more completed execution on the
// shared tracker and publishes `execution:completed` to the bus, so the
// "SSE live updates" spec can assert that the open page appends the new
// execution without a reload. `POST /api/ui/_e2e/reset` rebuilds the harness
// from scratch (fresh tracker/bus/applied-chains, reseeding the single
// example execution) so tests stay deterministic across runs — including
// Playwright reusing an already-running server locally.
const harnessApp = async (req: Request, srv: ReturnType<typeof Bun.serve>) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/api/ui/_e2e/complete") {
    const executionId = tracker.recordStart("customer-support");
    tracker.recordStep(executionId, {
      nodeId: "triage",
      status: 200,
      latencyMs: 80,
    });
    tracker.recordComplete(executionId);
    bus.publish({ type: "execution:completed", executionId });
    return Response.json({ ok: true, executionId });
  }
  if (req.method === "POST" && url.pathname === "/api/ui/_e2e/reset") {
    tracker = createExecutionTracker({ maxHistory: 100 });
    bus = createEventBus({ bufferSize: 100 });
    appliedChains = [];
    app = createApp(buildDeps());
    return Response.json({ ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/ui/apply") {
    const body = await req.text();
    console.log("[e2e] apply body:", body.slice(0, 2000));
    const appResp = await app(
      new Request(req.url, { method: req.method, headers: req.headers, body }),
      srv,
    );
    console.log("[e2e] apply status:", appResp.status);
    return appResp;
  }
  return app(req, srv);
};

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: harnessApp,
});

// Log the bound port so Playwright's webServer.url can reference it and humans
// can curl it. Bun.serve keeps the event loop alive, so this process persists.
console.log(`[e2e-server] dashboard harness listening on http://${HOST}:${server.port}`);
if (!existsSync(join(UI_DIR, "index.html"))) {
  console.warn(
    `[e2e-server] WARNING: compiled UI not found at ${UI_DIR} — ` +
      "run `bun run build:ui` before the SPA specs (shell/serving specs still pass).",
  );
}
