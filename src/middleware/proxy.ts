/**
 * Passthrough forwarder for single-hop `/v1/*` requests (S2a — Bun.serve).
 *
 * For requests that do NOT match a `gateway/<chain>` model prefix or an
 * `X-Chain-ID` header, the request is forwarded verbatim to the llama-server
 * backend. The target URL is derived DYNAMICALLY from the manager's status
 * (which reflects the running backend's actual host:port) — never from
 * the request body (SSRF guard).
 *
 * Converted from an Express piped response to a plain fetch handler returning
 * `new Response(upstream.body)` — the Bun-native passthrough (design.md
 * proxy/pipeline row). Hop-by-hop headers are stripped and upstream error
 * responses (503/502 etc.) are normalized to the OpenAI envelope.
 */
import type { LlamaServeManager } from "../backend/manager.js";

/** fetch()'s Response type. */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** Hop-by-hop headers that must never be forwarded. */
export const HOP_BY_HOP = new Set([
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
 * Build the upstream request's header set from the client Request headers,
 * excluding hop-by-hop and transport-level headers.
 */
export function forwardHeaders(
  headers: Headers,
  contentType: string | null,
): Headers {
  const out = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host" || lower === "content-length") continue;
    out.append(name, value);
  }
  if (contentType && !out.has("content-type")) {
    out.set("content-type", contentType);
  }
  return out;
}

/** Forward upstream response headers, stripping hop-by-hop + content-length. */
function forwardResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
    out.append(name, value);
  }
  return out;
}

/**
 * Create a passthrough forwarder that targets the managed backend dynamically.
 *
 * @param getManager  Manager to read baseUrl from dynamically
 * @param requestTimeoutMs  Timeout for upstream requests
 */
export function createPassthroughProxy(
  getManager: () => LlamaServeManager,
  requestTimeoutMs: number,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const baseUrl = getManager().status().baseUrl;

    if (!baseUrl) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Backend not available",
            type: "server_error",
            param: null,
            code: "backend_unavailable",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Build target URL, preserving path + query ──
    const url = new URL(req.url);
    const pathname = url.pathname;
    const search = url.search;
    const target = new URL(pathname, baseUrl);
    target.search = search;

    // ── Abort: client disconnect OR hard timeout ──
    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    req.signal.addEventListener("abort", onClientAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    // Re-read the body (Bun fetch already consumed it once for this handler;
    // for a passthrough we re-serialize only when a body is present).
    const contentType = req.headers.get("content-type");
    let body: ArrayBuffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.arrayBuffer();
    }

    let upstream: FetchResponse;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: forwardHeaders(req.headers, contentType),
        body,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timeout);
      req.signal.removeEventListener("abort", onClientAbort);
      if (controller.signal.aborted || req.signal.aborted) {
        // Client went away or timed out — nothing sensible to write.
        throw err;
      }
      console.error("[proxy] upstream error:", (err as Error).message);
      return new Response(
        JSON.stringify({
          error: {
            message: `Upstream error: ${(err as Error).message}`,
            type: "server_error",
            param: null,
            code: "upstream_error",
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    } finally {
      clearTimeout(timeout);
      req.signal.removeEventListener("abort", onClientAbort);
    }

    // ── Normalize upstream error responses (gateway-api normalized errors) ──
    if (!upstream.ok) {
      const upstreamBody = await upstream.text();
      let message = upstreamBody.slice(0, 500);
      try {
        const parsed = JSON.parse(upstreamBody) as {
          error?: { message?: unknown };
        };
        if (typeof parsed?.error?.message === "string") {
          message = parsed.error.message;
        }
      } catch {
        // Non-JSON upstream body — use the raw text.
      }

      const errorType =
        upstream.status === 429
          ? "rate_limit_error"
          : upstream.status >= 500
            ? "server_error"
            : "invalid_request_error";

      return new Response(
        JSON.stringify({
          error: { message, type: errorType, param: null, code: null },
        }),
        { status: upstream.status, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Forward status + non-hop-by-hop headers; stream the body unbuffered ──
    if (!upstream.body) {
      return new Response(null, {
        status: upstream.status,
        headers: forwardResponseHeaders(upstream.headers),
      });
    }

    return new Response(upstream.body as ReadableStream, {
      status: upstream.status,
      headers: forwardResponseHeaders(upstream.headers),
    });
  };
}
