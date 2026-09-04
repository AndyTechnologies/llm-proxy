/**
 * Slice D: static `/ui` SPA serving — resolve a request pathname to a file
 * within the SPA directory, guarding against path traversal.
 *
 * The SPA is served as plain static assets (no build step). Only `uiDir`
 * files are reachable; any path that escapes the directory (via `..` or an
 * absolute path), requests a subdirectory, or names an unknown asset resolves
 * to `null` so the caller returns a non-200 (dashboard-ui Req "Static SPA
 * serving" / path-traversal scenario).
 */
export function resolveUiAsset(
  pathname: string,
  contentTypeFor: (ext: string) => string,
): { file: string; contentType: string } | null {
  // Only the `/ui` prefix is eligible.
  if (pathname !== "/ui" && !pathname.startsWith("/ui/")) return null;

  // Relative path under /ui/, normalized and traversal-safe.
  const raw = pathname === "/ui" ? "index.html" : pathname.slice("/ui/".length);

  // Reject anything that isn't a plain filename-ish path (no `..`, no leading
  // slash, no backslash) — a traversal attempt collapses to null → 4xx.
  if (raw.length === 0 || raw.includes("/") || raw.includes("\\") || raw === ".." || raw.startsWith(".")) {
    return null;
  }

  const ext = raw.includes(".") ? raw.slice(raw.lastIndexOf(".")) : "";
  return { file: raw, contentType: contentTypeFor(ext) };
}

