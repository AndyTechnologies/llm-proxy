/**
 * Config bootstrap.
 *
 * Entry point for loading + validating the gateway config. Honors the
 * CONFIG_FILE env var (default "./llm-proxy.config.yaml") and returns a typed
 * GatewayConfig. Chains are normalized so their steps carry a default provider.
 *
 * .env loading is Bun-native (runtime dotenv): `.env < .env.{NODE_ENV} <
 * .env.local`, with already-exported process env winning. The explicit
 * `dotenv/config` import is gone; the loader only READS process.env and never
 * clobbers it.
 */
import { configSchema, type GatewayConfig } from "./schema.js";
import { loadRawConfig, type LoaderDeps } from "./load.js";

/** Default config file path, overridable via CONFIG_FILE. */
export const DEFAULT_CONFIG_FILE = "./llm-proxy.config.yaml";

/** Load the config from disk and validate it with zod. */
export async function loadGatewayConfig(
  configPath?: string,
  deps?: LoaderDeps,
): Promise<GatewayConfig> {
  const file = configPath ?? process.env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;
  const raw = await loadRawConfig(file, deps);
  const parsed = configSchema.parse(raw);

  // Inject chain name from the record key and normalize default provider.
  for (const [name, chain] of Object.entries(parsed.chains)) {
    chain.name = name;
    const defaultProvider = chain.provider ?? chain.defaultProvider ?? "llama-server";
    for (const step of chain.steps) {
      if (!step.provider) {
        step.provider = defaultProvider;
      }
    }
  }

  return parsed;
}