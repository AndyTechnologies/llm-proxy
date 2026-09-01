/**
 * Payload sanitization helpers for llama/cpp compatibility.
 *
 * Ported 1:1 from the old JS utils/micro.js. These guarantee the outbound
 * payload never carries values that break llama-server: developer roles are
 * normalized to system, array-form content is flattened, and numeric sampling
 * params are clamped to finite defaults so they can never be NaN.
 */
import { extractContent } from "./extract.js";

/** Clamp a value to a finite numeric range, falling back to a default. */
export function finiteNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value === "" || value === undefined) {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback; // NaN or ±Infinity
  }
  return Math.min(max, Math.max(min, n));
}

/** Flatten a chat message's array-form content parts into a scalar string. */
export function flattenContent(
  content: unknown,
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts = content
      .map((part: unknown) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          part &&
          typeof part === "object" &&
          "type" in (part as Record<string, unknown>) &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return null;
      })
      .filter((t: string | null): t is string => t !== null);
    return textParts.join("\n");
  }
  return "";
}

/**
 * Normalize roles and content for llama.cpp:
 *  - developer → system
 *  - array content → flattened text
 */
export function normalizeMessages(
  messages: unknown,
): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const next = { ...(msg as Record<string, unknown>) };
    if (next.role === "developer") {
      next.role = "system";
    }
    if (Array.isArray(next.content)) {
      next.content = flattenContent(next.content);
    }
    return next;
  });
}

/**
 * Build a clean outbound payload for llama-server.
 *
 * This is the SSRF + correctness boundary: URL-bearing or provider-injected
 * fields are never forwarded, unknown/experimental keys are stripped, and
 * numeric params are clamped. The upstream target itself is decided by the
 * routing layer from config — never derived from this payload.
 */
export function sanitizePayloadForLlamaCpp(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  if (payload.model) clean.model = payload.model;
  if (payload.messages !== undefined) clean.messages = normalizeMessages(payload.messages);
  if (payload.stream !== undefined) clean.stream = payload.stream;

  if (payload.temperature !== undefined) {
    clean.temperature = finiteNumber(payload.temperature, 0.7, 0, 2);
  }
  if (payload.top_p !== undefined) {
    clean.top_p = finiteNumber(payload.top_p, 1, 0, 1);
  }
  const maxTokens =
    payload.max_tokens !== undefined
      ? payload.max_tokens
      : (payload.max_completion_tokens as unknown) as unknown;
  if (maxTokens !== undefined) {
    clean.max_tokens = finiteNumber(maxTokens, 2048, 1, 8192);
  }
  if (payload.stop !== undefined) clean.stop = payload.stop;
  if (payload.tools !== undefined) clean.tools = payload.tools;
  if (payload.tool_choice !== undefined) clean.tool_choice = payload.tool_choice;

  /* Deliberately NOT copied (historical llama.cpp grammar bug classes):
     response_format, grammar, logprobs, top_logprobs, logit_bias,
     stream_options, store, reasoning_effort, seed, n, user,
     presence_penalty, frequency_penalty. Keeping them out avoids GBNF
     grammar-generation crashes. */
  return clean;
}

export { extractContent };
