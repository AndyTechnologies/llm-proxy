/**
 * OpenAI-compatible external provider adapter.
 *
 * Implements the `Provider` seam (src/providers/types.ts) on top of the AI SDK
 * (`@ai-sdk/openai-compatible` + `ai`), exposing any OpenAI-compatible HTTP API
 * as a first-class provider behind the gateway. See design.md ADR-1.
 *
 * SDK fragility (error classes, part field shapes, terminal detection) is
 * isolated in `sdk-surface.ts` — this adapter never imports SDK internals
 * directly and only consumes the pinned surface (see its header for the
 * pinned facts). Conventions (pinned by design.md):
 *   - `maxRetries: 0` on every SDK call — the gateway owns retry policy
 *     (on_429 etc.), the adapter never retries on its own.
 *   - Streaming requests `include: { rawChunks: true }` so the verbatim wire
 *     `chat.completion.chunk` objects pass through untouched. The SDK's
 *     text-delta / tool-call / finish parts are only used to synthesize wire
 *     chunks when the upstream sends no raw chunks.
 *   - Non-reserved request keys (top_k, min_p, tools, tool_choice, …) are
 *     spread raw under `providerOptions[<provider name>]`; the SDK provider
 *     merges them into the request body top-level (ADR-4).
 *   - SDK errors are translated to `Error & { status }` so the shared error
 *     handler (src/middleware/errors.ts) maps them to typed responses.
 */
import { generateText, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import { makeChatCompletionId } from "../utils/ids.js";
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
  synthChunk,
  toFinishReason,
  wireUsage,
  type SdkToolCallShape,
} from "./sdk-surface.js";
import type { Provider } from "./types.js";

export interface OpenAICompatibleProviderOptions {
  /** Gateway provider name (also the `providerOptions` body key). */
  name: string;
  /** Base URL of the OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Model ids this provider publishes via the /v1/models endpoint. */
  models: string[];
  /**
   * Test seam: language model factory. Defaults to the real SDK provider
   * (`createOpenAICompatible(...).languageModel(modelId)`), built lazily.
   */
  modelFactory?: (modelId: string) => LanguageModelV4;
}

/**
 * Request keys the adapter consumes itself. Everything else is treated as a
 * raw OpenAI-compatible body field and routed through `providerOptions`.
 */
const RESERVED_KEYS = new Set<string>([
  // structural
  "model",
  "messages",
  "stream",
  // standardized settings (mapped to SDK call settings)
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
]);

/** The raw OpenAI-format messages pass through to the SDK as-is. */
type SdkMessages = NonNullable<Parameters<typeof generateText>[0]["messages"]>;

/**
 * Collect every non-reserved request key under `providerOptions[providerName]`
 * so the SDK provider merges them into the request body top-level.
 */
export function providerOptionsFrom(
  request: Record<string, unknown>,
  providerName: string,
): SharedV4ProviderOptions {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (RESERVED_KEYS.has(key) || value === undefined) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length === 0) return {};
  // The request payload is JSON-typed (zod-validated upstream); the seam types
  // it as `unknown` per key, so the JSONObject boundary cast is unavoidable.
  return { [providerName]: extra } as unknown as SharedV4ProviderOptions;
}

/** Map gateway request fields to the SDK call settings (only when defined). */
function callSettingsFrom(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (request.temperature !== undefined) settings.temperature = request.temperature;
  if (request.top_p !== undefined) settings.topP = request.top_p;
  if (request.max_tokens !== undefined) settings.maxOutputTokens = request.max_tokens;
  if (request.stop !== undefined) {
    settings.stopSequences =
      typeof request.stop === "string" ? [request.stop] : request.stop;
  }
  if (request.seed !== undefined) settings.seed = request.seed;
  if (request.presence_penalty !== undefined) {
    settings.presencePenalty = request.presence_penalty;
  }
  if (request.frequency_penalty !== undefined) {
    settings.frequencyPenalty = request.frequency_penalty;
  }
  return settings;
}

/** Translate any SDK error into `Error & { status }` (shared error handler). */
export function translateSDKError(err: unknown): Error & { status: number } {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { status: sdkErrorStatus(err) ?? 500 });
}

