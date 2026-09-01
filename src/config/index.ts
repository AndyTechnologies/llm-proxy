/**
 * Config bootstrap.
 *
 * Entry point for loading + validating the gateway config. Honors the
 * CONFIG_FILE env var (default "./llm-proxy.config.yaml") and returns a typed
 * GatewayConfig. Chains are normalized so their steps carry a default provider.
 */
import "dotenv/config";
import { configSchema, type GatewayConfig } from "./schema.js";
import { loadRawConfig } from "./load.js";

/** Default config file path, overridable via CONFIG_FILE. */
export const DEFAULT_CONFIG_FILE = "./llm-proxy.config.yaml";

/** Load the config from disk and validate it with zod. */
export function loadGatewayConfig(configPath?: string): GatewayConfig {
  const file = configPath ?? process.env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;
  const raw = loadRawConfig(file);
  const parsed = configSchema.parse(raw);

  // Normalize chains: default provider for any step that omits it.
  for (const chain of Object.values(parsed.chains)) {
    const defaultProvider = chain.provider ?? chain.defaultProvider ?? "llama-server";
    for (const step of chain.steps) {
      if (!step.provider) {
        step.provider = defaultProvider;
      }
    }
  }

  return parsed;
}
