#!/usr/bin/env bun
/**
 * Gateway entry point.
 *
 * Boots config → validate backend → spawn llama-server → register graphs →
 * create providers → mount Bun.serve (fetch handler) → listen.
 *
 * The managed backend MUST be ready (start()) BEFORE Bun.serve listens so
 * traffic never hits an unready upstream. Shutdown stops the backend and
 * drains in-flight requests before exiting.
 */
import { loadGatewayConfig } from "./config/index.js";
import { ERR_CONFIG_NOT_FOUND } from "./config/load.js";
import { generateDefaultConfig } from "./config/defaults.js";
import { createModelsWatcher } from "./config/watcher.js";
import { persistConfig } from "./config/write.js";
import { createPipelineRegistry } from "./orchestrator/registry.js";
import { validateGraph } from "./orchestrator/graph.js";
import { makeLlamaServerProvider } from "./providers/llama-server.js";
import { makeOpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { createApp } from "./server.js";
import { createLlamaServeManager } from "./backend/manager.js";
import {
  createModelLifecycle,
  buildRegisteredIndex,
  resolveModelId,
  readChildrenPids,
  readProcCmdline,
  modelIdFromCmdline,
  parseVramLine,
  type WorkerInfo,
} from "./backend/lifecycle.js";
import { logJson } from "./utils/logger.js";
import { shutdown } from "./shutdown.js";
import { createExecutionTracker } from "./dashboard/execution-tracker.js";
import { createEventBus } from "./dashboard/events.js";
import { createMetricsCollector } from "./dashboard/metrics.js";
import { createApplyService } from "./dashboard/service.js";
import { createDashboardRouter } from "./dashboard/router.js";
import { runStepRetry } from "./dashboard/retry.js";
import {
  parseGgufHeader,
  hardwareMaxCtx,
  effectiveCtx,
  DEFAULT_EFFECTIVE_CTX,
} from "./utils/gguf.js";
import path from "node:path";
import { statSync, existsSync } from "node:fs";
import type { GatewayConfig, ChainConfig } from "./config/schema.js";
import type { GraphPipeline } from "./orchestrator/graph.js";

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

// ── GGUF metadata cache (boot parse + lazy parse for detected files) ──
// parseGgufHeader reads ≤256KB per model. Parsing once at boot and serving
// from cache avoids blocking the event loop on every /api/ui/models request;
// files the config does NOT register but the watcher detects (granite, grok,
// …) are parsed lazily the first time the watcher reports them, so the
// dashboard shows REAL metadata for every model on disk, not fixed stubs.
// (RDD #26 — event-loop-blocking GGUF parsing.)
//
// The cache also holds the per-model EFFECTIVE context. That value drives the
// preset INI sections (manager.modelContextFor), /v1/models meta.context_length,
// and the dashboard model list — one computation, three consumers.
interface GgufMeta {
  ggufContextLength: number | null;
  architecture: string | null;
  blockCount: number | null;
  headCountKv: number | null;
  fileType: number | null;
  /** True when the GGUF header was structurally parsed (magic OK). */
  parsed: boolean;
  /** Hardware ceiling from hardwareMaxCtx (VRAM budget, model file size). */
  hardwareMaxCtx: number;
  /** Effective context with no userCtx — parsed signals + hardware only. */
  effectiveCtx: number;
}
const ggufMetaCache = new Map<string, GgufMeta>(); // key: lowercased file name
const ggufParseInFlight = new Map<string, Promise<void>>();

async function ensureGgufMeta(fileName: string): Promise<GgufMeta | undefined> {
  const key = fileName.toLowerCase();
  const cached = ggufMetaCache.get(key);
  if (cached) return cached;
  const inFlight = ggufParseInFlight.get(key);
  if (inFlight) {
    await inFlight;
    return ggufMetaCache.get(key);
  }
  const run = (async (): Promise<void> => {
    try {
      const filePath = path.join(config.llama.modelsDir, fileName);
      const gguf = await parseGgufHeader(filePath);
      const modelBytes = statSync(filePath).size;
      const hw = hardwareMaxCtx({ modelBytes });
      ggufMetaCache.set(key, {
        ggufContextLength: gguf.ggufContextLength,
        architecture: gguf.architecture,
        blockCount: gguf.blockCount,
        headCountKv: gguf.headCountKv,
        fileType: gguf.fileType,
        parsed: gguf.parsed,
        hardwareMaxCtx: hw,
        effectiveCtx: effectiveCtx({
          ggufContextLength: gguf.ggufContextLength,
          ggufParsed: gguf.parsed,
          hardwareMaxCtx: hw,
          name: fileName,
        }),
      });
    } catch {
      // Unreadable file — leave the cache empty; consumers fall back to
      // null metadata + DEFAULT_EFFECTIVE_CTX.
    }
  })();
  ggufParseInFlight.set(key, run);
  try {
    await run;
  } finally {
    ggufParseInFlight.delete(key);
  }
  return ggufMetaCache.get(key);
}

/** Effective context for a REGISTERED model id (user ctx + parsed + hw). */
function effectiveForId(id: string): number | undefined {
  const m = config.llama.models?.[id];
  if (!m) return undefined;
  const meta = ggufMetaCache.get(m.file.toLowerCase());
  if (!meta) return undefined;
  return effectiveCtx({
    userCtx: m.ctx,
    ggufContextLength: meta.ggufContextLength,
    ggufParsed: meta.parsed,
    hardwareMaxCtx: meta.hardwareMaxCtx,
    name: `${m.file} ${id}`,
  });
}

for (const [id, m] of Object.entries(config.llama.models ?? {})) {
  await ensureGgufMeta(m.file);
  void effectiveForId(id); // warm the registered-id computation
}
log("info", "gguf metadata cached", { files: ggufMetaCache.size });

// ── Backend manager ──
// The effective-context map flows into the preset generator: each model gets
// its own `ctx-size` section instead of a global `--ctx-size` on the router
// (a global value would override every section — see preset.ts/manager.ts).
const manager = createLlamaServeManager({
  config: config.llama,
  modelContextFor: (id) => effectiveForId(id),
});

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

// ── Register graph pipelines from config (graph is canonical) ──
// A chain config is already a graph: `nodes`+`edges` parsed directly by zod.
// (The removed parser's `configChainToGraph` was a thin structural mapping;
//  the config graph passes straight through with an edge `guard` narrowing.
//  Branches are the only guards the engine evaluates, so the cast is the
//  boundary narrowing.)
function configChainToGraph(
  name: string,
  cfg: ChainConfig,
): GraphPipeline {
  return {
    id: cfg.name ?? name,
    name: cfg.displayName ?? cfg.name ?? name,
    nodes: cfg.nodes,
    edges: cfg.edges as GraphPipeline["edges"],
  };
}

const registry = createPipelineRegistry({
  graphs: Object.entries(config.chains).map(([name, chain]) =>
    configChainToGraph(name, chain),
  ),
});

// ── Models directory watcher (Slice A) ──
// Detects candidate `*.gguf` models and emits `models:changed` for the
// dashboard-api model-list merge (Slice C). Candidate-only — no auto-register.
const watcher = createModelsWatcher({ modelsDir: config.llama.modelsDir });

// Latest candidate set, kept live by the watcher's `models:changed` event so
// the dashboard /api/ui/models list reflects newly detected `.gguf` files
// without the router awaiting an async scan at request time. Detected files
// are ALSO parsed (lazily, memoized) — the dashboard shows real metadata for
// them, not fixed stubs.
let detectedModels: string[] = [];
watcher.on("models:changed", (files) => {
  detectedModels = files;
  for (const file of files) {
    if (!ggufMetaCache.has(file.toLowerCase())) void ensureGgufMeta(file);
  }
});

// ── Providers ──
// ── F2: Model lifecycle controller ──
// Watches the router's worker processes (/proc), tracks per-model activity,
// and unloads idle/over-VRAM models on a 5s tick. All IO seams wired here:
// the manager kills workers; nvidia-smi samples VRAM; llama config is read
// LIVE from the `config` object — and `config.llama` is re-assigned on apply,
// so dashboard edits take effect without a restart.
const registeredIndex = () => buildRegisteredIndex(config.llama.models ?? {});
const listWorkers = (): WorkerInfo[] => {
  const routerPid = manager.status().pid;
  if (!routerPid) return [];
  const index = registeredIndex();
  const out: WorkerInfo[] = [];
  for (const pid of readChildrenPids(routerPid)) {
    const cmdline = readProcCmdline(pid);
    if (!cmdline) continue;
    const hit = modelIdFromCmdline(cmdline, index.byFile);
    if (!hit) continue;
    out.push({ modelId: hit.modelId, pid, sizeMiB: modelFileSizeMiB(hit.file) });
  }
  return out;
};
/** Model file size in MiB (0 when unknown) — LRU credit for the VRAM pass. */
function modelFileSizeMiB(file: string): number {
  if (!file) return 0;
  try {
    return Math.max(1, Math.round(statSync(path.join(config.llama.modelsDir, file)).size / (1024 * 1024)));
  } catch {
    return 0;
  }
}
/** nvidia-smi VRAM sample (async spawn — never blocks the event loop).
 *  Bounded: a hung nvidia-smi must not wedge the lifecycle tick, so the read
 *  races a short timer and the spawn is killed either way. */
const NVIDIA_SMI_TIMEOUT_MS = 3000;

/** One-shot nvidia-smi query; the subprocess is always reaped in `finally`. */
async function readNVidiaSmi(): Promise<string> {
  const res = Bun.spawn({
    cmd: ["nvidia-smi", "--query-gpu=memory.total,memory.used", "--format=csv,noheader"],
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    return await new Response(res.stdout).text();
  } finally {
    try {
      res.kill();
    } catch {
      // already gone — fine
    }
  }
}

async function sampleVramMiB(): Promise<{ totalMiB: number; usedMiB: number } | null> {
  try {
    const stdout = await Promise.race([
      readNVidiaSmi(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("nvidia-smi timed out")),
          NVIDIA_SMI_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    return parseVramLine(stdout.trim().split("\n")[0] ?? "");
  } catch {
    return null;
  }
}

const lifecycle = createModelLifecycle({
  getConfig: () => config.llama.lifecycle,
  logger: log,
  listWorkers,
  // F2 unload: prefer the router's HTTP API (verified: POST /models/unload in
  // llama.cpp server.cpp router mode) so the router's state map and SSE clients
  // stay consistent; unloadWorker's signal-kill covers older binaries.
  unloadModelId: (modelId, pid) => manager.unloadModel(modelId, pid),
  killWorker: (pid) => manager.unloadWorker(pid),
  sampleVram: sampleVramMiB,
});

/**
 * F2 request tracking seam: resolves the raw request model to the lifecycle
 * id, starts the in-flight marker, and returns the end-callback (release).
 * Passed to the passthrough proxy (via server routes) AND to the provider,
 * so every request pass-through point — direct or chain — is tracked.
 */
const noteActivityFor = (rawModel: string): (() => void) | void => {
  const modelId = resolveModelId(rawModel, registeredIndex());
  lifecycle.beginRequest(modelId);
  return () => lifecycle.endRequest(modelId);
};

const providers = new Map([
  [
    "llama-server",
    makeLlamaServerProvider({
      getBaseUrl: () => manager.status().baseUrl,
      requestTimeoutMs: config.llama.requestTimeoutMs,
      noteActivity: noteActivityFor,
    }),
  ],
]);

// ── External providers (multi-provider-pipelines) ──
// Each `providers.<name>` entry in the config becomes an OpenAI-compatible
// adapter; its `models` ids are published via /v1/models and routed directly
// in chat/completions (externalModels). llama-server stays FIRST so the
// graph-engine's default-provider fallback keeps resolving to the managed
// backend (ADR-8: no noteActivity — the lifecycle tracker only knows
// llama-server workers).
const externalModels = new Map<string, string>();
for (const [name, ext] of Object.entries(config.providers)) {
  providers.set(
    name,
    makeOpenAICompatibleProvider({
      name,
      baseURL: ext.baseURL,
      apiKey: ext.apiKey,
      headers: ext.headers,
      models: ext.models,
    }),
  );
  for (const modelId of ext.models) externalModels.set(modelId, name);
}

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
    // F2: the lifecycle controller reads llama config via a live getter —
    // re-point it at the applied values so TTL/VRAM edits take effect NOW
    // (no backend restart needed).
    config.llama = cfg.llama;
    config.providers = cfg.providers;
    await registry.reload(
      Object.entries(cfg.chains).map(([name, chain]) =>
        configChainToGraph(name, chain),
      ),
    );
    // External providers are rebuilt from the applied config (ADR-7). The
    // llama-server entry stays first; external adapters carry no lifecycle
    // tracking (ADR-8).
    for (const name of [...providers.keys()]) {
      if (name !== "llama-server") providers.delete(name);
    }
    externalModels.clear();
    for (const [name, ext] of Object.entries(cfg.providers)) {
      providers.set(
        name,
        makeOpenAICompatibleProvider({
          name,
          baseURL: ext.baseURL,
          apiKey: ext.apiKey,
          headers: ext.headers,
          models: ext.models,
        }),
      );
      for (const modelId of ext.models) externalModels.set(modelId, name);
    }
  },
  getCurrentChains: () => registry.listGraphs().map((g) => g.id),
});

// Resolve a node's runtime type for retry gating: graph pipelines expose their
// node types directly.
function nodeTypeFor(pipelineId: string, nodeId: string): string | undefined {
  const graph = registry.getGraph(pipelineId);
  return graph?.nodes.find((n) => n.id === nodeId)?.type;
}

// Non-streaming retry of a failed llm_call step (task 3.7). The provider is
// the managed llama-server backend; the model comes from the graph.
const getModel = registry.getGraph.bind(registry);

const dashboardHandler = createDashboardRouter({
  chainSummaries: () =>
    registry.listGraphs().map((graph) => ({
      id: graph.id,
      description: null,
      nodeCount: graph.nodes.length,
      lastExecution: tracker.get(graph.id)?.id ? new Date().toISOString() : null,
    })),
  getPipeline: (id) => registry.getGraph(id),
  registeredModels: () => Object.keys(config.llama.models ?? {}),
  modelDetails: () =>
    Object.entries(config.llama.models ?? {}).map(([id, m]) => {
      const meta = ggufMetaCache.get(m.file.toLowerCase());
      return {
        id,
        file: m.file,
        ctx: m.ctx,
        temp: m.temp,
        ggufContextLength: meta?.ggufContextLength ?? null,
        // Missing (unreadable/not-yet-parsed) → the UI treats it as "no
        // ceiling", so the unsafe dimming never fires on fabricated numbers.
        hardwareMaxCtx: meta?.hardwareMaxCtx,
        effectiveCtx: effectiveForId(id) ?? meta?.effectiveCtx ?? DEFAULT_EFFECTIVE_CTX,
      };
    }),
  // Per-FILE metadata for watcher-detected models (not in the config), so the
  // dashboard list shows their REAL parsed values instead of fixed stubs.
  fileModelDetails: (fileName: string) => {
    const meta = ggufMetaCache.get(fileName.toLowerCase());
    return meta
      ? {
          ggufContextLength: meta.ggufContextLength,
          hardwareMaxCtx: meta.hardwareMaxCtx,
          effectiveCtx: meta.effectiveCtx,
        }
      : undefined;
  },
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
      // The retry runs a NON-streamING chat call through the real provider.
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
  backendBaseUrl: manager.status().baseUrl || undefined,
  // F2: live config for the Backend editor + lifecycle state/actions.
  getConfig: () => config,
  lifecycleStatus: () => lifecycle.status(),
  unloadModel: (modelId) => lifecycle.unload(modelId, "manual"),
  unloadAllModels: () => lifecycle.unloadAll("manual-all"),
});

// ── Bun.serve fetch handler ──
// Dashboard UI directory (svelte-ui 2.3): the SPA is the COMPILED Svelte
// bundle under `dist/ui` (built with `bun run build:ui`). `UI_DIR` always
// wins. Without it, the resolution is: compiled `./dist/ui` when the build
// exists, else the embedded copy next to this module when one is present.
// The embedded check explicitly excludes the legacy `src/ui` source tree
// (recognized by its `app.js` marker): it still ships the OLD SPA until
// Phase 4.4 deletes it, and it must never shadow the compiled bundle.
// A missing build falls through to `./dist/ui`, where the server's /ui
// handler returns the "run build:ui" 404.
async function resolveUiDir(): Promise<string> {
  const fromEnv = process.env.UI_DIR;
  if (fromEnv) return fromEnv;
  const compiledIndex = path.join(process.cwd(), "dist", "ui", "index.html");
  if (existsSync(compiledIndex)) return "./dist/ui";
  const embeddedIndex = path.join(import.meta.dir, "ui", "index.html");
  const legacyMarker = path.join(import.meta.dir, "ui", "app.js");
  if ((await Bun.file(embeddedIndex).exists()) && !existsSync(legacyMarker)) {
    return path.join(import.meta.dir, "ui");
  }
  return "./dist/ui";
}

const app = createApp({
  config,
  registry,
  providers,
  externalModels,
  manager,
  noteActivity: noteActivityFor,
  dashboard: { handler: dashboardHandler },
  uiDir: await resolveUiDir(),
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
  { models: registry.listGraphs().map((g) => `gateway/${g.id}`) },
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

// ── F2 lifecycle ticker (5s, unref'd — never blocks shutdown) ──
lifecycle.start();
log("info", "model lifecycle active", {
  ttl: config.llama.lifecycle.ttl,
  vramMode: config.llama.lifecycle.vram.mode,
});

// ── Graceful shutdown ──
// `shutdown` lives in src/shutdown.ts (pure, side-effect-free, importable by
// tests). Idempotency is enforced HERE at the signal-handler call-site via the
// module-level `shuttingDown` guard — running the full drain twice from the
// very real repeated signals (SIGTERM + SIGINT) would double-stop the backend.
let shuttingDown = false;

/** Single entry point for every shutdown path: the idempotent guard, the F2
 *  lifecycle must not leave timers behind (stop() clears the tick/VRAM loops),
 *  then the pure drain (src/shutdown.ts). */
function beginShutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  lifecycle.stop();
  void shutdown(reason, server, manager, log, process.exit as (code?: number) => never);
}

process.on("SIGINT", () => beginShutdown("SIGINT"));
process.on("SIGTERM", () => beginShutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", { reason: String(reason) });
  beginShutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  log("fatal", "uncaughtException", { message: (err as Error).message });
  beginShutdown("uncaughtException");
});
