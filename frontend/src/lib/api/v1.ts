/**
 * Typed client for the OpenAI-compatible /v1 surface (real backend:
 * src/routes/v1.ts). The console exercises exactly the wire paths that
 * exist server-side:
 *
 *   POST /v1/chat/completions — JSON completion when `stream: false`;
 *   the same endpoint with `stream: true` returns OpenAI-wire SSE: one
 *   `data: {JSON}\n\n` frame per chunk, terminated by EXACTLY one
 *   `data: [DONE]\n\n` (src/routes/relay.ts). Client disconnect makes the
 *   server abort the upstream call (v1.ts streamResponse).
 *
 * Error mapping keeps the backend envelope VERBATIM. /v1 errors use the
 * OpenAI shape `{error:{message,type,param,code}}` — 401 from the Bearer
 * gate (src/routes/v1.ts auth branch), 404 model_not_found, 4xx/5xx from
 * the provider gate. They are thrown as ApiError with the parsed envelope
 * carried on `errors`, so the UI renders what the server actually said.
 *
 * This client NEVER sets an Authorization header. Auth lives server-side
 * (WEAVELLM_AUTH gate, src/routes/auth.ts); if the server demands a Bearer
 * key it answers 401 and the playground shows that envelope verbatim.
 *
 * No Svelte/Astro imports — importable under bun:test with an injected
 * fetch and/or origin.
 */

import { getApiOrigin } from "./config.js";
import { ApiError } from "./http.js";
import { dataField, decodeTokenData } from "../sse.js";

export type V1Role = "system" | "user" | "assistant";

export interface V1ChatMessage {
  role: V1Role;
  content: string;
}

/** Request body sent to POST /v1/chat/completions. */
export interface V1ChatRequest {
  model: string;
  messages: V1ChatMessage[];
  temperature?: number;
  stream: boolean;
}

/** usage on the completed wire body — verbatim, only when the server sent it. */
export interface V1Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface V1CompletionChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string | null;
}

/** Non-stream completion body (object: "chat.completion"). */
export interface V1Completion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: V1CompletionChoice[];
  usage: V1Usage | null;
}

/**
 * One parsed SSE data payload on the streaming wire. External adapters can
 * add extra fields (usage in the final chunk, tool calls, ...) — the index
 * signatures keep the frame VERBATIM; the UI renders the raw wire text and
 * never fabricates fields from these.
 */
export interface V1ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string; [field: string]: unknown };
    finish_reason?: string | null;
  }>;
  [field: string]: unknown;
}

/** Events yielded by `chatCompletionStream`, in wire order. */
export type V1StreamEvent =
  | { readonly type: "frame"; readonly payload: V1ChatChunk }
  | { readonly type: "done" }
  | { readonly type: "truncated" }
  | { readonly type: "aborted" };

/** Rolled-up stream summary handed to `onDone`. */
export interface V1StreamSummary {
  /** True when the terminal `data: [DONE]` frame was received. */
  done: boolean;
  /** Raw SSE text as received, verbatim (frames + separators). */
  raw: string;
  /** Concatenated assistant text via decodeTokenData semantics. */
  content: string;
  /** Number of parsed JSON data frames (excludes [DONE]). */
  frames: number;
}

export interface V1ClientOptions {
  /** Override the API origin (defaults to getApiOrigin()). */
  origin?: string;
  /** Inject a fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort the request. */
  signal?: AbortSignal;
  /**
   * Non-stream timeout in ms (default 60_000 — a local completion can take
   * minutes). Streams have NO timeout: they run until [DONE] or abort.
   */
  timeoutMs?: number;
}

/** Incremental SSE frame state — mutated by splitSSEFrames across chunks. */
export interface SSEFrameState {
  rest: string;
}

/** SSE event separator: blank line between events, LF or CRLF (relay: \n\n). */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Feed one decoded text chunk into `state`, returning every COMPLETE SSE
 * frame it closes (frame body only, separator stripped). An unterminated
 * tail stays in `state.rest` until a later chunk completes it. Safe across
 * ANY chunk boundary, LF/CRLF separators, and multiple frames per chunk.
 */
export function splitSSEFrames(state: SSEFrameState, chunk: string): string[] {
  state.rest += chunk;
  const frames: string[] = [];
  for (;;) {
    const match = FRAME_SEPARATOR.exec(state.rest);
    if (match === null) break;
    frames.push(state.rest.slice(0, match.index));
    state.rest = state.rest.slice(match.index + match[0].length);
  }
  return frames;
}

/** OpenAI /v1 error body: {error:{message,...}} or a bare {error:string}. */
interface V1ErrorEnvelope {
  error:
    | { message: string; type?: string | null; param?: unknown; code?: string | null }
    | string;
}

function isV1ErrorEnvelope(value: unknown): value is V1ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return true;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/**
 * Map a non-2xx /v1 response onto ApiError with the envelope VERBATIM in
 * `errors`: the parsed OpenAI body when JSON, the raw text otherwise.
 */
export function v1ErrorFrom(status: number, rawText: string): ApiError {
  let envelope: unknown = null;
  let message = "";
  let code = "";
  if (rawText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawText) as unknown;
      envelope = parsed;
      if (isV1ErrorEnvelope(parsed)) {
        if (typeof parsed.error === "string") {
          message = parsed.error;
        } else {
          message = parsed.error.message;
          // The envelope's own code wins when present (e.g. model_not_found);
          // ApiError.code stays a stable discriminator for the UI hints.
          if (typeof parsed.error.code === "string" && parsed.error.code.length > 0) {
            code = parsed.error.code;
          }
        }
      }
    } catch {
      envelope = rawText; // non-JSON error body — keep it verbatim
    }
  }
  const fallback = `http_${status}`;
  return new ApiError({
    status,
    code: code !== "" ? code : message !== "" ? message : fallback,
    message: message !== "" ? message : fallback,
    errors: envelope,
  });
}

