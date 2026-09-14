/**
 * OpenAI-wire HTTP adapter core (shared by adapter-openai and
 * adapter-openrouter). Implements the Provider seam over a raw fetch to
 * `{baseUrl}/chat/completions` with Bearer auth resolved from the keychain.
 *
 * The outbound and inbound payloads are OpenAI wire shape, so chat passes
 * the upstream JSON through verbatim and chatStream relays raw SSE `data:`
 * payloads (the upstream `[DONE]` frame is consumed — the /v1 relay adds
 * exactly one terminal of its own). Upstream failures keep their HTTP
 * status on the Error so the fallback layer can act on 429/5xx.
 */
import { ProviderMisconfiguredError, type ExternalProviderAdapter, type ProviderKind } from "./adapters.js";

/** Minimal fetch shape — NOT Bun's `typeof fetch`, so fakes in tests type-check. */
export type HttpFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpProviderOptions {
  kind: ProviderKind;
  name: string;
  /** Base URL including any version prefix, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  keyResolver: () => Promise<string | null>;
  /** Static headers, already `${ENV}`-interpolated by the caller. */
  headers: Record<string, string>;
  models: string[];
  fallbackId?: string | null;
  /** Set by the registry when no key is stored; default false. */
  misconfigured?: boolean;
  fetcher?: HttpFetcher;
}

/** Read a response body as an async iterable of SSE `data:` payload strings. */
export async function* sseDataPayloads(res: Response): AsyncIterable<string> {
  if (!res.body) {
    throw new Error("upstream returned no response body for streaming");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "") continue;
      if (data === "[DONE]") return;
      yield data;
    }
  }
}

/** Build the OpenAI-wire HTTP adapter. */
export function makeOpenAIWireProvider(opts: HttpProviderOptions): ExternalProviderAdapter {
  const baseURL = opts.baseUrl.replace(/\/$/, "");
  const fetcher = opts.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init));

  const buildHeaders = async (): Promise<Record<string, string>> => {
    const key = await opts.keyResolver();
    if (key === null) throw new ProviderMisconfiguredError(opts.kind);
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...opts.headers,
    };
  };

  return {
    name: opts.name,
    kind: opts.kind,
    models: opts.models,
    requiresKey: true,
    misconfigured: opts.misconfigured ?? false,
    fallbackId: opts.fallbackId ?? null,

    async chat(request: Record<string, unknown>, _chainName?: string) {
      const headers = await buildHeaders();
      const res = await fetcher(`${baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request, stream: false }),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(
          `${opts.name} error ${res.status}: ${text.slice(0, 300)}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`${opts.name} returned invalid JSON: ${text.slice(0, 200)}`);
      }
    },

    async *chatStream(
      request: Record<string, unknown>,
      signal: AbortSignal,
    ): AsyncIterable<string> {
      const headers = await buildHeaders();
      let res: Response;
      try {
        res = await fetcher(`${baseURL}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...request, stream: true }),
          signal,
        });
      } catch (err) {
        // Network-level failures are fallbackable; keep them unadorned so a
        // bare TypeError reads as a transport error to the fallback layer.
        throw err;
      }
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(
          `${opts.name} error ${res.status}: ${text.slice(0, 300)}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      for await (const payload of sseDataPayloads(res)) {
        yield payload;
      }
    },
  };
}