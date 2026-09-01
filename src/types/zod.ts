/**
 * Zod schemas for incoming request body validation.
 *
 * These run BEFORE the request reaches the proxy/orchestrator layer, rejecting
 * malformed payloads with a normalized OpenAI 400 error. Keeping them separate
 * from the TypeScript interfaces lets the interfaces stay permissive (so we
 * can extend them) while the runtime validation stays strict.
 */
import { z } from "zod";

/** Chat message content: scalar string or array of typed parts. */
const ContentPartSchema = z.record(z.unknown());
const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "developer", "tool"]),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});

/** Chat completions request body. */
export const chatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema).min(1, "messages must not be empty"),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().positive().optional(),
  seed: z.number().optional(),
  user: z.string().optional(),
  /*
   * SSRF guard note: we deliberately do NOT .strict() here. OpenAI-compatible
   * clients legitimately send extra fields (tools, tool_choice,
   * response_format, logprobs, presence_penalty, ...). Rejecting all unknown
   * keys would break compatibility. The SSRF protection lives at the routing
   * layer: the upstream URL is always derived from server config, never from a
   * body field, and the payload sanitizer strips URL-bearing keys before
   * forwarding.
   */
});

/** Legacy text completions request body. */
export const completionRequestSchema = z.object({
  model: z.string(),
  prompt: z.union([z.string(), z.array(z.string())]),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().positive().optional(),
  seed: z.number().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  user: z.string().optional(),
  /* Same SSRF rationale as chat: not .strict(), validate known types only,
     and leave URL-bearing fields to the sanitizer. */
});

export type ChatCompletionRequestParsed = z.infer<typeof chatCompletionRequestSchema>;
export type CompletionRequestParsed = z.infer<typeof completionRequestSchema>;
