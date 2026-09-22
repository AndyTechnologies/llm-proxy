/**
 * Pure SSE-frame decoding for workflow run token events (frontend, U07).
 *
 * The backend's WS token event carries OpenAI-wire SSE text in `data`
 * (src/app/ws.ts): one `data: {JSON}\n\n` frame per token event, ended by
 * exactly one `data: [DONE]\n\n`. This module decodes ANY number of frames
 * defensively — the completed-run relay sends a chat.completion object, a
 * live-streaming relay would send chat.completion.chunk deltas — plus the
 * mirror encoder the local one-shot fallback uses so its output feeds the
 * same transcript path as a live run. No IO, no Svelte: importable under
 * bun:test.
 */

export interface DecodedTokenData {
  /** Concatenated text content of all non-terminal data frames. */
  content: string;
  /** True once a `data: [DONE]` frame terminated the stream. */
  done: boolean;
}

/** SSE event separator (blank line between events; CRLF tolerated). */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Extract the concatenated `data:` field payloads of a single SSE frame.
 * One leading space after the colon is stripped (SSE field-value rule);
 * frames with no `data:` field (comments, event/retry fields) are ignored.
 */
function dataField(frame: string): string | null {
  const lines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice("data:".length);
      lines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Extract assistant text from one OpenAI-wire data payload, or null. */
function completionText(payload: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null; // non-JSON data frame → nothing extractable, skip quietly
  }
  if (typeof value !== "object" || value === null) return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return null;
  const { message, delta } = choice as { message?: unknown; delta?: unknown };
  for (const holder of [message, delta]) {
    if (typeof holder !== "object" || holder === null) continue;
    const content = (holder as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return null;
}

/**
 * Decode one `token.data` payload into aggregate content and the terminal
 * flag. Handles multiple frames per event, CRLF separators, multi-line
 * `data:` fields and both completion and chunk JSON shapes defensively —
 * frames without extractable text are skipped, never thrown.
 */
export function decodeTokenData(data: string): DecodedTokenData {
  let content = "";
  let done = false;
  for (const frame of data.split(FRAME_SEPARATOR)) {
    const payload = dataField(frame);
    if (payload === null) continue;
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    const text = completionText(payload);
    if (text !== null) content += text;
  }
  return { content, done };
}

/**
 * OpenAI-wire token frame for one finished completion — the shape the
 * backend relays after a run. Local one-shot runs encode their output with
 * this so the transcript decodes it identically to a live run.
 */
export function encodeTokenFrame(content: string): string {
  const completion = {
    id: "cmpl-local",
    object: "chat.completion",
    created: 0,
    model: "workflow",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: null,
  };
  return `data: ${JSON.stringify(completion)}\n\n`;
}