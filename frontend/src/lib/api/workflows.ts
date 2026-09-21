/**
 * Typed client for the workflow CRUD + run + logs surface (NO auth gate —
 * the workflows branch is intentionally open on the backend).
 *
 * Real backend surface (src/routes/api.ts, workflows branch):
 *   GET    /api/workflows               → WorkflowRecord[]
 *   GET    /api/workflows/:name         → WorkflowWithYaml | 404 not_found
 *   PUT    /api/workflows/:name         → YAML text body → SaveWorkflowResult | 400
 *   DELETE /api/workflows/:name         → 204 | 404
 *   POST   /api/workflows/:name/run     → OpenAI chat body → ChainCompletion | 400/404/502
 *   GET    /api/workflows/:name/logs    → ExecutionLogRow[] | 404
 *
 * The PUT body is RAW YAML TEXT (not JSON) — `saveWorkflow` sends YAML via
 * the http layer's rawBody path, exactly like the backend reads req.text().
 */

import { request } from "./http.js";
import type {
  ExecutionLogRow,
  RunWorkflowResult,
  SaveWorkflowResult,
  WorkflowRecord,
  WorkflowWithYaml,
} from "./types.js";

export interface WorkflowOptions {
  origin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** GET /api/workflows → metadata rows. */
export async function listWorkflows(options: WorkflowOptions = {}): Promise<WorkflowRecord[]> {
  return request<WorkflowRecord[]>("/api/workflows", { method: "GET", ...options });
}

/** GET /api/workflows/:name → {name,version,updatedAt,yaml} | throws 404. */
export async function getWorkflow(name: string, options: WorkflowOptions = {}): Promise<WorkflowWithYaml> {
  return request<WorkflowWithYaml>(`/api/workflows/${encodeURIComponent(name)}`, {
    method: "GET",
    ...options,
  });
}

/** PUT /api/workflows/:name — raw YAML text body → {ok,name,version}. */
export async function saveWorkflow(
  name: string,
  yaml: string,
  options: WorkflowOptions = {},
): Promise<SaveWorkflowResult> {
  return request<SaveWorkflowResult>(`/api/workflows/${encodeURIComponent(name)}`, {
    method: "PUT",
    rawBody: yaml,
    rawBodyType: "application/x-yaml",
    ...options,
  });
}

/** DELETE /api/workflows/:name → 204; throws 404. */
export async function deleteWorkflow(name: string, options: WorkflowOptions = {}): Promise<void> {
  return request<void>(`/api/workflows/${encodeURIComponent(name)}`, {
    method: "DELETE",
    ...options,
  });
}

/** POST /api/workflows/:name/run — OpenAI chat messages → completion. */
export async function runWorkflow(
  name: string,
  messages: { role: string; content: string }[],
  options: WorkflowOptions = {},
): Promise<RunWorkflowResult> {
  return request<RunWorkflowResult>(`/api/workflows/${encodeURIComponent(name)}/run`, {
    method: "POST",
    jsonBody: { messages },
    ...options,
  });
}

/** GET /api/workflows/:name/logs → execution history rows. */
export async function workflowLogs(name: string, options: WorkflowOptions = {}): Promise<ExecutionLogRow[]> {
  return request<ExecutionLogRow[]>(`/api/workflows/${encodeURIComponent(name)}/logs`, {
    method: "GET",
    ...options,
  });
}
