/**
 * GET /health route handler.
 *
 * Returns a simple health-check response. No dependency on the backend
 * being reachable — this endpoint confirms the gateway process is alive
 * and its config loaded successfully.
 */
import type { Request, Response } from "express";
import type { GatewayConfig } from "../config/schema.js";
import type { ParsedChain } from "../orchestrator/parser.js";

export interface HealthRouteDeps {
  config: GatewayConfig;
  chains: Map<string, ParsedChain>;
}

export function createHealthHandler(deps: HealthRouteDeps) {
  return (_req: Request, res: Response): void => {
    res.json({
      status: "ok",
      chains: Object.keys(deps.config.chains),
      defaultChain: deps.config.defaultChain ?? null,
      llamaServer: `http://${deps.config.llamaServer.host}:${deps.config.llamaServer.port}`,
    });
  };
}
