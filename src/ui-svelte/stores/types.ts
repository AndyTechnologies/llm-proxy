/**
 * Shared types for the Svelte 5 UI stores and services.
 * Framework-free: no svelte imports.
 */

/** Pipeline summary from GET /api/ui/pipelines. */
export interface PipelineSummary {
  id: string;
  displayName?: string;
  nodeCount?: number;
}

/** Pipeline detail including nodes and edges. */
export interface PipelineDetail {
  id: string;
  nodes: import("../lib/graph-model.js").GraphNode[];
  edges: import("../lib/graph-model.js").GraphEdge[];
}

/** Model entry from GET /api/ui/models. */
export interface ModelEntry {
  id: string;
  loaded?: boolean;
  processLoaded?: boolean;
  ctx?: number;
  effectiveCtx?: number;
  ggufContextLength?: number;
  hardwareMaxCtx?: number;
  lastUsed?: string;
}

/** Lifecycle data from GET /api/ui/models (lifecycle field). */
export interface LifecycleData {
  vramPolicyActive?: boolean;
  lastVramSample?: {
    usedMiB: number;
    totalMiB: number;
    at: string;
  };
  recentUnloads?: Array<{
    modelId: string;
    ok: boolean;
    reason: string;
    pid: number;
    at: string;
  }>;
}

/** Models response from GET /api/ui/models. */
export interface ModelsResponse {
  models: ModelEntry[];
  modelsDir: string;
  lifecycle?: LifecycleData;
}

/** Execution entry from GET /api/ui/executions. */
export interface ExecutionEntry {
  id: string;
  pipelineId: string;
  status: string;
  totalLatencyMs?: number;
}

/** Agent entry from GET /api/ui/agents/status. */
export interface AgentEntry {
  id: string;
  label: string;
  configPath: string;
  exists?: boolean;
  providerPresent?: boolean;
  modelCount?: number;
}

/** Config for the lifecycle backend panel from GET /api/ui/config. */
export interface LifecycleConfig {
  llama?: {
    lifecycle?: {
      ttl?: number;
      vram?: {
        mode?: string;
        freeGb?: number;
        capGb?: number;
      };
    };
  };
  [key: string]: unknown;
}

/** SSE connection state. */
export const SSE_STATE = {
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
} as const;

export type SSEState = (typeof SSE_STATE)[keyof typeof SSE_STATE];

/** All eight SSE event names. */
export const SSE_EVENTS = [
  "execution:started",
  "step:started",
  "step:completed",
  "step:failed",
  "execution:completed",
  "execution:failed",
  "pipeline:reloaded",
  "models:changed",
] as const;

export type SSEEventName = (typeof SSE_EVENTS)[number];

/** Trace entry for the debug/verbose panel. */
export interface TraceEntry {
  ts: number;
  kind: "sse" | "store" | "fetch" | "editor" | "error";
  message: string;
  detail?: unknown;
}
