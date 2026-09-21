/**
 * Provider fallback (external-providers spec): when a provider call fails
 * with 429, 5xx, or a network error and a fallback provider is configured
 * (`providers.fallback_id`), retry the request on the next provider in the
 * chain. Non-retryable outcomes (client 4xx, misconfigured providers) fail
 * fast without touching the fallback.
 *
 * Streaming no-dup rule: chunks are buffered until the first chunk that
 * commits output (non-empty content or tool_calls). A failure before that
 * point restarts cleanly from the fallback — the buffered prefix is dropped,
 * so the client never sees phantom partial output. A failure after
 * commitment propagates: already-emitted tokens cannot be unwound, so
 * falling back would duplicate them.
 */
import { ProviderMisconfiguredError, type ExternalProviderAdapter } from "./adapters.js";
import type { ProviderRegistry } from "./registry.js";

const DEFAULT_MAX_HOPS = 3;

/** True when the error is transient and a fallback attempt is warranted. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderMisconfiguredError) return false;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  // TypeError (fetch network failure) and unstructured transport failures
  // (stream bodies that die before any content) are network-ish: retryable.
  return true;
}

/** Ordered providers to try: primary first, then fallback links. */
export function buildFallbackChain(
  registry: ProviderRegistry,
  kind: string,
): ExternalProviderAdapter[] {
  const chain: ExternalProviderAdapter[] = [];
  const visited = new Set<string>();
  let current: string | null = kind;
  while (current !== null && !visited.has(current) && chain.length < DEFAULT_MAX_HOPS) {
    visited.add(current);
    const adapter = registry.get(current);
    if (adapter === null) break;
    chain.push(adapter);
    current = adapter.fallbackId;
  }
  return chain;
}

/** Non-streaming call with fallback; throws the last error when all fail. */
export async function chatWithFallback(
  registry: ProviderRegistry,
  kind: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chain = buildFallbackChain(registry, kind);
  if (chain.length === 0) {
    throw new Error(`no provider "${kind}" is registered`);
  }
  let lastErr: unknown = null;
  for (const adapter of chain) {
    try {
      return await adapter.chat(request);
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err)) throw err;
    }
  }
  throw lastErr;
}

interface ChunkShape {
  choices?: Array<{ delta?: Record<string, unknown> }>;
}

/** A chunk commits once output is real: content text or tool_calls appear. */
export function isCommitChunk(payload: string): boolean {
  let chunk: ChunkShape;
  try {
    chunk = JSON.parse(payload) as ChunkShape;
  } catch {
    return false;
  }
  const delta = chunk.choices?.[0]?.delta;
  if (delta === undefined) return false;
  if (typeof delta.content === "string" && delta.content.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  return false;
}

/** Streaming call with fallback; guarantees zero duplicated token emission. */
export async function* chatStreamWithFallback(
  registry: ProviderRegistry,
  kind: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const chain = buildFallbackChain(registry, kind);
  if (chain.length === 0) {
    throw new Error(`no provider "${kind}" is registered`);
  }

  let lastErr: unknown = null;
  for (const adapter of chain) {
    const buffered: string[] = [];
    let committed = false;
    try {
      for await (const payload of adapter.chatStream(request, signal)) {
        if (committed) {
          yield payload;
          continue;
        }
        if (isCommitChunk(payload)) {
          committed = true;
          for (const p of buffered) yield p;
          buffered.length = 0;
          yield payload;
        } else {
          buffered.push(payload);
        }
      }
      // Stream completed normally: deliver whatever prefix never committed.
      for (const p of buffered) yield p;
      return;
    } catch (err) {
      lastErr = err;
      if (committed) {
        // Tokens already emitted to the client — a fallback would duplicate.
        throw err;
      }
      if (!isRetryableError(err)) throw err;
      // Failure before any output: restart from the next provider, dropping
      // the buffered (never-emitted) prefix.
    }
  }
  throw lastErr;
}