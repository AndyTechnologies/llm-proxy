/**
 * Health fetch handler (S2.3 + S3.1 — Bun.serve migration + live/ready).
 *
 * Routes three health endpoints by pathname:
 *  - GET /health       → legacy aggregate (backend state, pid, models, chains)
 *  - GET /health/live  → 200 {"status":"alive"} whenever the process is up,
 *                        regardless of backend state (liveness, Req 1)
 *  - GET /health/ready → 200 {"status":"ready","backend":{...}} iff the
 *                        managed backend state === "running", else 503 with
 *                        {"status":"unavailable","backend":{state}} (Req 2)
 *
 * The legacy /health aggregate shape is preserved unchanged (Req 3).
 */
import type { GatewayConfig } from "../config/schema.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface HealthRouteDeps {
  config: GatewayConfig;
  chains: Map<string, ParsedChain>;
  manager: LlamaServeManager;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Legacy GET /health aggregate — preserved for existing consumers. */
function aggregateBody(deps: HealthRouteDeps): Record<string, unknown> {
  const backend = deps.manager.status();
  return {
    status: "ok",
    chains: Object.keys(deps.config.chains),
    defaultChain: deps.config.defaultChain ?? null,
    backend: {
      state: backend.state,
      pid: backend.pid,
      models: backend.models,
    },
  };
}

export function createHealthHandler(deps: HealthRouteDeps) {
  return (req: Request): Response => {
    const { pathname } = new URL(req.url);

    if (pathname === "/health/live") {
      return new Response(
        JSON.stringify({ status: "alive" }),
        { status: 200, headers: JSON_HEADERS },
      );
    }

    if (pathname === "/health/ready") {
      const state = deps.manager.status().state;
      const ready = state === "running";
      return new Response(
        JSON.stringify(
          ready
            ? { status: "ready", backend: { state } }
            : { status: "unavailable", backend: { state } },
        ),
        { status: ready ? 200 : 503, headers: JSON_HEADERS },
      );
    }

    // Legacy aggregate (also the fallback for any other /health* route).
    return new Response(JSON.stringify(aggregateBody(deps)), {
      status: 200,
      headers: JSON_HEADERS,
    });
  };
}
