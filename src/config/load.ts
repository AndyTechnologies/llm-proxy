/**
 * Config file loader.
 *
 * Reads the gateway config from JSON or YAML (whichever extension CONFIG_FILE
 * points to) using Bun-native APIs: `Bun.file(path).text()` for reading and
 * `Bun.YAML.parse` for YAML (.yaml/.yml), JSON.parse for .json. The design
 * mandates this over `Bun.file().yaml()` (does not exist — ADR-5).
 *
 * Testability (ADR-3 DI pattern): the `file`/`YAML.parse` primitives are
 * injectable via LoaderDeps, defaulting to the real Bun implementations.
 * Runtime fact: `mock.module("bun")` cannot intercept the builtin bun module
 * in Bun 1.4.0, so tests inject fakes instead of mocking the bun module.
 * Returns the raw (untyped) record; schema.ts validates it into a typed config.
 */
import { file, YAML } from "bun";
import path from "node:path";

/** Minimal Bun.File-like surface used by the loader. */
export interface FileLike {
  exists(): Promise<boolean>;
  text(): Promise<string>;
}

/** Injectable loader primitives (defaults to real Bun implementations). */
export interface LoaderDeps {
  file: (path: string) => FileLike;
  yamlParse: (text: string) => unknown;
}

/** Production deps: real Bun.file + Bun.YAML.parse. */
export const bunDeps: LoaderDeps = {
  file,
  yamlParse: (text) => YAML.parse(text),
};

/** Error message prefixes shared by the loader (asserted verbatim by tests). */
export const ERR_CONFIG_NOT_OBJECT = "Config file is not an object";
export const ERR_CONFIG_NOT_FOUND = "Config file not found";
export const ERR_UNSUPPORTED_EXT = "Unsupported config extension";

/** Resolve + read the config file, returning the raw parsed record. */
export async function loadRawConfig(
  configPath: string,
  deps: LoaderDeps = bunDeps,
): Promise<Record<string, unknown>> {
  const resolved = path.resolve(process.cwd(), configPath);
  const f = deps.file(resolved);

  if (!(await f.exists())) {
    throw new Error(`${ERR_CONFIG_NOT_FOUND}: ${resolved}`);
  }

  const raw = await f.text();
  const ext = path.extname(resolved).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    const parsed = deps.yamlParse(raw);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`${ERR_CONFIG_NOT_OBJECT}: ${resolved}`);
    }
    return parsed as Record<string, unknown>;
  }

  if (ext === ".json") {
    return JSON.parse(raw) as Record<string, unknown>;
  }

  throw new Error(
    `${ERR_UNSUPPORTED_EXT} "${ext}" for ${resolved}; use .yaml, .yml or .json`,
  );
}