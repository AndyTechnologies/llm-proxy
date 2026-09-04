/**
 * POST /v1/chat/completions route handler (Bun.serve fetch handler).
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
import { chatCompletionRequestSchema } from "../types/zod.js";
import type { ProviderMap } from "../orchestrator/engine.js";
import { runGraphEngine } from "../orchestrator/graph-engine.js";
import type { GraphPipeline } from "../orchestrator/graph.js";
import { createPassthroughProxy } from "../middleware/proxy.js";
import type { LlamaServeManager } from "../backend/manager.js";

export interface ChatRouteDeps {
  providers: ProviderMap;
  manager: LlamaServeManager;
  requestTimeoutMs: number;
  /** Graph pipeline lookup — resolves chain name to graph for dispatch. */
  getGraph: (id: string) => GraphPipeline | undefined;
}

/** Prefix that marks a model name as a chain invocation. */
const CHAIN_PREFIX = "gateway/";

/** JSON error headers for early (non-streamed) error responses. */
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

export function createChatHandler(deps: ChatRouteDeps) {
  const passthroughProxy = createPassthroughProxy(
    () => deps.manager,
    deps.requestTimeoutMs,
  );

  return async (req: Request): Promise<Response> => {
    // ── Read + Zod validation (gateway-security spec) ──
    let rawBody: Record<string, unknown>;
    let parsed;
    try {
      rawBody = (await req.json()) as Record<string, unknown>;
      parsed = chatCompletionRequestSchema.parse(rawBody);
    } catch (err) {
      throw err; // Let the global error handler format the zod error.
    }

    // ── Resolve chain vs provider ──
    const chainId = resolveChainId(
      parsed.model,
      req.headers.get("x-chain-id") ?? undefined,
    );

    if (chainId) {
      // Graph-only dispatch: resolve the chain name to a GraphPipeline.
      const graph = deps.getGraph(chainId);
      if (!graph) {
        return jsonError(
          `Chain "${chainId}" not found`,
          "invalid_request_error",
          "model",
          "model_not_found",
          404,
        );
      }

      // ── Backend availability gate (chain path) ──
      // In external mode (autoStart:false with no operator backend) the
      // passthrough already 503s cleanly; chains must do the same instead of
      // surfacing a raw fetch TypeError as a 500 (gateway-api normalized
      // errors, external-mode edge). Verify backend is running before dispatch.
      if (!backendAvailable(deps.manager)) {
        return jsonError(
          "Backend not available",
          "server_error",
          null,
          "backend_unavailable",
          503,
        );
      }

      // ── Graph engine dispatch ──
      // Use the RAW validated body, not the zod-parsed object: zod's
      // z.object() strips unknown keys by default, which drops
      // OpenAI-compatible extras (tools, tool_choice) that graph steps
      // must forward to the backend. rawBody was already validated above.
      const result = await runGraphEngine(
        graph,
        { providers: deps.providers, getPipeline: () => undefined },
        {
          streamRequested: rawBody.stream === true,
          payload: rawBody,
          signal: req.signal,
        },
      );
      return result.response;
    }

    // ── Unknown real model → 404 (gateway-api "Unknown model returns 404") ──
    // A real (non-chain) model that the managed backend does not register
    // would otherwise be forwarded and surface the upstream's non-canonical
    // 400. Normalize it at the gateway boundary to the OpenAI shape + 404.
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
    console.log(`[chat] passthrough → ${parsed.model}`);
    // For non-GET/HEAD, forward a Request with the raw JSON body. Re-serialize
    // from the validated body (already JSON) so the body can be read once.
    const passthroughReq = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(rawBody) : undefined,
    });
    return await passthroughProxy(passthroughReq);
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