/** Map a file extension to its MIME content-type. */
export function contentTypeFor(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html";
    case ".js":
      return "application/javascript";
    case ".css":
      return "text/css";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

/**
 * Build a safe path by joining the SPA directory with a single, already
 * traversal-checked filename segment (see `resolveUiAsset`, which never emits
 * `..`, an absolute path, or a subdirectory). Pure concatenation is safe here.
 */
function joinUIPath(dir: string, file: string): string {
  return dir.endsWith("/") ? dir + file : `${dir}/${file}`;
}

/**
 * Bun.serve application factory (createApp → Bun.serve fetch handler).
 *
 * Replaces the Express app with a single fetch handler mounted on Bun.serve.
 * Middleware and routes are plain functions returning Response:
 *  1. Security headers (manual, replaces helmet — gateway-security Req 1)
 *  2. JSON body handling (via Request)
 *  3. CORS (optional, from config)
 *  4. Auth guard (optional Bearer)
 *  5. Route handlers (health, models, chat/completions SSE)
 *  6. Error normalization (OpenAI envelope)
 *
 * Graph-only dispatch: routes resolve chains via `getGraph` from the registry.
 */
import type { GatewayConfig } from "./config/schema.js";
import type { PipelineRegistry } from "./orchestrator/registry.js";
import type { Provider } from "./providers/types.js";
import type { LlamaServeManager } from "./backend/manager.js";
import type { Server } from "bun";
import { errorHandler, securityHeaders } from "./middleware/errors.js";
import { authGuard } from "./middleware/auth.js";
import { createModelsHandler } from "./routes/models.js";
import { createHealthHandler } from "./routes/health.js";
import { createChatHandler } from "./routes/chat.js";
import { createCompletionsHandler } from "./routes/completions.js";

export interface ServerDeps {
  config: GatewayConfig;
  /**
   * Mutable graph registry — the source of truth for chain resolution.
   * Routes read graphs via `getGraph` and `listGraphs`.
   */
  registry?: PipelineRegistry;
  providers: Map<string, Provider>;
  manager: LlamaServeManager;
  /**
   * Static SPA directory (`src/ui`). When present, `/ui` serves index.html and
   * siblings as static assets with correct content types + a path-traversal
   * guard (Slice D, dashboard-ui Req "Static SPA serving").
   */
  uiDir?: string;
  /**
   * Dashboard `/api/ui/*` handler + static `/ui` route (Slice C). When present,
   * the dispatcher wires the dashboard REST/SSE branches; when absent
   * (backward-compatible tests) `/api/ui/*` returns 404.
   */
  dashboard?: {
    /**
     * The dashboard REST+SSE fetch handler (handles `/api/ui/*`). Invoked with
     * the request, the Bun.serve server handle, and the parsed URL.
     */
    handler: (
      req: Request,
      server: BunServer,
      url: URL,
    ) => Promise<Response> | Response;
  };
}

/** The Bun.serve server handle passed as the fetch handler's 2nd argument. */
type BunServer = Server<undefined>;

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
 * @returns a `(req, server) => Promise<Response>` handler. The server is used
 *   to disable the SSE idle timeout per-request on stream routes.
 */
export function createApp(
  deps: ServerDeps,
): (req: Request, server: BunServer) => Promise<Response> {
  // Graph-only dispatch: all chains resolve via the registry's getGraph.
  const getGraph = deps.registry
    ? (id: string) => deps.registry!.getGraph(id)
    : (() => undefined);

  const modelsHandler = createModelsHandler({
    graphs: deps.registry?.listGraphs() ?? [],
    manager: deps.manager,
  });
  const healthHandler = createHealthHandler({
    config: deps.config,
    manager: deps.manager,
  });
  const chatHandler = createChatHandler({
    providers: deps.providers,
    manager: deps.manager,
    requestTimeoutMs: deps.config.llama.requestTimeoutMs,
    getGraph,
  });
  const completionsHandler = createCompletionsHandler({
    providers: deps.providers,
    manager: deps.manager,
    requestTimeoutMs: deps.config.llama.requestTimeoutMs,
    getGraph,
  });

  return async (req: Request, server: BunServer): Promise<Response> => {
    const url = new URL(req.url);

    // ── CORS preflight ──
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(deps),
      });
    }

    // ── Static /ui SPA (always open — no auth) ──
    // Served BEFORE the auth guard so the dashboard is reachable even when a
    // BEARER_TOKEN protects the API. When `uiDir` is configured the SPA is
    // served as static assets with correct content types + a path-traversal
    // guard (Slice D); otherwise the route returns a 404 explaining the SPA is
    // not built (Slice C stub kept for backward-compatible boot).
    if (req.method === "GET" && (url.pathname === "/ui" || url.pathname.startsWith("/ui/"))) {
      if (deps.uiDir) {
        const asset = resolveUiAsset(url.pathname, contentTypeFor);
        if (asset) {
          const file = Bun.file(joinUIPath(deps.uiDir, asset.file));
          const exists = await file.exists();
          if (exists) {
            return withSecurity(
              corsHeaders(deps),
              new Response(file, {
                headers: { "Content-Type": asset.contentType },
              }),
            );
          }
        }
        // Path traversal, unknown asset, or subdirectory → non-200.
        return withSecurity(
          corsHeaders(deps),
          new Response(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error", param: null, code: null } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return withSecurity(
        corsHeaders(deps),
        new Response(
          JSON.stringify({
            error: {
              message: "Dashboard UI not yet built (Slice D)",
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // ── Auth guard (optional Bearer) ──
    const denied = authGuard(req);
    if (denied) return denied;

    try {
      // ── /api/ui/* dashboard REST + SSE (protected by the auth guard above) ──
      // The dashboard handler is invoked AFTER auth so `/api/ui/*` + its SSE
      // endpoint are gated whenever BEARER_TOKEN is set (dashboard-api Req
      // "Auth boundary"). When no token is set, authGuard is a no-op and
      // everything remains open.
      if (deps.dashboard && url.pathname.startsWith("/api/ui/")) {
        return withSecurity(
          corsHeaders(deps),
          await deps.dashboard.handler(req, server, url),
        );
      }

      // ── GET /health, /health/live, /health/ready (aggregate + live/ready) ──
      // S3.1: the health handler dispatches each path. /health stays the
      // legacy aggregate; /health/live and /health/ready implement liveness
      // and backend-gated readiness (health-endpoints spec Reqs 1–3).
      if (req.method === "GET") {
        if (
          url.pathname === "/health" ||
          url.pathname === "/health/live" ||
          url.pathname === "/health/ready"
        ) {
          return withSecurity(corsHeaders(deps), healthHandler(req));
        }
      }

      // ── GET /v1/models ──
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return withSecurity(corsHeaders(deps), modelsHandler(req));
      }

      // ── SSE streaming routes: chat/completions (S2b) ──
      // ADR-2: disable the idle timeout per-request so silent SSE streams are
      // never closed by the server's 10s default. Non-stream routes keep the
      // default. (Runtime-verified: `server.timeout(req,0)` in the fetch
      // handler accepts the Request and prevents the 10s idle kill.)
      if (
        req.method === "POST" &&
        (url.pathname === "/v1/chat/completions" ||
          url.pathname === "/v1/completions")
      ) {
        server.timeout(req, 0);
        const handler =
          url.pathname === "/v1/chat/completions"
            ? chatHandler
            : completionsHandler;
        return withSecurity(corsHeaders(deps), await handler(req));
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
