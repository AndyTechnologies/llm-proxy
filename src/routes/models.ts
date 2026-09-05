/**
 * GET /v1/models fetch handler (Bun.serve migration).
 *
 * Returns the list of available models: real models from the managed
 * llama-server backend PLUS virtual chain models. Virtual models use the
 * `gateway/<name>` id pattern and are tagged with `owned_by: "gateway"`
 * (virtual-model-routing spec Req 3).
 *
 * Real models come from the manager's registered model list (the config's
 * llama.models keys), which map 1:1 to the preset INI sections. The
 * gateway no longer needs to hit the backend's /v1/models endpoint because
 * the manager owns the model registry.
 *
 * Each entry carries `meta.context_length` = the EFFECTIVE context the gateway
 * configured for that model (tokens): for real models it is the per-model
 * effective value from the manager; for virtual chains it is the smallest
 * effective context among the chain's underlying backend models (an agent or
 * client asking for more would be rejected by at least one step).
 *
 * Converted from an Express route handler to a plain fetch handler returning
 * a Response.
 */
import type { ModelInfo, ModelListResponse } from "../types/openai.js";
import type { GraphPipeline } from "../orchestrator/graph.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface ModelsRouteDeps {
  graphs: GraphPipeline[];
  manager: LlamaServeManager;
  /** Resolve the EFFECTIVE context (tokens) for a model id. */
  modelContext: (id: string) => number | undefined;
}

/** Chain-level context: the smallest effective ctx among its llm_call models. */
function chainContextLength(
  graph: GraphPipeline,
  modelContext: (id: string) => number | undefined,
): number | undefined {
  let min: number | undefined;
  for (const node of graph.nodes) {
    if (node.type !== "llm_call" || node.model === undefined) continue;
    const ctx = modelContext(node.model);
    if (ctx !== undefined && (min === undefined || ctx < min)) min = ctx;
  }
  return min;
}

function withContext(
  entry: ModelInfo,
  ctx: number | undefined,
): ModelInfo {
  if (ctx !== undefined) entry.meta = { context_length: ctx };
  return entry;
}

export function createModelsHandler(deps: ModelsRouteDeps) {
  return (_req: Request): Response => {
    const now = Math.floor(Date.now() / 1000);
    const data: ModelInfo[] = [];

    // ── Virtual chain models ──
    for (const graph of deps.graphs) {
      data.push(
        withContext(
          {
            id: `gateway/${graph.id}`,
            object: "model",
            created: now,
            owned_by: "gateway",
            description: graph.name ?? graph.id,
          },
          chainContextLength(graph, deps.modelContext),
        ),
      );
    }

    // ── Real models from the managed backend ──
    const backendStatus = deps.manager.status();
    for (const modelId of backendStatus.models) {
      data.push(
        withContext(
          {
            id: modelId,
            object: "model",
            created: now,
            owned_by: "llama-server",
          },
          deps.modelContext(modelId),
        ),
      );
    }

    const response: ModelListResponse = { object: "list", data };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}