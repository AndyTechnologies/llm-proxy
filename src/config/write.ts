/**
 * Atomic config persistence (Slice A — config-load Req "Atomic config write"
 * + "YAML round-trip re-serialization" + "Zod schema validation preserved").
 *
 * Writes the full validated config to YAML by:
 *   1. re-validating the config with the existing zod schema (any apply MUST be
 *      gated on fresh validation — invalid config writes nothing),
 *   2. serializing the whole validated config to YAML (round-trip re-serialization),
 *   3. writing the bytes to a temp file in the SAME directory as the target,
 *   4. atomically renaming the temp file over the target.
 *
 * Because the rename is the only step that touches the target, the persisted
 * config is always either the complete new content or the previous content —
 * never a partially written mixture. If the write aborts (e.g. disk error), the
 * rename never runs and the prior config file remains intact.
 *
 * Testability (ADR-3 DI pattern): write/rename/stringify/tmpPath are injectable
 * via `PersistDeps`, defaulting to the real Bun/node implementations.
 */
import { YAML } from "bun";
import { renameSync } from "node:fs";
import path from "node:path";
import { configSchema, type GatewayConfig } from "./schema.js";

/** Injectable persistence primitives (defaults to real Bun/node). */
export interface PersistDeps {
  write: (path: string, data: string) => Promise<number>;
  rename: (from: string, to: string) => void;
  stringify: (config: GatewayConfig) => string;
  tmpPath: (target: string, n: number) => string;
}

let tmpCounter = 0;

/** Production deps: real Bun.write + fs.renameSync + Bun.YAML.stringify. */
export const bunPersistDeps: PersistDeps = {
  write: (p, data) => Bun.write(p, data),
  rename: renameSync,
  stringify: (config) => YAML.stringify(config),
  tmpPath: (target, n) => `${target}.tmp-${process.pid}-${n}`,
};

/**
 * Persist the validated config atomically over `configPath`.
 *
 * Throws on zod validation failure (before any write) or on a write error
 * (before any rename). On success returns the raw YAML string that was written.
 */
export async function persistConfig(
  config: GatewayConfig,
  configPath: string,
  deps: PersistDeps = bunPersistDeps,
): Promise<string> {
  // Re-validate with the schema — invalid config must never reach the disk.
  const validated = configSchema.parse(config);

  const serialized = deps.stringify(validated);

  // Temp file lives in the target's directory so the rename stays on the same
  // filesystem (an atomic rename cannot cross filesystems).
  const resolved = path.resolve(configPath);
  const dir = path.dirname(resolved);
  const tmp = path.join(dir, path.basename(deps.tmpPath(resolved, ++tmpCounter)));

  await deps.write(tmp, serialized);
  deps.rename(tmp, resolved);

  return serialized;
}
