/**
 * GET /v1/models fetch handler (S2a — Bun.serve migration).
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
 * Converted from an Express route handler to a plain fetch handler returning
 * a Response.
 */
import type { ModelInfo, ModelListResponse } from "../types/openai.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface ModelsRouteDeps {
  chains: Map<string, ParsedChain>;
  manager: LlamaServeManager;
}

export function createModelsHandler(deps: ModelsRouteDeps) {
  return (_req: Request): Response => {
    const now = Math.floor(Date.now() / 1000);
    const data: ModelInfo[] = [];

    // ── Virtual chain models ──
    for (const [name, chain] of deps.chains) {
      data.push({
        id: `gateway/${name}`,
        object: "model",
        created: now,
        owned_by: "gateway",
        description: chain.displayName ?? name,
      });
    }

    // ── Real models from the managed backend ──
    const backendStatus = deps.manager.status();
    for (const modelId of backendStatus.models) {
      data.push({
        id: modelId,
        object: "model",
        created: now,
        owned_by: "llama-server",
      });
    }

    const response: ModelListResponse = { object: "list", data };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
