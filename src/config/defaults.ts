/**
 * Config defaults generation (Slice A — config-load Req "Config defaults
 * generation").
 *
 * When no config file exists, the gateway must still boot. This module
 * generates a minimal schema-valid config by scanning the models directory for
 * `*.gguf` files (case-insensitive) and listing each detected file as a
 * candidate model.
 *
 * The generated config validates against the zod schema so boot succeeds
 * without manual YAML. Detected models are registration CANDIDATES only —
 * auto-registering them into `config.llama.models` requires an explicit apply
 * (per the proposal's out-of-scope note / dashboard-api model-list semantics).
 *
 * Testability (ADR-3 DI): `listFiles`/`expandHome` are injectable via
 * `DefaultsDeps`; the pure `buildDefaultConfig` is the easily-tested core.
 */
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema, type GatewayConfig } from "./schema.js";

/** Injectable filesystem primitives (defaults to real node). */
export interface DefaultsDeps {
  listFiles: (dir: string) => string[];
  expandHome: (p: string) => string;
}

/** Production deps: real readdirSync + os.homedir() expansion. */
export const bunDefaultsDeps: DefaultsDeps = {
  listFiles: (dir) => readdirSync(dir),
  expandHome: (p) =>
    p === "~" || p.startsWith("~/")
      ? path.join(os.homedir(), p.slice(p.startsWith("~/") ? 2 : 1))
      : p,
};

/** Default context/temperature used for a generated candidate model. */
const DEFAULT_CTX = 65536;
const DEFAULT_TEMP = 0.1;

/** Derive the candidate model id from a gguf filename by stripping the extension. */
export function modelIdFromFile(file: string): string {
  return file.replace(/\.gguf$/i, "");
}

/**
 * Build a minimal schema-valid config listing `ggufFiles` as candidate models
 * under the given modelsDir. Pure and fully deterministic.
 */
export function buildDefaultConfig(
  modelsDir: string,
  ggufFiles: string[],
): GatewayConfig {
  const models: Record<string, { file: string; ctx: number; temp: number }> = {};
  for (const f of ggufFiles) {
    models[modelIdFromFile(f)] = { file: f, ctx: DEFAULT_CTX, temp: DEFAULT_TEMP };
  }

  const cfg: GatewayConfig = {
    server: {},
    llama: { modelsDir, models },
    chains: {},
  };
  // Route through the schema to guarantee the produced config is valid.
  return configSchema.parse(cfg);
}

/**
 * Scan `modelsDir` for `*.gguf` files (case-insensitive), returning bare
 * filenames. Expands a leading `~` to the home directory first.
 */
export async function scanGgufFiles(
  modelsDir: string,
  deps: DefaultsDeps = bunDefaultsDeps,
): Promise<string[]> {
  const dir = deps.expandHome(modelsDir);
  return deps.listFiles(dir).filter((name) => /\.gguf$/i.test(name));
}

/**
 * Generate a minimal valid config for boot when no config file exists, by
 * scanning `modelsDir` for candidate `.gguf` models.
 */
export async function generateDefaultConfig(
  modelsDir: string,
  deps: DefaultsDeps = bunDefaultsDeps,
): Promise<GatewayConfig> {
  const files = await scanGgufFiles(modelsDir, deps);
  return buildDefaultConfig(modelsDir, files);
}
