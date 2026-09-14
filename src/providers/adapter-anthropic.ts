/**
 * Anthropic provider adapter (binding: Anthropic is a first-class provider).
 * Anthropic speaks its own Messages API, so this adapter translates the OpenAI
 * wire request → Anthropic Messages request, and Anthropic responses/SSE back
 * into OpenAI wire shapes (chat.completion / chat.completion.chunk) so the
 * /v1 surface and tool_calls_route routing stay provider-agnostic.
 *
 * The translation functions are pure and exported for direct unit tests;
 * fetch integration is injectable via `fetcher`.
 */
import { ProviderMisconfiguredError, type ExternalProviderAdapter, type ProviderKind } from "./adapters.js";
import type { HttpFetcher } from "./http-core.js";
import { makeChatCompletionId } from "../utils/ids.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const KIND: ProviderKind = "anthropic";

/* ------------------------------------------------------------------ *
 * OpenAI → Anthropic request translation
 * ------------------------------------------------------------------ */

interface AnthropicMessage {
  role: "user" | "assistant";
  content: unknown;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
}

interface OpenAiMessage {
  role: string;
  content: string | unknown[];
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

/** Anthropic messages forbid a system role — fold it into `system`. */
function translateMessage(msg: OpenAiMessage): AnthropicMessage | null {
  if (msg.role === "system") return null;
  if (msg.role === "tool") {
    const blocks: AnthropicToolResultBlock[] = [
      {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: typeof msg.content === "string" ? msg.content : "",
      },
    ];
    return { role: "user", content: blocks };
  }
  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const blocks: Array<{ type: "text"; text: string } | AnthropicToolUseBlock> = [];
    if (typeof msg.content === "string" && msg.content.length > 0) {
      blocks.push({ type: "text", text: msg.content });
    }
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parseJsonArguments(tc.function.arguments),
      });
    }
    return { role: "assistant", content: blocks };
  }
  return { role: msg.role === "assistant" ? "assistant" : "user", content: msg.content };
}

function parseJsonArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function translateTools(tools: unknown): AnthropicTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .map((tool): AnthropicTool | null => {
      const t = tool as OpenAiTool;
      if (t?.type !== "function" || !t.function?.name) return null;
      return {
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      };
    })
    .filter((t): t is AnthropicTool => t !== null);
}

function translateToolChoice(toolChoice: unknown): AnthropicRequest["tool_choice"] {
  if (typeof toolChoice === "string") {
    if (toolChoice === "none") return { type: "none" };
    if (toolChoice === "required" || toolChoice === "any") return { type: "any" };
    return undefined;
  }
  const tc = toolChoice as { type?: string; function?: { name?: string } };
  if (tc?.type === "function" && typeof tc.function?.name === "string") {
    return { type: "tool", name: tc.function.name };
  }
  return undefined;
}

/** Translate an OpenAI chat completion request into an Anthropic Messages body. */
export function translateChatRequestToAnthropic(
  request: Record<string, unknown>,
): AnthropicRequest {
  const messages = (request.messages as OpenAiMessage[] | undefined) ?? [];
  const systemParts: string[] = [];
  const translated: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      continue;
    }
    const out = translateMessage(msg);
    if (out !== null) translated.push(out);
  }

  const requestMax =
    typeof request.max_tokens === "number"
      ? request.max_tokens
      : typeof request.max_completion_tokens === "number"
        ? request.max_completion_tokens
        : undefined;

  const body: AnthropicRequest = {
    model: typeof request.model === "string" ? request.model : "",
    max_tokens: requestMax ?? DEFAULT_MAX_TOKENS,
    messages: translated,
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number" && request.top_p > 0 && request.top_p <= 1) {
    body.top_p = request.top_p;
  }
  if (typeof request.stop === "string") body.stop_sequences = [request.stop];
  if (Array.isArray(request.stop)) body.stop_sequences = request.stop as string[];
  if (typeof request.stream === "boolean") body.stream = request.stream;

  const tools = translateTools(request.tools);
  if (tools !== undefined && tools.length > 0) {
    body.tools = tools;
    const choice = translateToolChoice(request.tool_choice);
    if (choice !== undefined) body.tool_choice = choice;
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * Anthropic → OpenAI response translation
 * ------------------------------------------------------------------ */

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

/** Map an Anthropic response into the OpenAI chat.completion envelope. */
export function anthropicResponseToOpenAI(
  body: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  const content = (body.content as Array<Record<string, unknown>> | undefined) ?? [];
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("");
  const toolUses = content.filter((b) => b.type === "tool_use");
  const usage = (body.usage ?? {}) as AnthropicUsage;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text,
  };
  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((tu) => ({
      id: tu.id,
      type: "function",
      function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
    }));
  }

  return {
    id: makeChatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON_MAP[String(body.stop_reason ?? "")] ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Anthropic → OpenAI streaming event translation
 * ------------------------------------------------------------------ */

/** Streaming translation state (tool-call metadata per block index). */
export interface AnthropicStreamState {
  toolCalls: Map<number, { id: string; name: string; argumentsEmitted: boolean }>;
  sawStart: boolean;
}

export function newAnthropicStreamState(): AnthropicStreamState {
  return { toolCalls: new Map(), sawStart: false };
}

function openaiChunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id: makeChatCompletionId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage !== undefined ? { usage } : {}),
  });
}

