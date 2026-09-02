/**
 * POST /v1/chat/completions route handler.
 *
 * Resolves whether the request targets a direct provider model or a
 * gateway chain (via `gateway/<name>` prefix or `X-Chain-ID` header),
 * then dispatches accordingly. Validates the request body with zod
 * before it reaches the proxy/orchestrator layer.
 *
 * ROUTING (virtual-model-routing spec):
 *   model: "gateway/thinker" → run the "thinker" chain
 *   header: X-Chain-ID: thinker → run the "thinker" chain (overrides model)
 *   model: "SmolLM3-3B" → passthrough proxy to llama-server
 */
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { chatCompletionRequestSchema } from "../types/zod.js";
import { runChain, type ChainMap, type ProviderMap } from "../orchestrator/engine.js";
import { createPassthroughProxy } from "../middleware/proxy.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface ChatRouteDeps {
  chains: ChainMap;
  providers: ProviderMap;
  manager: LlamaServeManager;
  requestTimeoutMs: number;
}

/** Prefix that marks a model name as a chain invocation. */
const CHAIN_PREFIX = "gateway/";

export function createChatHandler(deps: ChatRouteDeps) {
  const passthroughProxy = createPassthroughProxy(
    () => deps.manager,
    deps.requestTimeoutMs,
  );

  return async (req: Request, res: Response): Promise<void> => {
    // ── Zod validation (gateway-security spec) ──
    let parsed;
    try {
      parsed = chatCompletionRequestSchema.parse(req.body);
    } catch (err) {
      // Let the global error handler format the zod error.
      throw err;
    }

    // ── Resolve chain vs provider ──
    const chainId = resolveChainId(parsed.model, req.headers["x-chain-id"] as string | undefined);

    if (chainId) {
      const chain = deps.chains.get(chainId);
      if (!chain) {
        res.status(404).json({
          error: {
            message: `Chain "${chainId}" not found`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found",
          },
        });
        return;
      }

      // ── Backend availability gate (chain path) ──
      // In external mode (autoStart:false with no operator backend) the
      // passthrough already 503s cleanly; chains must do the same instead of
      // surfacing a raw fetch TypeError as a 500 (gateway-api normalized
      // errors, external-mode edge). Verify backend is running before dispatch.
      if (!backendAvailable(deps.manager)) {
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

      // ── Chain execution (engine handles streaming internally) ──
      const controller = new AbortController();
      res.on("close", () => controller.abort());

      try {
        await runChain(
          chain,
          deps.providers,
          // Use the RAW validated body, not the zod-parsed object: zod's
          // z.object() strips unknown keys by default, which drops
          // OpenAI-compatible extras (tools, tool_choice) that chain steps
          // must forward to the backend. req.body was already validated above.
          req.body as Record<string, unknown>,
          res,
          controller.signal,
          queryString(req),
        );
      } catch (err) {
        if (!res.headersSent) {
          throw err; // Let the global error handler format it.
        }
        // If headers already sent (mid-stream error), the engine's catch
        // block should have handled it. Log but do not throw.
        console.error("[chat] error after headers sent:", err);
      }
      return;
    }

    // ── Unknown real model → 404 (gateway-api "Unknown model returns 404") ──
    // A real (non-chain) model that the managed backend does not register
    // would otherwise be forwarded and surface the upstream's non-canonical
    // 400. Normalize it at the gateway boundary to the OpenAI shape + 404.
    if (!modelExists(deps.manager, parsed.model) && backendAvailable(deps.manager)) {
      res.status(404).json({
        error: {
          message: `Model "${parsed.model}" not found`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      });
      return;
    }

    // ── Direct provider passthrough ──
    console.log(`[chat] passthrough → ${parsed.model}`);
    const contentType = req.headers["content-type"] ?? null;
    const bodyInit =
      req.method !== "GET" && req.method !== "HEAD"
        ? await new Promise<Buffer>((ok, fail) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => ok(Buffer.concat(chunks)));
            req.on("fail", fail);
          })
        : undefined;
    const bunHeaders = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val !== undefined) bunHeaders.set(key, Array.isArray(val) ? val.join(", ") : val);
    }
    if (contentType && !bunHeaders.has("content-type")) {
      bunHeaders.set("content-type", contentType);
    }
    const bunReq = new Request(req.url, {
      method: req.method,
      headers: bunHeaders,
      body: bodyInit,
    });
    const proxyRes = await passthroughProxy(bunReq);
    if (proxyRes.body) {
      const nodeStream = Readable.fromWeb(
        proxyRes.body as import("node:stream/web").ReadableStream,
      );
      nodeStream.pipe(res);
    } else {
      res.status(proxyRes.status).end();
    }
  };
}

/**
 * Determine the chain ID from the model field or X-Chain-ID header.
 * Returns undefined if the request should be proxied directly.
 */
function resolveChainId(
  model: string,
  headerChainId: string | undefined,
): string | undefined {
  // X-Chain-ID header overrides model for chain resolution.
  if (headerChainId) {
    return headerChainId;
  }
  // Check for gateway/ prefix.
  if (model.startsWith(CHAIN_PREFIX)) {
    return model.slice(CHAIN_PREFIX.length);
  }
  return undefined;
}

/**
 * Whether the managed backend is currently serving traffic. In external mode
 * (autoStart:false, no operator backend) the baseUrl is empty / state stopped.
 */
function backendAvailable(manager: LlamaServeManager): boolean {
  return manager.status().state === "running" && manager.status().baseUrl !== "";
}

/** Whether a real (non-chain) model is registered on the managed backend. */
function modelExists(manager: LlamaServeManager, model: string): boolean {
  return manager.status().models.includes(model);
}

/**
 * Extract the raw query string (the part after `?`) from the client request,
 * so it is preserved on every chain-step upstream call. Returns undefined when
 * the request carries no query.
 */
function queryString(req: Request): string | undefined {
  const originalUrl = req.originalUrl ?? req.url ?? "";
  const queryIndex = originalUrl.indexOf("?");
  if (queryIndex < 0) return undefined;
  return originalUrl.slice(queryIndex + 1);
}
