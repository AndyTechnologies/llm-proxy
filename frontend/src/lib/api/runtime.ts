/**
 * Combined runtime status probe — the "is the console actually usable right
 * now?" affordance the status bar polls.
 *
 * Real backend surface (NO auth, like the whole /api surface):
 *   GET /api/health → HealthStatus        (liveness; localModels? when hub wired)
 *   GET /api/models → ModelStatus[]       (registry snapshot)
 *
 * runtimeStatus() is deliberately **non-throwing**: it runs the liveness probe
 * and, when reachable, a second probe of the models branch. A 401 (no bearer
 * token configured) is not a failure — it means `authEnabled: true` and the
 * console should prompt for a token. Transport failure ⇒ reachable:false.
 */

import { getHealth } from "./health.js";
import { request } from "./http.js";
import { ApiError } from "./http.js";
import type { HealthStatus } from "./types.js";

export interface RuntimeStatus {
  /** Liveness probe answered (any HTTP status, incl. 401). */
  reachable: boolean;
  /** GET /api/health body, present when reachable. */
  health?: HealthStatus;
  /** True when a 401 gate guards the /api/models branch (token required). */
  authEnabled: boolean;
}

/** Forwarded transport options (DI seam: origin/fetch/signal/timeout). */
export interface RuntimeStatusOptions {
  origin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Probe the runtime: health first, then (when reachable) the auth gate via
 * the models branch. Never throws — always resolves to a status object.
 */
export async function runtimeStatus(options: RuntimeStatusOptions = {}): Promise<RuntimeStatus> {
  let health: HealthStatus | undefined;
  try {
    health = await getHealth(options);
  } catch {
    return { reachable: false, authEnabled: false };
  }

  let authEnabled = false;
  try {
    await request<unknown>("/api/models", { method: "GET", ...options });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      authEnabled = true;
    }
  }
  return { reachable: true, health, authEnabled };
}
