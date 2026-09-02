/**
 * GET /health fetch handler (S2.3 — Bun.serve migration).
 *
 * Returns a health-check response including the managed backend state.
 * The backend section reports the real-time status from the manager:
 * state (running/stopped), pid, registered models, and base URL.
 *
 * Converted from an Express route handler to a plain fetch handler that
 * returns a Response (health-endpoints "Legacy health endpoint preserved").
 */
import type { GatewayConfig } from "../config/schema.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface HealthRouteDeps {
  config: GatewayConfig;
  chains: Map<string, ParsedChain>;
  manager: LlamaServeManager;
}

export function createHealthHandler(deps: HealthRouteDeps) {
  return (_req: Request): Response => {
    const backend = deps.manager.status();
    const body = {
      status: "ok",
      chains: Object.keys(deps.config.chains),
      defaultChain: deps.config.defaultChain ?? null,
      backend: {
        state: backend.state,
        pid: backend.pid,
        models: backend.models,
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
