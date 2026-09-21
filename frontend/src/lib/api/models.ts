/**
 * Typed client for the model-management surface (auth-gated on the backend
 * through the optional `auth` gate — 401 {error:"unauthorized"} when the
 * console has no valid bearer token).
 *
 * Real backend surface (src/routes/api.ts, models branch, hub-gated):
 *   GET    /api/models              → ModelStatus[] (registry snapshot)
 *   GET    /api/models/:id/status   → ModelStatus | 404 model_not_found
 *   POST   /api/models/:id/activate → {state,pid,port} | 400/404/503
 *   POST   /api/models/:id/deactivate → {state:"disabled"} | 404
 */

import { request } from "./http.js";
import type {
  ActivateModelResponse,
  DeactivateModelResponse,
  ModelStatus,
} from "./types.js";

export interface ModelOptions {
  origin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** GET /api/models → full registry snapshot. */
export async function listModels(options: ModelOptions = {}): Promise<ModelStatus[]> {
  return request<ModelStatus[]>("/api/models", { method: "GET", ...options });
}

/** GET /api/models/:id/status → one row; throws ApiError(404, "model_not_found"). */
export async function getModel(id: string, options: ModelOptions = {}): Promise<ModelStatus> {
  return request<ModelStatus>(`/api/models/${encodeURIComponent(id)}/status`, {
    method: "GET",
    ...options,
  });
}

/** POST /api/models/:id/activate → {state:"active",pid,port}. */
export async function activateModel(
  id: string,
  options: ModelOptions = {},
): Promise<ActivateModelResponse> {
  return request<ActivateModelResponse>(`/api/models/${encodeURIComponent(id)}/activate`, {
    method: "POST",
    ...options,
  });
}

/** POST /api/models/:id/deactivate → {state:"disabled"}. */
export async function deactivateModel(
  id: string,
  options: ModelOptions = {},
): Promise<DeactivateModelResponse> {
  return request<DeactivateModelResponse>(`/api/models/${encodeURIComponent(id)}/deactivate`, {
    method: "POST",
    ...options,
  });
}
