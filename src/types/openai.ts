/**
 * OpenAI wire-format types.
 *
 * These mirror the OpenAI REST API shapes (chat completions, completions,
 * models, errors) so the gateway can act as a drop-in OpenAI-compatible
 * endpoint. Keeping them as explicit interfaces (rather than just passing JSON
 * around) is the whole point of the JS→TS rewrite: every handler and provider
 * adapter reads and writes these exact shapes, so a field rename or a missing
 * property is caught at compile time instead of at runtime.
 */

/** A content part inside an array-form message (image/url bodies etc.). */
export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** A single chat message. Content may be a scalar string or an array of parts. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** A requested/emitted tool call. */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Standard OpenAI chat completion request body. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  n?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  [key: string]: unknown;
}

/** A completion choice in a non-streaming chat response. */
export interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string | string[] | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string | null;
  logprobs?: unknown;
}

/** Usage block attached to non-streaming completions. */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Non-streaming OpenAI chat completion response. */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
}

/** A streaming token delta inside a chat completion chunk. */
export interface ChatCompletionDelta {
  role?: string;
  content?: string | null;
  tool_calls?: ToolCall[];
}

/** Streaming chat completion chunk (SSE `data:` payload). */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionDelta;
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

/** Legacy text completions request (the /v1/completions endpoint). */
export interface CompletionRequest {
  model: string;
  prompt: string | string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

/** Non-streaming text completion response. */
export interface CompletionResponse {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: Array<{
    text: string;
    index: number;
    logprobs: unknown;
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

/** Model listing entry. */
export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  permission?: unknown[];
  root?: string;
  parent?: string | null;
  description?: string;
}

/** Model listing response. */
export interface ModelListResponse {
  object: "list";
  data: ModelInfo[];
}

/** Normalized OpenAI-shaped error envelope. */
export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}
