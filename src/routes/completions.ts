/**
 * POST /v1/completions route handler (S2b — Bun.serve fetch handler).
 *
 * Legacy text completions endpoint. Converts the prompt-based request into
 * a chat-formatted request internally (prompt → messages[{role:"user"}]),
 * then dispatches to chain or provider using the same logic as chat.ts.
 *
 * Converted from an Express handler to a plain fetch handler returning
 * `Promise<Response>` (S2b). The SSE idle-timeout disable
 * (`server.timeout(req, 0)`) is applied by the Bun.serve dispatcher in
 * server.ts.
 *
 * For passthrough (non-chain) requests, the payload is forwarded to the
 * backend via the passthrough forwarder, which re-serializes the parsed
 * body and streams the upstream response back (see middleware/proxy.ts).
 */
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
const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonError(
  message: string,
  type: string,
  param: string | null,
  code: string | null,
  status: number,
): Response {
  return new Response(JSON.stringify({ error: { message, type, param, code } }), {
    status,
    headers: JSON_HEADERS,
  });
}

export function createCompletionsHandler(deps: CompletionsRouteDeps) {
  const passthroughProxy = createPassthroughProxy(
    () => deps.manager,
    deps.requestTimeoutMs,
  );

  return async (req: Request): Promise<Response> => {
    // ── Read + Zod validation ──
    let rawBody: Record<string, unknown>;
    let parsed;
    try {
      rawBody = (await req.json()) as Record<string, unknown>;
      parsed = completionRequestSchema.parse(rawBody);
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
      ...rawBody,
      messages: [{ role: "user", content: prompt }],
    };

    // ── Resolve chain vs provider ──
    const chainId = resolveChainId(
      parsed.model,
      req.headers.get("x-chain-id") ?? undefined,
    );

    if (chainId) {
      const chain = deps.chains.get(chainId);
      if (!chain) {
        return jsonError(
          `Chain "${chainId}" not found`,
          "invalid_request_error",
          "model",
          "model_not_found",
          404,
        );
      }

      // Backend availability gate for chains (external-mode: must 503 like
      // passthrough, not surface a raw fetch TypeError as 500).
      if (!backendAvailable(deps.manager)) {
        return jsonError(
          "Backend not available",
          "server_error",
          null,
          "backend_unavailable",
          503,
        );
      }

      return await runChain(
        chain,
        deps.providers,
        chatPayload,
        req.signal,
        queryString(req),
      );
    }

    // ── Unknown real model → 404 (gateway-api "Unknown model returns 404") ──
    if (!modelExists(deps.manager, parsed.model) && backendAvailable(deps.manager)) {
      return jsonError(
        `Model "${parsed.model}" not found`,
        "invalid_request_error",
        "model",
        "model_not_found",
        404,
      );
    }

    // ── Direct provider passthrough ──
    console.log(`[completions] passthrough → ${parsed.model}`);
    const passthroughReq = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body:
        req.method !== "GET" && req.method !== "HEAD"
          ? JSON.stringify(chatPayload)
          : undefined,
    });
    return await passthroughProxy(passthroughReq);
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
  const queryIndex = req.url.indexOf("?");
  if (queryIndex < 0) return undefined;
  return req.url.slice(queryIndex + 1);
}
