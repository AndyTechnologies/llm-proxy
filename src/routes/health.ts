/**
 * GET /health route handler.
 *
 * Returns a health-check response including the managed backend state.
 * The backend section reports the real-time status from the manager:
 * state (running/stopped), pid, registered models, and base URL.
 */
import type { Request, Response } from "express";
import type { GatewayConfig } from "../config/schema.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface HealthRouteDeps {
  config: GatewayConfig;
  chains: Map<string, ParsedChain>;
  manager: LlamaServeManager;
}

export function createHealthHandler(deps: HealthRouteDeps) {
  return (_req: Request, res: Response): void => {
    const backend = deps.manager.status();
    res.json({
      status: "ok",
      chains: Object.keys(deps.config.chains),
      defaultChain: deps.config.defaultChain ?? null,
      backend: {
        state: backend.state,
        pid: backend.pid,
        models: backend.models,
      },
    });
  };
}
