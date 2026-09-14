/**
 * OpenAI provider adapter (binding: OpenAI is a first-class provider).
 * OpenAI speaks the OpenAI wire format natively, so this is a thin binding
 * over the shared HTTP core with the OpenAI base URL.
 */
import { makeOpenAIWireProvider, type HttpProviderOptions } from "./http-core.js";
import type { ExternalProviderAdapter } from "./adapters.js";

export function makeOpenAIAdapter(
  opts: Omit<HttpProviderOptions, "kind" | "name"> &
    Partial<Pick<HttpProviderOptions, "baseUrl">>,
): ExternalProviderAdapter {
  return makeOpenAIWireProvider({
    ...opts,
    kind: "openai",
    name: "openai",
    baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
  });
}