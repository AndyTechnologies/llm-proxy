/**
 * ID generation for completion responses.
 *
 * Generates OpenAI-style `cmpl-<hex>` and `chatcmpl-<hex>` identifiers
 * using crypto.getRandomValues (Web Crypto API — native in Bun). The prefix
 * distinguishes text completions from chat completions, matching the OpenAI
 * convention.
 */

function randomHex(len: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate a unique completion ID (e.g. `cmpl-a1b2c3d4e5f6`). */
export function makeCompletionId(): string {
  return `cmpl-${randomHex(12)}`;
}

/** Generate a unique chat completion ID (e.g. `chatcmpl-a1b2c3d4e5f6`). */
export function makeChatCompletionId(): string {
  return `chatcmpl-${randomHex(12)}`;
}
