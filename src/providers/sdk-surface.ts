/**
 * SDK isolation surface for the OpenAI-compatible provider.
 *
 * Every direct dependency on `ai` / `@ai-sdk/*` that encodes a FRAGILE fact
 * about the SDK lives here. The adapter (`openai-compatible.ts`) consumes the
 * SDK only through this layer and never re-derives these facts itself, so an
 * SDK upgrade that shifts them breaks HERE (typecheck + contract tests), not
 * as a runtime bug deep in the streaming path.
 *
 * Fragile facts pinned by this module (ai@7.0.93):
 *  1. `TooManyRequestsError` does NOT exist in ai@7 — 429s surface as
 *     `APICallError` with `statusCode: 429`. `sdkErrorStatus` therefore
 *     duck-types `statusCode`/`status` FIRST and only falls back to SDK class
 *     `isInstance` checks as reinforcement (those checks silently miss when
 *     `@ai-sdk/provider` gets duplicated in the dependency graph).
 *  2. The full-stream text-delta part exposes its delta on `text`, NOT
 *     `textDelta` — the exported type name "TextStreamTextDeltaPart" is a lie.
 *     The type guards below narrow on `part.type` and read the REAL field.
 *  3. OpenAI-compatible streams can emit a usage tail (`choices: []`) AFTER
 *     the terminal chunk. `isTerminalWireChunk` detects the terminal chunk by
 *     a non-empty `finish_reason` in `choices[0]`, never by "last chunk".
 *  4. The full-stream `tool-result` part exposes its payload on `output`, NOT
 *     `result` — same lie family as fact #2. Pinned by the type guards and by
 *     the compile-time shape contract in `sdk-surface.test.ts`.
 */
import {
  APICallError,
  NoSuchModelError,
  RetryError,
  StreamProviderError,
} from "ai";
import type { TextStreamPart, ToolSet } from "ai";

/** The typed part union yielded by `streamText(...).fullStream`. */
export type SdkStreamPart = TextStreamPart<ToolSet>;

/**
 * Number-shaped HTTP status of an arbitrary error, or `undefined` when the
 * error carries no HTTP status (plain errors, aborts, non-SDK shapes).
 *
 * Duck-typing is PRIMARY (fact #1): SDK class `isInstance` checks are used
 * only as reinforcement, because those marker checks miss when the
 * `@ai-sdk/provider` package is duplicated (two copies → two markers).
 */
export function sdkErrorStatus(err: unknown): number | undefined {
  const maybe = err as
    | { statusCode?: unknown; status?: unknown }
    | null
    | undefined;

  // Duck-typing first — shape-based, works across duplicated package copies.
  const statusCode = maybe?.statusCode;
  if (typeof statusCode === "number") return statusCode;
  const status = maybe?.status;
  if (typeof status === "number") return status;

  // Abort errors are not HTTP errors and carry no status.
  if (isAbortError(err)) return undefined;

  // SDK classes as reinforcement (never the primary path — see header).
  if (NoSuchModelError.isInstance(err)) return 404;
  if (APICallError.isInstance(err)) return err.statusCode ?? 500;
  if (StreamProviderError.isInstance(err)) {
    if (typeof err.statusCode === "number") return err.statusCode;
    return err.cause === undefined ? undefined : sdkErrorStatus(err.cause);
  }
  if (RetryError.isInstance(err)) {
    for (const e of err.errors) {
      const inner = sdkErrorStatus(e);
      if (inner !== undefined) return inner;
    }
    return sdkErrorStatus(err.lastError);
  }
  return undefined;
}

/** Whether the error is an abort (DOMException or Error named "AbortError"). */
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

// ── fullStream part type guards ────────────────────────────────────────────
// Each guard narrows on `part.type` and reads the part's REAL field shape
// (fact #2: text-delta → `.text`, the type name is a lie). If the SDK renames
// a field, the body below stops typechecking here, inside the isolation layer.

/** text-delta part: the delta text is on `.text` (NOT `.textDelta`). */
export function isTextDeltaPart(
  part: SdkStreamPart,
): part is Extract<SdkStreamPart, { type: "text-delta" }> {
  if (part.type !== "text-delta") return false;
  return typeof part.text === "string";
}

/** tool-call part: `toolCallId` / `toolName` / `input`. */
export function isToolCallPart(
  part: SdkStreamPart,
): part is Extract<SdkStreamPart, { type: "tool-call" }> {
  if (part.type !== "tool-call") return false;
  const { toolCallId, toolName, input } = part;
  return (
    typeof toolCallId === "string" &&
    typeof toolName === "string" &&
    input !== undefined
  );
}

/** finish part: `finishReason` + `totalUsage`. */
export function isFinishPart(
  part: SdkStreamPart,
): part is Extract<SdkStreamPart, { type: "finish" }> {
  if (part.type !== "finish") return false;
  const { finishReason, totalUsage } = part;
  return typeof finishReason === "string" && !!totalUsage;
}

/** raw part: `rawValue` IS the verbatim wire `chat.completion.chunk`. */
export function isRawPart(
  part: SdkStreamPart,
): part is Extract<SdkStreamPart, { type: "raw" }> {
  if (part.type !== "raw") return false;
  return part.rawValue !== undefined;
}

/** error part: `error` is rethrown by the adapter. */
export function isErrorPart(
  part: SdkStreamPart,
): part is Extract<SdkStreamPart, { type: "error" }> {
  if (part.type !== "error") return false;
  return part.error !== undefined;
}

/** abort part: carries no consumed fields (`reason?` is optional metadata). */
export function isAbortPart(
  part: SdkStreamPart,
): part is Extract<SdkStreamPart, { type: "abort" }> {
  return part.type === "abort";
}

/**
 * Whether a raw wire chunk carries a terminal `finish_reason` (fact #3).
 *
 * OpenAI-compatible streams may emit a usage tail (`choices: []`) AFTER the
 * terminal chunk, so "last chunk" is NOT a reliable terminal signal — the
 * terminal chunk is the one with a non-empty `finish_reason` in `choices[0]`.
 */
export function isTerminalWireChunk(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return false;
  const first = choices[0] as { finish_reason?: unknown } | undefined;
  return typeof first?.finish_reason === "string" && first.finish_reason.length > 0;
}

/** Map the unified finish reason to the OpenAI wire value. */
export function toFinishReason(reason: string): string {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    default:
      return reason;
  }
}

/** The tool-call shape the adapter rebuilds into OpenAI wire tool_calls. */
export interface SdkToolCallShape {
  toolCallId?: string;
  toolName: string;
  input: unknown;
}

/** OpenAI wire `usage` object from the SDK usage numbers. */
export function wireUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  return {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
  };
}

/**
 * Synthesize an OpenAI wire streaming chunk. id/model/created are placeholders
 * — buildStreamBody (src/orchestrator/engine.ts) rewrites them per chunk.
 */
export function synthChunk(patch: {
  delta: Record<string, unknown>;
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}): Record<string, unknown> {
  return {
    id: "chatcmpl-external",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "external",
    choices: [
      { index: 0, delta: patch.delta, finish_reason: patch.finish_reason ?? null },
    ],
    ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
  };
}