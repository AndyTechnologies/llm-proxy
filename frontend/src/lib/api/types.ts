/**
 * Shared wire types for the console API, mirroring the REAL backend shapes
 * (verbatim field-by-field from src/backend/hub.ts, src/orchestrator/store.ts
 * and src/routes/api.ts). No invented fields — this layer types exactly the
 * /api surface the server serves.
 */

/** GET /api/health → backend health (liveness; no auth). */
export interface HealthStatus {
  status: "ok";
  /** ids of locally-managed models, only when a hub is wired. */
  localModels?: string[];
}

/** GET /api/models / GET /api/models/:id (hub registry; auth-gated). */
export interface ModelStatus {
  id: string;
  state: "active" | "disabled" | "error";
  pid?: number;
  port?: number;
  error?: string;
}

/** POST /api/models/:id/activate → activation affordance. */
export interface ActivateModelResponse {
  state: "active";
  pid: number;
  port: number;
}

/** POST /api/models/:id/deactivate → {state:"disabled"}. */
export interface DeactivateModelResponse {
  state: "disabled";
}

/** GET /api/workflows → workflow metadata rows. */
export interface WorkflowRecord {
  name: string;
  version: number;
  updatedAt: string;
}

/** GET /api/workflows/:name → record + canonical YAML. */
export interface WorkflowWithYaml extends WorkflowRecord {
  yaml: string;
}

/** PUT /api/workflows/:name → accepted envelope. */
export interface SaveWorkflowResult {
  ok: true;
  name: string;
  version: number;
}

/** POST /api/workflows/:name/run → the runner's completion output. */
export interface RunWorkflowResult {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }>;
  usage: null;
}

/** GET /api/workflows/:name/logs → execution history rows. */
export interface ExecutionLogRow {
  id: string;
  workflowId: string;
  status: "ok" | "error";
  error: string | null;
  startedAt: string;
  ms: number | null;
}

/** Backend error envelope → thrown as ApiError(status, message, errors?). */
export interface ApiErrorEnvelope {
  error: string;
  errors?: unknown;
}
