/**
 * POST /v1/completions route handler.
 *
 * Legacy text completions endpoint. Converts the prompt-based request into
 * a chat-formatted request internally (prompt → messages[{role:"user"}]),
 * then dispatches to chain or provider using the same logic as chat.ts.
 *
 * For passthrough (non-chain) requests, the payload is forwarded to the
 * backend via the passthrough forwarder, which re-serializes the parsed
 * body and streams the upstream response back (see middleware/proxy.ts).
 */
import type { Request, Response } from "express";
import { completionRequestSchema } from "../types/zod.js";
import { createPassthroughProxy } from "../middleware/proxy.js";
import type { ChainMap, ProviderMap } from "../orchestrator/engine.js";
import { runChain } from "../orchestrator/engine.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface CompletionsRouteDeps {
  chains: ChainMap;
  providers: ProviderMap;
  manager: LlamaServeManager;
  requestTimeoutMs: number;
}

const CHAIN_PREFIX = "gateway/";

export function createCompletionsHandler(deps: CompletionsRouteDeps) {
  const passthroughProxy = createPassthroughProxy(
    () => deps.manager,
    deps.requestTimeoutMs,
  );

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
      // Raw validated body (see chat.ts): zod strips unknown keys, and
      // OpenAI-compatible extras must survive for chain steps.
      ...(req.body as Record<string, unknown>),
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

      // Backend availability gate for chains (external-mode: must 503 like
      // passthrough, not surface a raw fetch TypeError as 500).
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

      const controller = new AbortController();
      res.on("close", () => controller.abort());

      try {
        await runChain(
          chain,
          deps.providers,
          chatPayload,
          res,
          controller.signal,
          queryString(req),
        );
      } catch (err) {
        if (!res.headersSent) {
          throw err;
        }
        console.error("[completions] error after headers sent:", err);
      }
      return;
    }

    // ── Unknown real model → 404 (gateway-api "Unknown model returns 404") ──
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
    console.log(`[completions] passthrough → ${parsed.model}`);
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
      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(
        proxyRes.body as import("node:stream/web").ReadableStream,
      );
      nodeStream.pipe(res);
    } else {
      res.status(proxyRes.status).end();
    }
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

/** Whether the managed backend is currently serving traffic. */
function backendAvailable(manager: LlamaServeManager): boolean {
  return manager.status().state === "running" && manager.status().baseUrl !== "";
}

/** Whether a real (non-chain) model is registered on the managed backend. */
function modelExists(manager: LlamaServeManager, model: string): boolean {
  return manager.status().models.includes(model);
}

/** Extract the raw query string after `?` from the client request. */
function queryString(req: Request): string | undefined {
  const originalUrl = req.originalUrl ?? req.url ?? "";
  const queryIndex = originalUrl.indexOf("?");
  if (queryIndex < 0) return undefined;
  return originalUrl.slice(queryIndex + 1);
}
