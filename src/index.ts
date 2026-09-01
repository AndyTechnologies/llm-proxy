#!/usr/bin/env node
/**
 * Gateway entry point.
 *
 * Boots config → parse chains → create providers → mount Express app → listen.
 * No llama-swap process management (dropped in the rewrite). Graceful shutdown
 * on SIGINT/SIGTERM with forced connection close after a timeout.
 *
 * This is the TS replacement for the old index.js + server.js pair.
 */
import { loadGatewayConfig } from "./config/index.js";
import { parseChains } from "./orchestrator/parser.js";
import { makeLlamaServerProvider } from "./providers/llama-server.js";
import { createApp } from "./server.js";

// ── Config ──
const config = loadGatewayConfig();
console.log(`[gateway] config loaded: ${Object.keys(config.chains).length} chains`);

// ── Parse chains (fails fast on invalid config) ──
const chains = parseChains(config);

// ── Providers ──
const providers = new Map([
  ["llama-server", makeLlamaServerProvider(config.llamaServer)],
]);

// ── Express app ──
const app = createApp({ config, chains, providers });

// ── Listen ──
const server = app.listen(config.server.port, config.server.host, () => {
  console.log(
    `[gateway] OpenAI-compatible API listening on http://${config.server.host}:${config.server.port}`,
  );
  console.log(
    `[gateway] virtual models: ${[...chains.keys()].map((n) => `gateway/${n}`).join(", ")}`,
  );
});

// ── Graceful shutdown ──
let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[gateway] shutting down (${reason})`);

  const forceClose = setTimeout(() => {
    server.closeAllConnections?.();
  }, 3000);
  forceClose.unref();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

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
