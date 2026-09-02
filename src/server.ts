/**
 * Bun.serve application factory (S2.3 — createApp → Bun.serve fetch handler).
 *
 * Replaces the Express app with a single fetch handler mounted on Bun.serve.
 * Middleware and routes are plain functions returning Response:
 *  1. Security headers (manual, replaces helmet — gateway-security Req 1)
 *  2. JSON body handling (via Request)
 *  3. CORS (optional, from config)
 *  4. Auth guard (optional Bearer)
 *  5. Route handlers (health, models; chat/completions SSE → S2b)
 *  6. Error normalization (OpenAI envelope)
 *
 * SLICE BOUNDARY: GET /health and GET /v1/models are fully wired in S2a.
 * POST /v1/chat/completions and POST /v1/completions (SSE) are migrated in
 * S2b and return 501 here so the slice stays autonomous and behavior is
 * restored by the following chained PR.
 */
import type { GatewayConfig } from "./config/schema.js";
import type { ParsedChain } from "./orchestrator/parser.js";
import type { Provider } from "./providers/types.js";
import type { LlamaServeManager } from "./backend/manager.js";
import { errorHandler, securityHeaders } from "./middleware/errors.js";
import { authGuard } from "./middleware/auth.js";
import { createModelsHandler } from "./routes/models.js";
import { createHealthHandler } from "./routes/health.js";

export interface ServerDeps {
  config: GatewayConfig;
  chains: Map<string, ParsedChain>;
  providers: Map<string, Provider>;
  manager: LlamaServeManager;
}

/** CORS headers for allowed origins. */
function corsHeaders(deps: ServerDeps): Record<string, string> {
  const origins = deps.config.server.corsOrigins;
  if (origins && origins !== "*") {
    const origin = Array.isArray(origins) ? origins[0] : origins;
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Chain-ID",
    };
  }
  return {};
}

/**
 * Create a fetch handler for Bun.serve.
 *
 * @returns a `(req: Request) => Response | Promise<Response>` handler.
 */
export function createApp(deps: ServerDeps): (req: Request) => Promise<Response> {
  const modelsHandler = createModelsHandler({
    chains: deps.chains,
    manager: deps.manager,
  });
  const healthHandler = createHealthHandler({
    config: deps.config,
    chains: deps.chains,
    manager: deps.manager,
  });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // ── CORS preflight ──
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(deps),
      });
    }

    // ── Auth guard (optional Bearer) ──
    const denied = authGuard(req);
    if (denied) return denied;

    try {
      // ── GET /health (aggregate — preserved) ──
      if (req.method === "GET" && url.pathname === "/health") {
        return withSecurity(corsHeaders(deps), healthHandler(req));
      }

      // ── GET /v1/models ──
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return withSecurity(corsHeaders(deps), modelsHandler(req));
      }

      // ── SSE streaming routes: migrated in S2b ──
      if (
        (req.method === "POST" &&
          (url.pathname === "/v1/chat/completions" ||
            url.pathname === "/v1/completions"))
      ) {
        return withSecurity(
          corsHeaders(deps),
          new Response(
            JSON.stringify({
              error: {
                message: "SSE endpoints are migrated in the S2b slice",
                type: "server_error",
                param: null,
                code: null,
              },
            }),
            {
              status: 501,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      // ── Unknown route ──
      return withSecurity(
        corsHeaders(deps),
        new Response(
          JSON.stringify({
            error: {
              message: "Not found",
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      );
    } catch (err) {
      return errorHandler(err as Error & { status?: number });
    }
  };
}

/** Merge CORS + security headers into the given Response. */
function withSecurity(
  cors: Record<string, string>,
  response: Response,
): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) {
    if (!merged.has(name)) merged.set(name, value);
  }
  for (const [name, value] of Object.entries(cors)) {
    if (!merged.has(name)) merged.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}