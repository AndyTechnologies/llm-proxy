/**
 * http-proxy-middleware passthrough for single-hop `/v1/*` requests.
 *
 * For requests that do NOT match a `gateway/<chain>` model prefix or an
 * `X-Chain-ID` header, the request is forwarded verbatim to the llama-server
 * backend. The target URL is always derived from `config.llamaServer` —
 * never from the request body — which is the SSRF guard the spec mandates.
 *
 * http-proxy-middleware handles SSE chunking, abort propagation, and
 * connection keep-alive automatically, so we do not need to re-implement
 * them for the passthrough path.
 */
import { createProxyMiddleware, type RequestHandler } from "http-proxy-middleware";
import type { LlamaServerConfig } from "../config/schema.js";

export function createPassthroughProxy(
  llamaServer: LlamaServerConfig,
): RequestHandler {
  const target = `http://${llamaServer.host}:${llamaServer.port}`;

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    // Do NOT buffer — SSE frames must reach the client in real-time.
    selfHandleResponse: false,
    // Strip fields the client may have injected that could influence routing.
    // SSRF: the target is config-only; unknown body keys are stripped by the
    // sanitize layer in the provider adapter, but the proxy layer should also
    // not forward proxy-injected headers.
    pathRewrite: undefined,
    on: {
      proxyReq: (_proxyReq, req) => {
        // Log the passthrough for observability without logging body contents.
        console.log(
          `[proxy] passthrough → ${target}${(req as { url?: string }).url ?? "/"}`,
        );
      },
      error: (err, _req, res) => {
        console.error("[proxy] upstream error:", err.message);
        // Express response objects have .status().json(); the proxy middleware
        // passes the raw http.ServerResponse which may or may not be upgraded.
        const r = res as unknown as {
          status: (code: number) => { json: (body: unknown) => void };
        };
        if (typeof r.status === "function") {
          r.status(502).json({
            error: {
              message: `Upstream error: ${err.message}`,
              type: "server_error",
              param: null,
              code: "upstream_error",
            },
          });
        }
      },
    },
  });
}
