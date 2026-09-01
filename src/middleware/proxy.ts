/**
 * Passthrough forwarder for single-hop `/v1/*` requests.
 *
 * For requests that do NOT match a `gateway/<chain>` model prefix or an
 * `X-Chain-ID` header, the request is forwarded verbatim to the llama-server
 * backend. The target URL is derived DYNAMICALLY from the manager's status
 * (which reflects the running backend's actual host:port) — never from
 * the request body (SSRF guard).
 *
 * WHY `fetch` instead of http-proxy-middleware (deviation from design.md):
 * the app-level `express.json()` consumes the request body stream before any
 * route handler runs. http-proxy-middleware could no longer forward the body
 * (POST requests hung; GET worked), so the passthrough re-serializes the
 * already-parsed `req.body` and streams the upstream response back — the same
 * pattern the chain engine already uses successfully. SSE chunking, abort
 * propagation, and connection handling are preserved without a proxy library.
 */
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";

/** fetch()'s Response type (shadowed by Express's Response import above). */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** Passthrough middleware signature (same shape as an Express middleware). */
export type PassthroughHandler = (
  req: Request,
  res: Response,
  next?: (err?: unknown) => void,
) => Promise<void>;

/** Hop-by-hop headers that must never be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Build a client-side header set from the incoming request headers,
 * excluding hop-by-hop and transport-level headers.
 */
function forwardHeaders(
  headers: IncomingHttpHeaders,
  hasBody: boolean,
): Headers {
  const out = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host" || lower === "content-length") continue;
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const v of value) out.append(name, v);
    } else {
      out.append(name, value);
    }
  }

  if (hasBody && !out.has("content-type")) {
    out.set("content-type", "application/json");
  }

  return out;
}

/**
 * Create a passthrough forwarder that targets the managed backend dynamically.
 *
 * @param getBaseUrl  Dynamic getter — reads from manager.status().baseUrl
 * @param requestTimeoutMs  Timeout for upstream requests
 */
export function createPassthroughProxy(
  getBaseUrl: () => string,
  requestTimeoutMs: number,
): PassthroughHandler {
  return async (req, res) => {
    const baseUrl = getBaseUrl();

    if (!baseUrl) {
      res.status(503).json({
        error: {
          message: "Backend not available",
          type: "server_error",
          param: null,
          code: "backend_unavailable",
        },
      });
      return;
    }

    // ── Build target URL, preserving path + query ──
    const originalUrl = req.originalUrl ?? req.url ?? "/";
    const queryIndex = originalUrl.indexOf("?");
    const pathname = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
    const search = queryIndex >= 0 ? originalUrl.slice(queryIndex) : "";

    const target = new URL(pathname, baseUrl);
    target.search = search;

    // ── Abort: client disconnect OR hard timeout ──
    const controller = new AbortController();
    const onClientClose = () => controller.abort();
    res.on("close", onClientClose);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    const hasBody = req.body !== undefined && req.body !== null;

    let upstream: FetchResponse;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: forwardHeaders(req.headers, hasBody),
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timeout);
      res.removeListener("close", onClientClose);

      // Client went away or timed out — nothing sensible to write.
      if (controller.signal.aborted || res.destroyed || res.writableEnded) {
        return;
      }

      console.error("[proxy] upstream error:", (err as Error).message);
      res.status(502).json({
        error: {
          message: `Upstream error: ${(err as Error).message}`,
          type: "server_error",
          param: null,
          code: "upstream_error",
        },
      });
      return;
    }

    // ── Forward status + non-hop-by-hop headers ──
    res.status(upstream.status);
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
      res.setHeader(name, value);
    }

    const cleanup = () => {
      clearTimeout(timeout);
      res.removeListener("close", onClientClose);
    };

    if (!upstream.body) {
      cleanup();
      res.end();
      return;
    }

    // ── Stream the upstream body (SSE or JSON) unbuffered ──
    const upstreamStream = Readable.fromWeb(
      upstream.body as import("node:stream/web").ReadableStream,
    );
    upstreamStream.on("error", () => {
      cleanup();
      if (!res.writableEnded) {
        res.destroy();
      }
    });
    upstreamStream.on("end", cleanup);
    res.on("finish", cleanup);
    upstreamStream.pipe(res);
  };
}