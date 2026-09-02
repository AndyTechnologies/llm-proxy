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
let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log("info", "shutting down", { reason });

  // Bounded drain (health-endpoints Req 5): stop accepting new connections
  // and drain in-flight requests gracefully; if a connection outlives the
  // window (3s), force-close it so shutdown always completes with no orphans.
  const forceClose = setTimeout(() => {
    server.stop(true);
  }, 3000);
  forceClose.unref();

  await server.stop(false);
  clearTimeout(forceClose);

  await manager.stop();
  log("info", "shutdown complete", { reason });
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", { reason: String(reason) });
  void shutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  log("fatal", "uncaughtException", { message: (err as Error).message });
  void shutdown("uncaughtException");
});