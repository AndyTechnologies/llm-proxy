/**
 * Config file loader.
 *
 * Reads the gateway config from JSON or YAML (whichever extension CONFIG_FILE
 * points to). The design mandates "JSON or YAML" support: we branch on the file
 * extension and use js-yaml for `.yaml`/`.yml` and JSON.parse for `.json`.
 * Returns the raw (untyped) record; schema.ts validates it into a typed config.
 */
import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

/** Resolve + read the config file, returning the raw parsed record. */
export function loadRawConfig(configPath: string): Record<string, unknown> {
  const resolved = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf8");
  const ext = path.extname(resolved).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    const parsed = loadYaml(raw);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`Config file is not an object: ${resolved}`);
    }
    return parsed as Record<string, unknown>;
  }

  if (ext === ".json") {
    return JSON.parse(raw) as Record<string, unknown>;
  }

  throw new Error(
    `Unsupported config extension "${ext}" for ${resolved}; use .yaml, .yml or .json`,
  );
}
