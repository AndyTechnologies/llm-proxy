/**
 * REST service for the dashboard views (svelte-ui task 3.1).
 *
 * Thin typed wrappers around every `/api/ui/*` endpoint the views consume.
 * Non-2xx responses surface as a typed `ApiError` carrying the backend's
 * error envelope (`{ error: { message, type, code } }`) when present.
 */
import type { PipelineSummary, PipelineDetail, ModelsResponse, LifecycleConfig, ExecutionEntry, AgentEntry } from "../stores/types.js";
import type { GraphNode, GraphEdge } from "../lib/graph-model.js";

/** Typed error from a non-2xx /api/ui/* response. */
export class ApiError extends Error {
  status: number;
  type: string | null;

  constructor(status: number, message: string, type: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
  }
}

export interface RetryStepResult {
  success: boolean;
  retryExecutionId?: string;
}

export interface RestService {
  listPipelines(): Promise<PipelineSummary[]>;
  getPipeline(id: string): Promise<PipelineDetail>;
  listModels(): Promise<ModelsResponse>;
  getConfig(): Promise<LifecycleConfig>;
  applyConfig(config: unknown): Promise<unknown>;
  unloadModel(id: string): Promise<{ unloaded: boolean; modelId: string }>;
  unloadAllModels(): Promise<{ unloaded: number }>;
  listExecutions(limit?: number): Promise<ExecutionEntry[]>;
  validatePipeline(id: string, payload: { nodes: GraphNode[]; edges: GraphEdge[] }): Promise<{ valid: boolean; errors?: string[] }>;
  retryStep(executionId: string, nodeId: string): Promise<RetryStepResult>;
  agentsStatus(): Promise<AgentEntry[]>;
  configureAgent(config: unknown): Promise<unknown>;
}

export function createRestService(base = ""): RestService {
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      let type: string | null = null;
      try {
        const body = (await res.json()) as { error?: { message?: string; type?: string } };
        if (body.error?.message) message = body.error.message;
        if (body.error?.type) type = body.error.type;
      } catch {
        // Body is not a JSON envelope — keep the generic message.
      }
      throw new ApiError(res.status, message, type);
    }
    return (await res.json()) as T;
  };

  const post = <T>(path: string, body?: unknown): Promise<T> =>
    api<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });

  const encode = (segment: string): string => encodeURIComponent(segment);

  return {
    listPipelines: () => api<PipelineSummary[]>("/api/ui/pipelines"),
    getPipeline: (id) => api<PipelineDetail>(`/api/ui/pipelines/${encode(id)}`),
    listModels: () => api<ModelsResponse>("/api/ui/models"),
    getConfig: () => api<LifecycleConfig>("/api/ui/config"),
    applyConfig: (config) => post("/api/ui/apply", { config }),
    unloadModel: (id) => post(`/api/ui/models/${encode(id)}/unload`),
    unloadAllModels: () => post("/api/ui/models/unload-all"),
    listExecutions: (limit) => {
      const qs = limit !== undefined ? `?limit=${limit}` : "";
      return api<ExecutionEntry[]>(`/api/ui/executions${qs}`);
    },
    validatePipeline: (id, payload) => post(`/api/ui/pipelines/${encode(id)}/validate`, payload),
    retryStep: (executionId, nodeId) =>
      post<RetryStepResult>(`/api/ui/executions/${encode(executionId)}/steps/${encode(nodeId)}/retry`),
    agentsStatus: () => api<AgentEntry[]>("/api/ui/agents/status"),
    configureAgent: (config) => post("/api/ui/agents/configure", config),
  };
}