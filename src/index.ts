#!/usr/bin/env bun
/**
 * Gateway entry point.
 *
 * Boots config → validate backend → spawn llama-server → parse chains →
 * create providers → mount Bun.serve (fetch handler) → listen.
 *
 * The managed backend MUST be ready (start()) BEFORE Bun.serve listens so
 * traffic never hits an unready upstream. Shutdown stops the backend and
 * drains in-flight requests before exiting.
 *
 * S2a: Bun.serve serves GET /health + GET /v1/models. SSE chat/completions
 * routes are migrated in S2b.
 */
import { loadGatewayConfig } from "./config/index.js";
import { ERR_CONFIG_NOT_FOUND } from "./config/load.js";
import { generateDefaultConfig } from "./config/defaults.js";
import { createModelsWatcher } from "./config/watcher.js";
import { persistConfig } from "./config/write.js";
import { parseChains, chainToGraph } from "./orchestrator/parser.js";
import { createPipelineRegistry } from "./orchestrator/registry.js";
import { validateGraph } from "./orchestrator/graph.js";
import { makeLlamaServerProvider } from "./providers/llama-server.js";
import { createApp } from "./server.js";
import { createLlamaServeManager } from "./backend/manager.js";
import { logJson } from "./utils/logger.js";
import { shutdown } from "./shutdown.js";
import { createExecutionTracker } from "./dashboard/execution-tracker.js";
import { createEventBus } from "./dashboard/events.js";
import { createMetricsCollector } from "./dashboard/metrics.js";
import { createApplyService } from "./dashboard/service.js";
import { createDashboardRouter } from "./dashboard/router.js";
import { runStepRetry } from "./dashboard/retry.js";
import type { GatewayConfig } from "./config/schema.js";

