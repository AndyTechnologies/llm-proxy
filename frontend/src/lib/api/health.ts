/**
 * Typed client for the health surface.
 *
 *   GET /api/health → HealthStatus (liveness; NO auth gate — the probe the
 *   console polls freely at boot and on the status bar).
 */

import { request } from "./http.js";
import type { HealthStatus } from "./types.js";

export interface HealthOptions {
  origin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** GET /api/health → {status:"ok", localModels?}. */
export async function getHealth(options: HealthOptions = {}): Promise<HealthStatus> {
  return request<HealthStatus>("/api/health", { method: "GET", ...options });
}
