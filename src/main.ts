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
  const server = await createWebServer({ config, logger });

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

  return { server, db, logger, appData, coldStartMs, coldStartOk: ok };
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
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `fatal boot error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}