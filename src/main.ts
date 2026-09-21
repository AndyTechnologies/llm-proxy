/**
 * WeaveLLM main process (Electrobun `build.mainProcess: "bun"` entrypoint).
 * Boot order: appData → DB schema → config → proxy server (+cold-start
 * measure) → background update check (offline silent).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openAppDataDatabase } from "./db/schema.js";
import { resolveAppConfig } from "./app/config.js";
import { createWebServer } from "./app/server.js";
import { jsonLogger, type AppLogger } from "./app/types.js";
import { checkForUpdate, type UpdateCheckResult } from "./app/update.js";
import { measureColdStart, coldStartOk } from "./app/startup.js";
import { SecretStore, platformKeychainBackend } from "./secrets/keychain.js";
import { buildProviderRegistry } from "./providers/registry.js";
import { makeV1Handler } from "./routes/v1.js";
import { makeApiHandler } from "./routes/api.js";
import { makeAuthGate } from "./routes/auth.js";
import { WorkflowStore } from "./orchestrator/store.js";
import { makeRuntimeServices, makeWorkflowRunner } from "./orchestrator/runner.js";
import { LocalBackendHub } from "./backend/hub.js";
import { runSandbox } from "./sandbox/runner.js";
import { makeWsHub } from "./app/ws.js";

export const APP_VERSION = "0.1.0";
export const UPDATE_CHANNEL = "stable";

/** Default appData directory per platform (macOS vs Linux conventions). */
export function resolveAppDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.WEAVELLM_APP_DATA) return env.WEAVELLM_APP_DATA;
  const home = env.HOME ?? homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "weavellm");
  }
  const xdg = env.XDG_DATA_HOME;
  return xdg ? join(xdg, "weavellm") : join(home, ".local", "share", "weavellm");
}

export interface BootResult {
  server: Awaited<ReturnType<typeof createWebServer>>;
  db: ReturnType<typeof openAppDataDatabase>;
  logger: AppLogger;
  appData: string;
  coldStartMs: number;
  coldStartOk: boolean;
  /** Graceful teardown: drain + stop the local backend hub, then the server. */
  shutdown: () => Promise<void>;
}

/** Boot the full WeaveLLM main process; returns the live handles. */
export async function boot(env: Record<string, string | undefined> = process.env): Promise<BootResult> {
  const startMark = performance.now();
  const appData = resolveAppDataDir(env);
  mkdirSync(join(appData, "logs"), { recursive: true });
  mkdirSync(join(appData, "models"), { recursive: true });
  mkdirSync(join(appData, "sandbox"), { recursive: true });

  const logger = jsonLogger((line) => process.stdout.write(`${line}\n`));
  const db = openAppDataDatabase(appData);
  const config = resolveAppConfig(env);

  // Keychain-backed secrets → external provider adapters → OpenAI-compatible
  // /v1 proxy on port 4317. Auth (WEAVELLM_AUTH) is off by default.
  const secretStore = new SecretStore(db, platformKeychainBackend());
  const registry = await buildProviderRegistry({ db, store: secretStore });

  // Managed local backend: catalog models → llama-server lifecycle. The hub
  // gates /v1 local ids on readiness and its restoreActive() must complete
  // BEFORE the HTTP server starts (arch-plan Decision 2): active models are
  // back up before a single request can arrive.
  const hub = new LocalBackendHub({
    db,
    binary: config.llamaBin,
    // Preflight fail-fast (old/unparseable llama.cpp) must reach the boot log.
    log: (msg) => logger("error", "local-backend", { message: msg }),
  });
  await hub.preflight();
  await hub.restoreActive();

  // Workflow runtime: stored graphs → engine services → gateway/<name>
  // virtual models + the /api workflow surface. The managed llama-server
  // backend answers `localProvider`; until a model is activated the local
  // ids do not resolve and answer the 404 envelope.
  const store = new WorkflowStore(db);
  const services = makeRuntimeServices({
    registry,
    localProvider: () => hub.localProvider(),
    localModels: () => hub.localModels(),
    store,
    sandbox: (code, input, _opts) =>
      runSandbox(code, { input: JSON.stringify(input ?? null) }),
    embedder: () => hub.embedder(),
    chunks: () => null,
    memory: () => null,
  });
  const workflowRunner = makeWorkflowRunner({ store, services });
  const authGate = makeAuthGate({ enabled: config.authEnabled, store: secretStore });
  const api = makeApiHandler({
    store,
    runner: workflowRunner,
    hub,
    auth: authGate,
  });
  const v1 = makeV1Handler({
    registry,
    localProvider: () => hub.localProvider(),
    localModels: () => hub.localModels(),
    embeddings: () => hub.embedder(),
    chainRunner: workflowRunner,
    auth: authGate,
  });
  const server = await createWebServer({
    config,
    logger,
    v1,
    api,
    localModels: () => hub.localModels(),
    ws: makeWsHub({ runner: workflowRunner }),
  });

  // Background update check — never blocks boot; offline is silent.
  void checkForUpdate({
    fetcher: (url) => fetch(url),
    currentVersion: APP_VERSION,
    channel: UPDATE_CHANNEL,
  })
    .then((result) => {
      setUpdateState(result);
      logger("info", "update-check", {
        available: result.available,
        offline: result.offline,
        version: result.version,
      });
    })
    .catch(() => {
      setUpdateState({ available: false, offline: true });
    });

  await server.start();

  const coldStartMs = measureColdStart(startMark);
  const ok = coldStartOk(coldStartMs);
  logger("info", "boot", {
    appData,
    host: config.host,
    port: server.port,
    coldStartMs: Math.round(coldStartMs),
    coldStartBudgetOk: ok,
  });

  return {
    server,
    db,
    logger,
    appData,
    coldStartMs,
    coldStartOk: ok,
    shutdown: async () => {
      await hub.stopAll();
      await server.stop();
    },
  };
}

/** Renderer-visible update state (consent UI reads it via /api/update). */
function setUpdateState(result: UpdateCheckResult): void {
  (globalThis as typeof globalThis & { __WEAVELLM_UPDATE__?: UpdateCheckResult })
    .__WEAVELLM_UPDATE__ = result;
}

// Electrobun webview + direct `bun run src/main.ts` both enter here.
if (import.meta.main) {
  boot()
    .then((result) => {
      if (!result.coldStartOk) {
        result.logger("warn", "cold-start-budget-exceeded", {
          coldStartMs: Math.round(result.coldStartMs),
        });
      }
      // Graceful teardown: drain in-flight work + stop llama-server children
      // before exiting on SIGINT/SIGTERM.
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
          void result
            .shutdown()
            .then(() => process.exit(0))
            .catch((err: unknown) => {
              process.stderr.write(
                `shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
              );
              process.exit(1);
            });
        });
      }

      // Desktop shell: open the webview window when the main process runs
      // inside an Electrobun bundle (direct `bun run src/main.ts` stays
      // server-only — the `electrobun` npm stub throws outside a bundle).
      void import("electrobun/main")
        .then(({ BrowserWindow }) => {
          new BrowserWindow({
            title: "WeaveLLM",
            url: `http://127.0.0.1:${result.server.port}/`,
          });
        })
        .catch(() => {
          // Not running under Electrobun — no window.
        });
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `fatal boot error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}