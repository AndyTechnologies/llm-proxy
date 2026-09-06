/**
 * Contract tests pinning the SDK isolation surface (`sdk-surface.ts`).
 *
 * The whole point of this file: the adapter no longer talks to `ai` directly,
 * and these tests pin the fragile facts from the surface header — so an SDK
 * upgrade that renames a field, drops an error class, or changes terminal
 * detection breaks HERE (typecheck or test), not as a runtime bug in the
 * streaming path.
 *
 * Error-status tests use STRUCTURAL fake errors (plain objects). They must NOT
 * depend on real SDK error instances for the primary path — that dependency
 * is exactly the fragility being isolated (`isInstance` marker checks miss
 * when `@ai-sdk/provider` is duplicated in the dependency graph).
 */
import { describe, expect, test } from "bun:test";
import { APICallError, NoSuchModelError, RetryError } from "ai";
import type { LanguageModelUsage } from "ai";
import {
  isAbortError,
  isAbortPart,
  isErrorPart,
  isFinishPart,
  isRawPart,
  isTerminalWireChunk,
  isTextDeltaPart,
  isToolCallPart,
  sdkErrorStatus,
  type SdkStreamPart,
  type SdkToolCallShape,
} from "./sdk-surface.js";

/**
 * ── Compile-time shape contract (ai@7 pinned) ───────────────────────────────
 * If the SDK renames or drops any of these fields, this module stops
 * typechecking AT THESE LINES. Pinned facts:
 *
 *  1. The full-stream text-delta part exposes `text`, NOT `textDelta` — the
 *     exported type name "TextStreamTextDeltaPart" is a lie (the `textDelta`
 *     field does not exist in ai@7.0.93). The `textDelta?: never` slot is the
 *     absence pin: if the SDK ever adds that field, this breaks too.
 *  2. The tool-call / finish / raw parts keep the field shapes the adapter
 *     consumes (layered on top of the guard bodies, which already access the
 *     real fields — a rename breaks the guards first).
 *  3. The `tool-result` part exposes `output`, NOT `result` (fact #4) — the
 *     `result?: never` slot is the absence pin for the same family of lies.
 */
void ((null as unknown as Extract<SdkStreamPart, { type: "text-delta" }>) satisfies {
  type: "text-delta";
  text: string;
  textDelta?: never; // pinned ABSENT — does not exist in ai@7
});
void ((null as unknown as Extract<SdkStreamPart, { type: "tool-call" }>) satisfies
  SdkToolCallShape);
void ((null as unknown as Extract<SdkStreamPart, { type: "tool-result" }>) satisfies {
  type: "tool-result";
  output: unknown;
  result?: never; // pinned ABSENT — fact #4, does not exist in ai@7
});
void ((null as unknown as Extract<SdkStreamPart, { type: "finish" }>) satisfies {
  type: "finish";
  finishReason: string;
});
void ((null as unknown as Extract<SdkStreamPart, { type: "raw" }>) satisfies {
  type: "raw";
  rawValue: unknown;
});

/** Minimal real `LanguageModelUsage` fixture for finish parts. */
function usage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: input,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: output,
    outputTokenDetails: {
      textTokens: output,
      reasoningTokens: 0,
    },
    totalTokens: input + output,
  };
}

describe("sdkErrorStatus (duck-typing primary)", () => {
  test("extracts a numeric statusCode from any structurally-shaped error", () => {
    expect(sdkErrorStatus({ statusCode: 429 })).toBe(429);
    expect(sdkErrorStatus({ statusCode: 502, message: "bad gateway" })).toBe(502);
  });

  test("extracts a numeric status from any structurally-shaped error", () => {
    expect(sdkErrorStatus({ status: 503 })).toBe(503);
    expect(sdkErrorStatus({ status: 404, message: "not found" })).toBe(404);
  });

  test("prefers statusCode over status when both are present", () => {
    expect(sdkErrorStatus({ statusCode: 429, status: 503 })).toBe(429);
  });

  test("is undefined for abort-shaped, shapeless, and non-object errors", () => {
    expect(sdkErrorStatus({ name: "AbortError" })).toBeUndefined();
    expect(sdkErrorStatus(new Error("boom"))).toBeUndefined();
    expect(sdkErrorStatus(undefined)).toBeUndefined();
    expect(sdkErrorStatus(null)).toBeUndefined();
    expect(sdkErrorStatus("rate limited")).toBeUndefined();
  });

  test("is undefined for a real DOMException AbortError (not an HTTP error)", () => {
    expect(sdkErrorStatus(new DOMException("aborted", "AbortError"))).toBeUndefined();
  });

  test("reinforcement: real SDK classes still map through isInstance", () => {
    const api429 = new APICallError({
      message: "rate limited",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "rate limited",
      isRetryable: true,
    });
    expect(sdkErrorStatus(api429)).toBe(429);
    expect(sdkErrorStatus(new NoSuchModelError({
      modelId: "gpt-4o",
      modelType: "languageModel",
    }))).toBe(404);
  });

  test("reinforcement: APICallError without statusCode falls back to 500", () => {
    const apiError = new APICallError({
      message: "boom",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
    });
    expect(sdkErrorStatus(apiError)).toBe(500);
  });

  test("reinforcement: RetryError walks errors[] and lastError", () => {
    const api429 = new APICallError({
      message: "rate limited",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "rate limited",
      isRetryable: true,
    });
    const retry = new RetryError({
      message: "max retries exceeded",
      reason: "maxRetriesExceeded",
      errors: [new Error("first"), api429],
    });
    expect(sdkErrorStatus(retry)).toBe(429);

    const retryWithLast = new RetryError({
      message: "error not retryable",
      reason: "errorNotRetryable",
      errors: [new Error("first")],
    });
    expect(sdkErrorStatus(retryWithLast)).toBeUndefined();
  });
});

