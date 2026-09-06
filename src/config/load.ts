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
import type { ExternalProviderConfig } from "./schema.js";

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

/** Matches `${VAR}` environment references inside config string values. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve all `${VAR}` references in `value` from the process environment.
 *
 * Fail-closed (ADR-5): a reference to an unset variable throws naming the
 * variable VERBATIM, so a typo'd or missing secret fails boot loudly instead
 * of leaking a literal `${VAR}` into an outgoing Authorization header.
 */
function resolveEnvRefs(value: string, path: string): string {
  const refs = [...value.matchAll(ENV_REF)];
  if (refs.length === 0) {
    return value;
  }
  for (const ref of refs) {
    const name = ref[1];
    if (process.env[name] === undefined) {
      throw new Error(`${path}: env var ${name} is not set`);
    }
  }
  return value.replace(ENV_REF, (match, name: string) => process.env[name] ?? match);
}

/**
 * Post-parse pass over the external provider config: resolves `${VAR}`
 * references in `apiKey` and `headers` values from `process.env`.
 *
 * Static auth only (ADR-5) — secrets are resolved once at config load, so the
 * adapter never touches process.env. Returns a NEW providers record; the
 * parsed input is not mutated.
 */
export function interpolateProviderSecrets(
  providers: Record<string, ExternalProviderConfig>,
): Record<string, ExternalProviderConfig> {
  const out: Record<string, ExternalProviderConfig> = {};
  for (const [name, provider] of Object.entries(providers)) {
    const at = (field: string) => `[config] providers.${name}.${field}`;
    const next: ExternalProviderConfig = { ...provider };
    if (provider.apiKey !== undefined) {
      next.apiKey = resolveEnvRefs(provider.apiKey, at("apiKey"));
    }
    if (provider.headers !== undefined) {
      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(provider.headers)) {
        headers[key] = resolveEnvRefs(val, at(`headers.${key}`));
      }
      next.headers = headers;
    }
    out[name] = next;
  }
  return out;
}