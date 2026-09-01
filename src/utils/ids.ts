/**
 * ID generation for completion responses.
 *
 * Generates OpenAI-style `cmpl-<hex>` and `chatcmpl-<hex>` identifiers
 * using crypto.randomUUID under the hood. The prefix distinguishes text
 * completions from chat completions, matching the OpenAI convention.
 */
import { randomBytes } from "node:crypto";

/** Generate a unique completion ID (e.g. `cmpl-a1b2c3d4e5f6`). */
export function makeCompletionId(): string {
  return `cmpl-${randomBytes(12).toString("hex")}`;
}

/** Generate a unique chat completion ID (e.g. `chatcmpl-a1b2c3d4e5f6`). */
export function makeChatCompletionId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}