/** Shared /v1 payload builder — only fields the user actually set. */
function payloadOf(body: V1ChatRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    stream: body.stream,
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  return payload;
}

/**
 * One-shot (non-streaming) chat completion. Resolves with the parsed
 * `chat.completion` body, or throws ApiError carrying the backend envelope
 * verbatim (401 Bearer-required, 404 unknown-model, provider 4xx/5xx).
 */
export async function chatCompletion(
  body: V1ChatRequest,
  options: V1ClientOptions = {},
): Promise<V1Completion> {
  const origin = options.origin ?? getApiOrigin();
  const fetchImpl = options.fetchImpl ?? fetch;
  const externalSignal = options.signal;

  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetchImpl(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payloadOf(body)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (externalSignal?.aborted === true) {
      throw new ApiError({ status: 0, code: "aborted", message: "request aborted" });
    }
    if (controller.signal.aborted) {
      throw new ApiError({ status: 0, code: "request_timeout", message: "request_timeout" });
    }
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: (err as Error)?.message ?? "network_error",
    });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw v1ErrorFrom(res.status, text);
  }
  const text = await res.text();
  if (text.length === 0) {
    throw new ApiError({ status: 0, code: "invalid_json", message: "empty response body" });
  }
  try {
    return JSON.parse(text) as V1Completion;
  } catch {
    throw new ApiError({ status: 0, code: "invalid_json", message: "response body is not JSON" });
  }
}

export interface ChatStreamHandlers {
  /** Every raw decoded text chunk of the SSE body, verbatim. */
  onRaw: (chunk: string) => void;
  /**
   * Terminal summary, called exactly once after [DONE] or on truncation.
   * Never called on abort — the consumer observes the `aborted` event.
   */
  onDone?: (summary: V1StreamSummary) => void;
  /** Aborts the fetch and closes the reader; the server aborts upstream. */
  signal?: AbortSignal;
}

function streamSummary(raw: string, frames: number, done: boolean): V1StreamSummary {
  return { done, raw, frames, content: decodeTokenData(raw).content };
}

/**
 * Streaming chat completion. Async generator over wire events in order
 * (`frame` → ... → `done`; `truncated` when the body ended without the
 * terminal [DONE]; `aborted` when `signal` fired). Raw text goes to
 * `handlers.onRaw` as it arrives so the UI renders the live transcript;
 * JSON frames are yielded parsed; the rolled-up content reuses
 * decodeTokenData semantics on the aggregated buffer.
 *
 * Non-2xx responses throw ApiError with the envelope verbatim BEFORE any
 * event is yielded. Aborting the signal makes the generator yield `aborted`
 * and close the reader — the browser closes the socket, so the server's
 * relay unwinds and aborts the upstream call (v1.ts contract).
 */
export async function* chatCompletionStream(
  body: V1ChatRequest,
  handlers: ChatStreamHandlers,
  options: V1ClientOptions = {},
): AsyncGenerator<V1StreamEvent> {
  const origin = options.origin ?? getApiOrigin();
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = handlers.signal;

  let res: Response;
  try {
    res = await fetchImpl(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(payloadOf(body)),
      signal,
    });
  } catch (err) {
    if (signal?.aborted === true) {
      yield { type: "aborted" };
      return;
    }
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: (err as Error)?.message ?? "network_error",
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw v1ErrorFrom(res.status, text);
  }
  if (res.body === null) {
    throw new ApiError({ status: 0, code: "network_error", message: "empty stream body" });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state: SSEFrameState = { rest: "" };
  let readError: unknown = null;
  let raw = "";
  let frames = 0;
  let finished = false;

  try {
    readerLoop: for (;;) {
      // read() never rejects here: an errored read resolves done and sets
      // readError, so abandoning the generator mid-read can never leave an
      // unhandled rejection behind.
      const result = await reader.read().catch((err: unknown): ReadableStreamReadResult<Uint8Array> => {
        readError = err;
        return { done: true, value: new Uint8Array(0) };
      });
      if (result.done) break;

      const text = decoder.decode(result.value, { stream: true });
      raw += text;
      handlers.onRaw(text);

      for (const frame of splitSSEFrames(state, text)) {
        const payloadText = dataField(frame);
        if (payloadText === null) continue;
        if (payloadText === "[DONE]") {
          finished = true;
          yield { type: "done" };
          break readerLoop;
        }
        try {
          frames += 1;
          yield { type: "frame", payload: JSON.parse(payloadText) as V1ChatChunk };
        } catch {
          // Non-JSON data frame — kept in the raw transcript, not thrown.
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A read is still pending (consumer abandoned the generator without
      // aborting): cancelling the body makes the server see the disconnect.
      void reader.cancel().catch(() => {});
    }
  }

  if (readError !== null) {
    if (signal?.aborted === true) {
      yield { type: "aborted" };
      return;
    }
    throw new ApiError({
      status: 0,
      code: "network_error",
      message: (readError as Error)?.message ?? "stream read failed",
    });
  }

  if (!finished) yield { type: "truncated" };
  handlers.onDone?.(streamSummary(raw, frames, finished));
}