/**
 * llama-server provider adapter.
 *
 * Talks to a native llama server (llama.cpp blueprint) at the configured
 * :8080 address, exposing the OpenAI-compatible /v1/chat/completions endpoint.
 *
 * WHY an adapter (architectural decision): the llama-server/llama-swap API
 * surface is the top compatibility risk in this rewrite. Encapsulating every
 * network call + payload normalization behind the Provider interface means a
 * future backend swap touches exactly one file, never the routes or engine.
 */
import type { LlamaServerConfig } from "../config/schema.js";
import type { Provider } from "./types.js";
import {
  sanitizePayloadForLlamaCpp,
  finiteNumber,
} from "../utils/sanitize.js";

export interface LlamaServerOptions {
  config: LlamaServerConfig;
}

/** Default per-request timeout fallthrough (llama-server can be slow). */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Normalize the outbound payload for llama.cpp compatibility:
 *  - developer role → system
 *  - array-form content parts → flattened concatenated text
 *  - non-finite numeric params → safe finite defaults (never NaN)
 *
 * This reuses the exact rules from the old JS sanitizer; the gateway keeps
 * these as an explicit step so the engine/routes never forward a broken body.
 */
function normalizeOutboundPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizePayloadForLlamaCpp(payload);
}

export class LlamaServerProvider implements Provider {
  readonly name = "llama-server";
  private readonly config: LlamaServerConfig;

  constructor(options: LlamaServerOptions) {
    this.config = options.config;
  }

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async chat(
    request: Record<string, unknown>,
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept in signature parity with Provider */
    _chainName?: string,
  ): Promise<Record<string, unknown>> {
    const sanitized = normalizeOutboundPayload({
      ...request,
      stream: false,
    });

    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sanitized),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();

    if (!res.ok) {
      const err = new Error(
        `llama-server error ${res.status}: ${text.slice(0, 500)}`,
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`llama-server returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  async *chatStream(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const sanitized = normalizeOutboundPayload({
      ...request,
      stream: true,
    });

    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Combine the client-disconnect signal with the request timeout. We want
    // BOTH: abort when the client goes away AND abort after a hard timeout.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sanitized),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(
        `llama-server error ${res.status}: ${text.slice(0, 500)}`,
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    if (!res.body) {
      throw new Error("llama-server returned no response body for streaming");
    }

    // NO BUFFERING: parse the SSE stream line-by-line and yield each data
    // payload as it arrives. Buffering the whole body would add latency and
    // memory for long generations, and reintroduce the multi-chunk races.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line === ":") {
          continue;
        }
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          return;
        }
        yield data;
      }
    }
  }
}

/** Factory to keep construction uniform with future providers. */
export function makeLlamaServerProvider(
  config: LlamaServerConfig,
): Provider {
  return new LlamaServerProvider({ config });
}

/** Convenience re-export used by other modules that need finiteNumber too. */
export { finiteNumber };
