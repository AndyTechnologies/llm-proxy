/** Shared app-level types for the WeaveLLM main process. */

export interface AppConfig {
  /** Bind host — loopback by default (gateway-security). */
  host: string;
  /** Proxy port — 4317 by default (external-proxy). */
  port: number;
  /** Optional external auth — OFF by default (gateway-security). */
  authEnabled: boolean;
  /** Data directory (SQLite, logs, models). */
  appData: string;
  /**
   * Directory with the compiled frontend (index.html + _astro assets). When
   * set, the server also serves the UI; undefined keeps it API-only.
   */
  uiDir?: string;
  /** llama-server binary path (WEAVELLM_LLAMA_BIN, default "llama"). */
  llamaBin: string;
}

export type LogLevel = "info" | "warn" | "error" | "fatal";

export type AppLogger = (
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
) => void;

/** Standard JSON-log sink used by the boot process. */
export function jsonLogger(write: (line: string) => void): AppLogger {
  return (level, message, meta = {}) => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }));
  };
}