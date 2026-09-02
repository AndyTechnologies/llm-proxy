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
import { parseChains } from "./orchestrator/parser.js";
import { makeLlamaServerProvider } from "./providers/llama-server.js";
import { createApp } from "./server.js";
import { createLlamaServeManager } from "./backend/manager.js";
import { logJson } from "./utils/logger.js";
import { shutdown } from "./shutdown.js";

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
const config = await loadGatewayConfig();
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
const chains = parseChains(config);

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

// ── Bun.serve fetch handler ──
const app = createApp({ config, chains, providers, manager });

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
  { models: [...chains.keys()].map((n) => `gateway/${n}`) },
);
log("info", "backend", { baseUrl: manager.status().baseUrl });

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