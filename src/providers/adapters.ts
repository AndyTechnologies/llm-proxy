/**
 * External provider adapter contract (external-providers + binding decision):
 * adapters named adapter-{openai,anthropic,openrouter}.ts implement the
 * Provider seam and expose the extra metadata the /v1 surface needs:
 * the model ids they publish and their key requirement. A provider without
 * a stored key is marked misconfigured and refuses calls instead of sending
 * empty credentials.
 */
import type { Provider } from "./types.js";

export type ProviderKind = "local" | "openai" | "anthropic" | "openrouter";

/** Raised when a provider has no stored key — calls never send empty auth. */
export class ProviderMisconfiguredError extends Error {
  constructor(kind: ProviderKind) {
    super(`provider "${kind}" is misconfigured: no API key stored`);
    this.name = "ProviderMisconfiguredError";
  }
}

/** A Provider plus the metadata the registry and /v1 routes consume. */
export interface ExternalProviderAdapter extends Provider {
  readonly kind: ProviderKind;
  /** Model ids this provider publishes via /v1/models. */
  readonly models: string[];
  /** Whether this provider needs a stored key to operate. */
  readonly requiresKey: boolean;
  /** True when the key is missing — calls throw ProviderMisconfiguredError. */
  readonly misconfigured: boolean;
  /** Provider configured as fallback target (kind id), or null. */
  readonly fallbackId: string | null;
}

/** Build the standard external-provider header set for OpenAI-wire calls. */
export function bearerHeaders(key: string | null): Record<string, string> {
  return key === null ? {} : { Authorization: `Bearer ${key}` };
}