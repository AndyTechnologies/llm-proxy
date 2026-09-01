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
    () => deps.manager.status().baseUrl,
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

      // ── Chain execution (engine handles streaming internally) ──
      const controller = new AbortController();
      res.on("close", () => controller.abort());

      try {
        await runChain(chain, deps.providers, parsed as unknown as Record<string, unknown>, res, controller.signal);
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

    // ── Direct provider passthrough ──
    console.log(`[chat] passthrough → ${parsed.model}`);
    passthroughProxy(req, res, () => {
      // This callback is called if proxy middleware does not handle the request.
      // Should not happen for /v1/chat/completions but is a safety net.
      if (!res.headersSent) {
        res.status(404).json({
          error: {
            message: `Model "${parsed.model}" not found`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found",
          },
        });
      }
    });
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
