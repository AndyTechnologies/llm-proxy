import type { AppConfig, AppLogger } from "./types.js";
import type { WsHub, WsSocketData } from "./ws.js";
import { serveStaticUi } from "./static-ui.js";

/**
 * Optional OpenAI-compatible /v1 dispatcher (external-proxy): returns a
 * Response for /v1 paths it owns, or null to decline (the server then 404s).
 * Absent by default so the app server stays API-only until wired at boot.
 */
export type V1Dispatcher = (req: Request) => Promise<Response | null>;

/**
 * Optional /api dispatcher (workflow CRUD + runs): returns a Response for
 * /api paths it owns, or null to decline (the server then 404s).
 */
export type ApiDispatcher = (req: Request) => Promise<Response | null>;

export interface ServerDeps {
  config: AppConfig;
  logger: AppLogger;
  /** Wire the /v1 OpenAI-compatible surface (port 4317) when provided. */
  v1?: V1Dispatcher;
  /** Wire the /api workflow surface when provided. */
  api?: ApiDispatcher;
  /** Wire the /ws websocket streaming surface when provided. */
  ws?: WsHub;
  /**
   * Local model ids for /api/health (`localModels` field); omitted when the
   * hub is not wired (legacy health shape preserved).
   */
  localModels?: () => string[];
}

export interface WebServer {
  /** Pure fetch handler — callable without a listening socket (tests). */
  fetch: (req: Request) => Promise<Response>;
  /** Start listening (port 0 → ephemeral). Resolves when the socket is up. */
  start: () => Promise<void>;
  /** Graceful stop: closes the socket, drains in-flight requests. */
  stop: () => Promise<void>;
  hostname: string;
  port: number;
}

/** JSON envelope for unknown /api routes. */
function notFound(): Response {
  return Response.json({ error: { message: "Not found", type: "invalid_request_error" } }, { status: 404 });
}

/**
 * Build the fetch handler (pure — no socket). Every request emits one JSON
 * log line carrying method/path/status, matching the JSON-lines log style.
 */
export function buildFetchHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let res: Response;
    if (req.method === "GET" && url.pathname === "/api/health") {
      const body: Record<string, unknown> = { status: "ok" };
      if (deps.localModels !== undefined) body.localModels = deps.localModels();
      res = Response.json(body);
    } else if (deps.api !== undefined && url.pathname.startsWith("/api/")) {
      const apires = await deps.api(req);
      res = apires ?? notFound();
    } else if (deps.v1 !== undefined && url.pathname.startsWith("/v1/")) {
      const v1res = await deps.v1(req);
      res = v1res ?? notFound();
    } else if (
      deps.config.uiDir !== undefined &&
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/v1/")
    ) {
      // Compiled UI (index.html + _astro assets). API namespaces stay
      // API-only when their dispatcher is not wired (partial boots, tests):
      // never mask an API 404 with SPA HTML. The helper declines unsafe
      // paths, missing assets and non-GET/HEAD methods → 404 envelope.
      const uiRes = await serveStaticUi(deps.config.uiDir, url.pathname, req.method);
      res = uiRes ?? notFound();
    } else {
      res = notFound();
    }
    deps.logger("info", "request", {
      method: req.method,
      path: url.pathname,
      status: res.status,
    });
    return res;
  };
}

/**
 * Bun.serve-based app server: JSON logs, loopback bind by default, graceful
 * shutdown with in-flight drain. Port 0 selects an ephemeral port.
 */
export async function createWebServer(deps: ServerDeps): Promise<WebServer> {
  const handler = buildFetchHandler(deps);
  const inFlight = new Set<Promise<Response>>();
  let draining = false;

  const wrap = (req: Request): Promise<Response> => {
    const p = handler(req);
    if (draining) {
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    }
    return p;
  };

  const server = Bun.serve<WsSocketData>({
    hostname: deps.config.host,
    port: deps.config.port,
    fetch: (req: Request, srv) => {
      if (deps.ws !== undefined && new URL(req.url).pathname === "/ws") {
        if (deps.ws.upgrade(req, srv)) return undefined;
        const res = new Response("WebSocket upgrade required", { status: 426 });
        deps.logger("info", "request", { method: req.method, path: "/ws", status: 426 });
        return res;
      }
      return wrap(req);
    },
    websocket: {
      open: (ws) => deps.ws && deps.ws.open(ws),
      message: (ws, raw) => deps.ws && deps.ws.message(ws, raw),
      close: (ws) => deps.ws && deps.ws.close(ws),
    },
  });

  const stop = async (): Promise<void> => {
    draining = true;
    // Closing the socket tears down live websockets; their close handlers
    // abort in-flight runs.
    server.stop();
    await Promise.allSettled([...inFlight]);
  };

  return {
    fetch: handler,
    start: async () => {
      // Bun.serve already bound the socket in construction.
      deps.logger("info", "listening", {
        host: deps.config.host,
        port: server.port,
      });
    },
    stop,
    hostname: server.hostname ?? deps.config.host,
    port: server.port ?? deps.config.port,
  };
}