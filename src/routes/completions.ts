/**
 * POST /v1/completions route handler.
 *
 * Legacy text completions endpoint. Converts the prompt-based request into
 * a chat-formatted request internally (prompt → messages[{role:"user"}]),
 * then dispatches to chain or provider using the same logic as chat.ts.
 *
 * For passthrough (non-chain) requests, the payload is forwarded to the
 * http-proxy-middleware which handles the conversion upstream.
 */
import type { Request, Response } from "express";
import { completionRequestSchema } from "../types/zod.js";
import type { LlamaServerConfig } from "../config/schema.js";
import { createPassthroughProxy } from "../middleware/proxy.js";
import type { ChainMap, ProviderMap } from "../orchestrator/engine.js";
import { runChain } from "../orchestrator/engine.js";

export interface CompletionsRouteDeps {
  chains: ChainMap;
  providers: ProviderMap;
  llamaServer: LlamaServerConfig;
}

const CHAIN_PREFIX = "gateway/";

export function createCompletionsHandler(deps: CompletionsRouteDeps) {
  const passthroughProxy = createPassthroughProxy(deps.llamaServer);

  return async (req: Request, res: Response): Promise<void> => {
    // ── Zod validation ──
    let parsed;
    try {
      parsed = completionRequestSchema.parse(req.body);
    } catch (err) {
      throw err;
    }

    // ── Convert prompt → messages for chain routing ──
    const prompt =
      typeof parsed.prompt === "string"
        ? parsed.prompt
        : Array.isArray(parsed.prompt)
          ? parsed.prompt.join("\n")
          : "";

    const chatPayload: Record<string, unknown> = {
      ...parsed,
      messages: [{ role: "user", content: prompt }],
    };

    // ── Resolve chain vs provider ──
    const chainId = resolveChainId(
      parsed.model,
      req.headers["x-chain-id"] as string | undefined,
    );

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

      const controller = new AbortController();
      res.on("close", () => controller.abort());

      try {
        await runChain(chain, deps.providers, chatPayload, res, controller.signal);
      } catch (err) {
        if (!res.headersSent) {
          throw err;
        }
        console.error("[completions] error after headers sent:", err);
      }
      return;
    }

    // ── Direct provider passthrough ──
    console.log(`[completions] passthrough → ${parsed.model}`);
    passthroughProxy(req, res, () => {
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

function resolveChainId(
  model: string,
  headerChainId: string | undefined,
): string | undefined {
  if (headerChainId) return headerChainId;
  if (model.startsWith(CHAIN_PREFIX)) return model.slice(CHAIN_PREFIX.length);
  return undefined;
}
