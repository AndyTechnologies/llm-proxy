import { join } from "node:path";
import { type AppConfig } from "./types.js";

export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = "127.0.0.1";

export interface AppEnv {
  WEAVELLM_PORT?: string;
  WEAVELLM_HOST?: string;
  WEAVELLM_AUTH?: string;
  WEAVELLM_APP_DATA?: string;
  WEAVELLM_UI_DIR?: string;
  /** Path to the llama-server binary (default "llama" on PATH). */
  WEAVELLM_LLAMA_BIN?: string;
}

/** Parse a port string; non-numeric/invalid values fall back to the default. */
export function resolvePort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

/** Resolve the llama-server binary path; empty string falls back to "llama". */
export function resolveLlamaBin(raw: string | undefined): string {
  return raw === undefined || raw === "" ? "llama" : raw;
}

/** Resolve the app runtime config from the environment (loopback by default). */
export function resolveAppConfig(env: AppEnv = {}): AppConfig {
  return {
    host: env.WEAVELLM_HOST ?? DEFAULT_HOST,
    port: resolvePort(env.WEAVELLM_PORT),
    authEnabled: env.WEAVELLM_AUTH === "1" || env.WEAVELLM_AUTH === "true",
    appData: env.WEAVELLM_APP_DATA ?? "",
    // Compiled frontend output; the env var allows pointing elsewhere.
    uiDir: env.WEAVELLM_UI_DIR ?? join(process.cwd(), "frontend", "dist"),
    llamaBin: resolveLlamaBin(env.WEAVELLM_LLAMA_BIN),
  };
}