/** Rebuild the non-streaming OpenAI `chat.completion` envelope. */
function rebuildEnvelope(
  result: {
    text: string;
    finishReason: string;
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    toolCalls: SdkToolCallShape[];
  },
  modelId: string,
): Record<string, unknown> {
  const toolCalls = result.toolCalls.map((tc) => ({
    id: tc.toolCallId,
    type: "function",
    function: { name: tc.toolName, arguments: JSON.stringify(tc.input) },
  }));
  return {
    status: 200,
    id: makeChatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toFinishReason(result.finishReason),
      },
    ],
    usage: wireUsage(result.usage),
  };
}

/**
 * Build a `Provider` backed by an OpenAI-compatible HTTP API.
 * See design.md ADR-1 (adapter behind the existing seam, llama-server untouched).
 */
export function makeOpenAICompatibleProvider(
  opts: OpenAICompatibleProviderOptions,
): Provider {
  let sdkProvider: ReturnType<typeof createOpenAICompatible> | undefined;

  const modelFactory =
    opts.modelFactory ??
    ((modelId: string): LanguageModelV4 => {
      sdkProvider ??= createOpenAICompatible({
        name: opts.name,
        baseURL: opts.baseURL,
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        includeUsage: true,
      });
      return sdkProvider.languageModel(modelId);
    });

  return {
    name: opts.name,

    async chat(request: Record<string, unknown>, _chainName?: string) {
      const modelId = typeof request.model === "string" ? request.model : "";
      const model = modelFactory(modelId);
      try {
        const result = await generateText({
          model,
          messages: request.messages as unknown as SdkMessages,
          maxRetries: 0,
          ...callSettingsFrom(request),
          providerOptions: providerOptionsFrom(request, opts.name),
        });
        return rebuildEnvelope(
          result as unknown as {
            text: string;
            finishReason: string;
            usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
            toolCalls: SdkToolCallShape[];
          },
          modelId,
        );
      } catch (err) {
        throw translateSDKError(err);
      }
    },

    async *chatStream(
      request: Record<string, unknown>,
      signal: AbortSignal,
    ): AsyncIterable<string> {
      const modelId = typeof request.model === "string" ? request.model : "";
      const model = modelFactory(modelId);
      let sawRaw = false;
      let sawRawFinish = false;
      try {
        const result = streamText({
          model,
          messages: request.messages as unknown as SdkMessages,
          maxRetries: 0,
          abortSignal: signal,
          include: { rawChunks: true },
          ...callSettingsFrom(request),
          providerOptions: providerOptionsFrom(request, opts.name),
        });
        for await (const part of result.fullStream) {
          if (isRawPart(part)) {
            // verbatim wire chunk (the rawValue IS the wire chat.completion.chunk)
            sawRaw = true;
            if (isTerminalWireChunk(part.rawValue)) sawRawFinish = true;
            yield JSON.stringify(part.rawValue);
            continue;
          }
          if (isTextDeltaPart(part)) {
            // fallback synthesis only used when the upstream sends no raw chunks
            if (sawRaw) continue;
            yield JSON.stringify(
              synthChunk({ delta: { content: part.text } }),
            );
            continue;
          }
          if (isToolCallPart(part)) {
            if (sawRaw) continue;
            yield JSON.stringify(
              synthChunk({
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: part.toolCallId,
                      type: "function",
                      function: {
                        name: part.toolName,
                        arguments: JSON.stringify(part.input),
                      },
                    },
                  ],
                },
              }),
            );
            continue;
          }
          if (isFinishPart(part)) {
            // exactly one terminal chunk: raw finish seen => already emitted
            if (sawRawFinish) continue;
            yield JSON.stringify(
              synthChunk({
                delta: {},
                finish_reason: toFinishReason(part.finishReason),
                usage: wireUsage(part.totalUsage),
              }),
            );
            continue;
          }
          if (isErrorPart(part)) {
            // translated exactly once by the outer catch
            throw part.error;
          }
          if (isAbortPart(part)) {
            // clean stop on client abort
            return;
          }
          // Deliberately NOT exhaustive: `fullStream` also carries ~20
          // bookkeeping part types (text-start/end, reasoning-*, tool-input-*,
          // start/start-step/finish-step, source, file, custom, tool-result,
          // …) that produce no wire chunks; verbatim passthrough ignores them.
          // A `default: never` switch would have to enumerate all of them and
          // would break on ANY SDK part-type addition — the opposite of this
          // isolation layer's goal. The six guards above ARE the consumed
          // surface; everything else falls through untouched.
        }
      } catch (err) {
        if (isAbortError(err)) return;
        throw translateSDKError(err);
      }
    },
  };
}