/**
 * Translate one Anthropic SSE event payload into zero or more OpenAI wire
 * chunks. Unknown/bookkeeping events yield no chunks ([]).
 */
export function anthropicEventToChunk(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
): string[] {
  const type = event.type;
  const index = typeof event.index === "number" ? event.index : 0;

  if (type === "message_start" && !state.sawStart) {
    state.sawStart = true;
    return [openaiChunk({ role: "assistant", content: "" }, null)];
  }

  if (type === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use") {
      state.toolCalls.set(index, {
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        argumentsEmitted: false,
      });
      return [
        openaiChunk({
          tool_calls: [
            {
              index,
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            },
          ],
        }, null),
      ];
    }
    return [];
  }

  if (type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return [openaiChunk({ content: delta.text }, null)];
    }
    if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const meta = state.toolCalls.get(index);
      const toolCall: Record<string, unknown> = {
        index,
        type: "function",
        function: { arguments: delta.partial_json },
      };
      if (meta !== undefined && !meta.argumentsEmitted) {
        toolCall.id = meta.id;
        (toolCall.function as Record<string, unknown>).name = meta.name;
        meta.argumentsEmitted = true;
      }
      return [openaiChunk({ tool_calls: [toolCall] }, null)];
    }
    return [];
  }

  if (type === "message_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    const usage = event.usage as Record<string, unknown> | undefined;
    const reason = STOP_REASON_MAP[String(delta?.stop_reason ?? "")] ?? null;
    return [
      openaiChunk({}, reason, usage === undefined ? undefined : {
        prompt_tokens: 0,
        completion_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        total_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      }),
    ];
  }

  if (type === "content_block_stop" || type === "message_stop" || type === "ping") {
    return [];
  }

  if (type === "error") {
    const error = event.error as Record<string, unknown> | undefined;
    throw new Error(
      `anthropic stream error: ${error?.message ?? "unknown"}`,
    );
  }

  return [];
}

/* ------------------------------------------------------------------ *
 * Adapter (fetch integration)
 * ------------------------------------------------------------------ */

export interface AnthropicAdapterOptions {
  baseUrl: string;
  keyResolver: () => Promise<string | null>;
  headers: Record<string, string>;
  models: string[];
  fallbackId?: string | null;
  /** Set by the registry when no key is stored; default false. */
  misconfigured?: boolean;
  fetcher?: HttpFetcher;
}

/** Build the Anthropic Provider adapter. */
export function makeAnthropicAdapter(opts: AnthropicAdapterOptions): ExternalProviderAdapter {
  const baseURL = opts.baseUrl.replace(/\/$/, "");
  const fetcher = opts.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init));

  const buildHeaders = async (): Promise<Record<string, string>> => {
    const key = await opts.keyResolver();
    if (key === null) throw new ProviderMisconfiguredError(KIND);
    return {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      ...opts.headers,
    };
  };

  /** SSE reader that yields {event, data} pairs. */
  async function* anthropicSse(res: Response): AsyncIterable<{ event: string; data: string }> {
    if (!res.body) throw new Error("anthropic returned no response body for streaming");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingEvent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (data !== "") yield { event: pendingEvent !== "" ? pendingEvent : event, data };
        pendingEvent = "";
      }
    }
  }

  return {
    name: "anthropic",
    kind: KIND,
    models: opts.models,
    requiresKey: true,
    misconfigured: opts.misconfigured ?? false,
    fallbackId: opts.fallbackId ?? null,

    async chat(request: Record<string, unknown>, _chainName?: string) {
      const headers = await buildHeaders();
      const body = translateChatRequestToAnthropic(request);
      const res = await fetcher(`${baseURL}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(
          `anthropic error ${res.status}: ${text.slice(0, 300)}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`anthropic returned invalid JSON: ${text.slice(0, 200)}`);
      }
      return anthropicResponseToOpenAI(parsed, String(request.model ?? ""));
    },

    async *chatStream(
      request: Record<string, unknown>,
      signal: AbortSignal,
    ): AsyncIterable<string> {
      const headers = await buildHeaders();
      const body = translateChatRequestToAnthropic({ ...request, stream: true });
      let res: Response;
      try {
        res = await fetcher(`${baseURL}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        throw err;
      }
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(
          `anthropic error ${res.status}: ${text.slice(0, 300)}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

      const state = newAnthropicStreamState();
      for await (const { event: _eventName, data } of anthropicSse(res)) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const chunk of anthropicEventToChunk(payload, state)) {
          yield chunk;
        }
      }
    },
  };
}