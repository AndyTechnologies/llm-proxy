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

// ── Config ──
const config = await loadGatewayConfig();
console.log(`[gateway] config loaded: ${Object.keys(config.chains).length} chains`);

// ── Backend manager ──
const manager = createLlamaServeManager({ config: config.llama });

try {
  await manager.start();
} catch (err) {
  console.error(
    `[gateway] FATAL: backend failed to start — ${(err as Error).message}`,
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

console.log(
  `[gateway] OpenAI-compatible API listening on http://${config.server.host}:${server.port}`,
);
console.log(
  `[gateway] virtual models: ${[...chains.keys()].map((n) => `gateway/${n}`).join(", ")}`,
);
console.log(`[gateway] backend: ${manager.status().baseUrl}`);

// ── Graceful shutdown ──
let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[gateway] shutting down (${reason})`);

  const forceClose = setTimeout(() => {
    server.stop(true);
  }, 3000);
  forceClose.unref();

  await server.stop(false);
  clearTimeout(forceClose);

  await manager.stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection:", reason);
  void shutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException:", err);
  void shutdown("uncaughtException");
});