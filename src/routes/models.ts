/**
 * GET /v1/models route handler.
 *
 * Returns the list of available models: real models from the llama-server
 * backend PLUS virtual chain models. Virtual models use the `gateway/<name>`
 * id pattern and are tagged with `owned_by: "gateway"` (virtual-model-routing
 * spec Req 3).
 *
 * Real model discovery hits the backend's /v1/models endpoint; if it fails,
 * we return only virtual models so the gateway stays usable.
 */
import type { Request, Response } from "express";
import type { ModelInfo, ModelListResponse } from "../types/openai.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServerConfig } from "../config/schema.js";

export interface ModelsRouteDeps {
  chains: Map<string, ParsedChain>;
  llamaServer: LlamaServerConfig;
}

export function createModelsHandler(deps: ModelsRouteDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
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

    // ── Real models from llama-server backend ──
    try {
      const target = `http://${deps.llamaServer.host}:${deps.llamaServer.port}`;
      const response = await fetch(`${target}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const body = (await response.json()) as { data?: Array<{ id: string }> };
        if (Array.isArray(body.data)) {
          for (const m of body.data) {
            data.push({
              id: m.id,
              object: "model",
              created: now,
              owned_by: "llama-server",
            });
          }
        }
      }
    } catch {
      // Backend may not be running — return virtual models only.
      console.warn("[models] could not reach llama-server for model list");
    }

    const response: ModelListResponse = { object: "list", data };
    res.json(response);
  };
}