// ── Structured JSON logging (S3.1 — health-endpoints Req 4) ──
// Startup, shutdown, and fatal-error lines are emitted as single-line JSON
// with `level` + `message`. info/warn → stdout; error/fatal → stderr.
function log(level: string, message: string, extra: Record<string, unknown> = {}) {
  const line = logJson(level, message, extra);
  if (level === "error" || level === "fatal") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// ── Config ──
// Load the config from disk; when no config file exists, generate a minimal
// schema-valid config from the detected `.gguf` models (config-load Req
// "Config defaults generation") so the gateway can still boot.
const MODEL_DIR_DEFAULT = "~/Models";
function loadConfig(): Promise<GatewayConfig> {
  return loadGatewayConfig().catch((err: unknown) => {
    if (err instanceof Error && err.message.includes(ERR_CONFIG_NOT_FOUND)) {
      log("warn", "no config file found; booting on generated defaults", {
        modelsDir: MODEL_DIR_DEFAULT,
      });
      return generateDefaultConfig(MODEL_DIR_DEFAULT);
    }
    throw err;
  });
}
const config = await loadConfig();
log("info", "config loaded", { chains: Object.keys(config.chains).length });

// ── Backend manager ──
const manager = createLlamaServeManager({ config: config.llama });

try {
  await manager.start();
} catch (err) {
  log(
    "fatal",
    "backend failed to start",
    { message: (err as Error).message },
  );
  process.exit(1);
}

// ── Parse chains (fails fast on invalid config) ──
const parsed = parseChains(config);

// ── Mutable chain registry (Slice A) ──
// The registry supersedes the frozen `parseChains` Map as the source of truth
// for chain resolution. Routes read chains via `registry.asMap()`, which also
// allows a later atomic `reload()` (dashboard-api apply) to swap chains
// without a restart.
const registry = createPipelineRegistry({
  chains: [...parsed.values()],
  // Materialize the boot chains as graphs too, so the dashboard can load an
  // existing config-defined pipeline into the editor (GET /api/ui/pipelines/:id).
  graphs: [...parsed.values()].map(chainToGraph),
});

// ── Models directory watcher (Slice A) ──
// Detects candidate `*.gguf` models and emits `models:changed` for the
// dashboard-api model-list merge (Slice C). Candidate-only — no auto-register.
const watcher = createModelsWatcher({ modelsDir: config.llama.modelsDir });

// Latest candidate set, kept live by the watcher's `models:changed` event so
// the dashboard /api/ui/models list reflects newly detected `.gguf` files
// without the router awaiting an async scan at request time.
let detectedModels: string[] = [];
watcher.on("models:changed", (files) => {
  detectedModels = files;
});

// ── Providers ──
const providers = new Map([
  [
    "llama-server",
    makeLlamaServerProvider({
      getBaseUrl: () => manager.status().baseUrl,
      requestTimeoutMs: config.llama.requestTimeoutMs,
    }),
  ],
]);

// ── Dashboard (Slice C: /api/ui REST+SSE, apply, retry) ──
// The dashboard application stack is built once at boot and handed to the
// server as `deps.dashboard.handler`. Sources are read live from the registry,
// manager, and watcher so a hot-applied config is reflected on the next request.
const tracker = createExecutionTracker({ maxHistory: 100 });
const bus = createEventBus({ bufferSize: 100 });
const metrics = createMetricsCollector();
const configPath =
  process.env.CONFIG_FILE ?? "./llm-proxy.config.yaml";

const applyService = createApplyService({
  configPath,
  // Atomic persist (validation-gated; invalid config writes nothing).
  persist: (cfg) => persistConfig(cfg, configPath),
  // After a successful persist, reload the registry from the freshly written
  // config file so the new chains go live without a restart.
  reload: async () => {
    const cfg = await loadGatewayConfig();
    const fresh = parseChains(cfg);
    await registry.reload([...fresh.values()].map(chainToGraph), [...fresh.values()]);
  },
  getCurrentChains: () => [...registry.asMap().keys()],
});

// Resolve a node's runtime type for retry gating: graph pipelines expose their
// node types directly; linear chains treat every step as an llm_call.
function nodeTypeFor(pipelineId: string, nodeId: string): string | undefined {
  const graph = registry.getGraph(pipelineId);
  if (graph) {
    return graph.nodes.find((n) => n.id === nodeId)?.type;
  }
  return registry.asMap().has(pipelineId) ? "llm_call" : undefined;
}

// Non-streaming retry of a failed llm_call step (task 3.7). The provider is
// the managed llama-server backend; the model comes from the graph/chain.
const getModel = registry.getGraph.bind(registry);

const dashboardHandler = createDashboardRouter({
  chainSummaries: () =>
    [...registry.asMap().keys()].map((id) => {
      const graph = registry.getGraph(id);
      const chain = registry.asMap().get(id);
      return {
        id,
        description: null,
        nodeCount: graph?.nodes.length ?? chain?.steps.length ?? 0,
        lastExecution: tracker.get(id)?.id ? new Date().toISOString() : null,
      };
    }),
  getPipeline: (id) => registry.getGraph(id),
  registeredModels: () => Object.keys(config.llama.models ?? {}),
  modelDetails: () =>
    Object.entries(config.llama.models ?? {}).map(([id, m]) => ({
      id,
      file: m.file,
      ctx: m.ctx,
      temp: m.temp,
    })),
  detectedModels: () => detectedModels,
  modelsDir: config.llama.modelsDir,
  autoRefresh: true,
  tracker,
  bus,
  metrics,
  validateGraph,
  applyService,
  runRetry: async ({ executionId, nodeId }) => {
    const exec = tracker.get(executionId);
    const pipelineId = exec?.pipelineId ?? "unknown";
    const provider = providers.get("llama-server");
    if (!provider) {
      return {
        ok: false,
        error: {
          message: "llama-server provider not available",
          type: "server_error",
          code: null,
        },
      };
    }
    return runStepRetry({
      tracker,
      // The retry runs a NON-streaming chat call through the real provider.
      provider: { chat: (payload) => provider.chat(payload) },
      getNodeType: nodeTypeFor,
      requestPayload: () => ({}),
      model: getModel(pipelineId)?.nodes.find((n) => n.id === nodeId)?.model ?? "",
      executionId,
      nodeId,
      pipelineId,
    });
  },
  getNodeType: nodeTypeFor,
});

// ── Bun.serve fetch handler ──
const app = createApp({
  config,
  registry,
  chains: registry.asMap(),
  providers,
  manager,
  dashboard: { handler: dashboardHandler },
  // Static SPA served at /ui (Slice D). Running from source this resolves to
  // src/ui in the repo root; UI_DIR overrides the location (e.g. when the
  // build:binary step copies the SPA next to the binary).
  uiDir: process.env.UI_DIR ?? "./src/ui",
});

const server = Bun.serve({
  port: config.server.port,
  hostname: config.server.host,
  fetch: app,
});

log(
  "info",
  "OpenAI-compatible API listening",
  { url: `http://${config.server.host}:${server.port}` },
);
log(
  "info",
  "virtual models",
  { models: [...registry.asMap().keys()].map((n) => `gateway/${n}`) },
);
log("info", "backend", { baseUrl: manager.status().baseUrl });

// ── Initial models watcher scan (candidate-only, harmless if absent) ──
try {
  const candidates = await watcher.refresh();
  log("info", "models watcher scanned", { candidates: candidates.length });
} catch (err) {
  log("warn", "models watcher initial scan skipped", {
    message: (err as Error).message,
  });
}

// ── Graceful shutdown ──
// `shutdown` lives in src/shutdown.ts (pure, side-effect-free, importable by
// tests). Idempotency is enforced HERE at the signal-handler call-site via the
// module-level `shuttingDown` guard — running the full drain twice from the
// very real repeated signals (SIGTERM + SIGINT) would double-stop the backend.
let shuttingDown = false;

process.on("SIGINT", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown("SIGINT", server, manager, log, process.exit as (code?: number) => never);
});

process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown("SIGTERM", server, manager, log, process.exit as (code?: number) => never);
});

process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", { reason: String(reason) });
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown("unhandledRejection", server, manager, log, process.exit as (code?: number) => never);
});

process.on("uncaughtException", (err) => {
  log("fatal", "uncaughtException", { message: (err as Error).message });
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown("uncaughtException", server, manager, log, process.exit as (code?: number) => never);
});