/**
 * OpenRouter provider adapter (binding: OpenRouter is a first-class
 * provider). OpenRouter speaks the OpenAI wire format, so this is a thin
 * binding over the shared HTTP core with the OpenRouter base URL and a
 * `models` list local to the provider.
 */
import { makeOpenAIWireProvider, type HttpProviderOptions } from "./http-core.js";
import type { ExternalProviderAdapter } from "./adapters.js";

export function makeOpenRouterAdapter(
  opts: Omit<HttpProviderOptions, "kind" | "name" | "baseUrl">,
): ExternalProviderAdapter {
  return makeOpenAIWireProvider({
    ...opts,
    kind: "openrouter",
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  });
}