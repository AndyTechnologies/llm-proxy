import { type AppConfig } from "./types.js";

export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = "127.0.0.1";

export interface AppEnv {
  WEAVELLM_PORT?: string;
  WEAVELLM_HOST?: string;
  WEAVELLM_AUTH?: string;
  WEAVELLM_APP_DATA?: string;
}

/** Parse a port string; non-numeric/invalid values fall back to the default. */
export function resolvePort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

/** Resolve the app runtime config from the environment (loopback by default). */
export function resolveAppConfig(env: AppEnv = {}): AppConfig {
  return {
    host: env.WEAVELLM_HOST ?? DEFAULT_HOST,
    port: resolvePort(env.WEAVELLM_PORT),
    authEnabled: env.WEAVELLM_AUTH === "1" || env.WEAVELLM_AUTH === "true",
    appData: env.WEAVELLM_APP_DATA ?? "",
  };
}