describe("isAbortError", () => {
  test("recognizes DOMException and Error AbortErrors", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  test("rejects plain objects and non-abort errors", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(false);
    expect(isAbortError(new Error("boom"))).toBe(false);
  });
});

describe("isTerminalWireChunk (terminal = finish_reason, not last chunk)", () => {
  test("a real wire stream ending in a usage tail has exactly one terminal chunk", () => {
    const wireStream = [
      { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      // usage tail AFTER the terminal chunk: choices is empty, so NOT terminal
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
    expect(wireStream.map(isTerminalWireChunk)).toEqual([false, false, true, false]);
  });

  test("non-empty finish_reason in choices[0] is terminal (length, tool_calls…)", () => {
    expect(isTerminalWireChunk({ choices: [{ delta: {}, finish_reason: "length" }] })).toBe(true);
    expect(isTerminalWireChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })).toBe(true);
  });

  test("usage-only tails and delta chunks are NOT terminal", () => {
    expect(isTerminalWireChunk({
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })).toBe(false);
    expect(isTerminalWireChunk({
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    })).toBe(false);
  });

  test("non-chunk values are never terminal", () => {
    expect(isTerminalWireChunk(null)).toBe(false);
    expect(isTerminalWireChunk("data")).toBe(false);
    expect(isTerminalWireChunk({})).toBe(false);
    expect(isTerminalWireChunk({ choices: [] })).toBe(false);
    expect(isTerminalWireChunk({ choices: [{}] })).toBe(false);
  });
});

describe("fullStream part type guards", () => {
  test("isTextDeltaPart reads the REAL field: `.text`, not `.textDelta`", () => {
    expect(isTextDeltaPart({ type: "text-delta", id: "t1", text: "hello" })).toBe(true);
    expect(isTextDeltaPart({ type: "text-start", id: "t1" })).toBe(false);
    expect(isTextDeltaPart({ type: "raw", rawValue: { choices: [] } })).toBe(false);
  });

  test("isToolCallPart reads toolCallId / toolName / input", () => {
    expect(isToolCallPart({
      type: "tool-call",
      toolCallId: "call_9",
      toolName: "getWeather",
      input: { city: "Buenos Aires" },
    })).toBe(true);
    expect(isToolCallPart({
      type: "tool-result",
      toolCallId: "call_9",
      toolName: "getWeather",
      input: { city: "Buenos Aires" },
      output: null,
    })).toBe(false);
    expect(isToolCallPart({ type: "text-delta", id: "t1", text: "x" })).toBe(false);
  });

  test("isFinishPart reads finishReason + totalUsage", () => {
    expect(isFinishPart({
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: usage(5, 2),
    })).toBe(true);
    expect(isFinishPart({ type: "start" })).toBe(false);
  });

  test("isRawPart reads rawValue (the verbatim wire chunk)", () => {
    expect(isRawPart({
      type: "raw",
      rawValue: { id: "chatcmpl-fake", choices: [{ delta: {}, finish_reason: "stop" }] },
    })).toBe(true);
    expect(isRawPart({ type: "text-delta", id: "t1", text: "x" })).toBe(false);
  });

  test("isErrorPart reads the error to rethrow", () => {
    expect(isErrorPart({ type: "error", error: new Error("boom") })).toBe(true);
    expect(isErrorPart({ type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: usage(1, 1) })).toBe(false);
  });

  test("isAbortPart matches the field-less abort part", () => {
    expect(isAbortPart({ type: "abort" })).toBe(true);
    expect(isAbortPart({ type: "abort", reason: "requested" })).toBe(true);
    expect(isAbortPart({ type: "error", error: new Error("x") })).toBe(false);
  });
});