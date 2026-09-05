/**
 * Models preset INI generator for llama.cpp router mode.
 *
 * Renders config.llama.models → a preset INI file compatible with
 * `llama-server --models-preset`. Each model becomes a section keyed by its
 * friendly ID (the same string chains reference in step.model).
 *
 * ACTUAL llama.cpp router format (verified empirically against the installed
 * `llama serve` binary — the design's anticipated "INI syntax drift"):
 *   - Each preset section is a set of `key = value` lines.
 *   - The model file key is `model` (the `--model`/`-m` CLI arg), NOT `url`.
 *   - Keys use the CLI arg names (hyphenated, no leading dashes): `ctx-size`,
 *     `temp`, `n-gpu-layers`, etc. — NOT the snake_case `ctx_size` that the
 *     design sketched (that key is rejected at boot).
 *
 *   [SmolLM3-3B]
 *   model = ~/Models/SmolLM3-3B-Q4_K_M.gguf
 *   ctx-size = 65536
 *   temp = 0.1
 *
 * The friendly id from config IS the section name, so chains' `model: SmolLM3-3B`
 * maps 1:1 to the registered router id with no name normalization.
 *
 * Per-model context: when an `effectiveCtxFor` resolver is provided (the
 * gateway wires the per-model GGUF/hardware-aware value), its value wins over
 * the raw config `ctx` — the per-model section is the ONLY place to set a
 * per-model window in router mode, because a global `--ctx-size` on the router
 * process would override every section (llama.cpp overlays the router's own
 * CLI args on top of each preset — that flag is deliberately absent from the
 * manager's spawn args).
 *
 * Global router args form the `[server]` section default; per-model keys
 * override. The adapter in preset.ts isolates INI syntax drift from the
 * rest of the system.
 */
import fs from "node:fs";
import path from "node:path";
import type { LlamaConfig, ModelConfig } from "../config/schema.js";

/** Directory for generated preset files. */
const PRESET_DIR = ".llm-proxy";
const PRESET_FILENAME = "models.ini";

/**
 * Convert a CLI-style per-model args string (e.g. "--n-gpu-layers 99") into
 * INI `key = value` lines (e.g. "n-gpu-layers = 99").
 * Pairs are detected by a leading-dash flag followed by a token that is not
 * itself a flag.
 */
function cliArgsToIniLines(args: string): string[] {
  const tokens = args.trim().split(/\s+/);
  const lines: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("-")) {
      const key = tok.replace(/^-+/, "");
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        lines.push(`${key} = ${next}`);
        i++; // consume the value
      } else {
        // Boolean-style flag with no explicit value — emit as "key = on"
        lines.push(`${key} = on`);
      }
    }
  }

  return lines;
}

/**
 * Render a single model section of the preset INI.
 */
function renderModelSection(
  id: string,
  model: ModelConfig,
  modelsDir: string,
  effectiveCtxFor?: (id: string) => number | undefined,
): string[] {
  const lines: string[] = [];

  // Resolve file path: relative → under modelsDir, absolute → as-is
  const filePath = path.isAbsolute(model.file)
    ? model.file
    : path.resolve(modelsDir, model.file);

  lines.push(`[${id}]`);
  lines.push(`model = ${filePath}`);

  // The per-model EFFECTIVE context (resolved by the gateway from user ctx,
  // GGUF native window, and the hardware ceiling) wins over the raw config
  // value. `undefined` from the resolver means "no effective value known" and
  // falls back to model.ctx (or no key at all → llama.cpp loads the native
  // window from the file, i.e. ctx 0).
  const ctx = effectiveCtxFor?.(id) ?? model.ctx;
  if (ctx !== undefined) {
    lines.push(`ctx-size = ${ctx}`);
  }

  if (model.temp !== undefined) {
    lines.push(`temp = ${model.temp}`);
  }

  // Per-model CLI arg overrides converted to INI key = value pairs
  if (model.args) {
    lines.push(...cliArgsToIniLines(model.args));
  }

  lines.push(""); // blank line between sections
  return lines;
}

/**
 * Render the models config to llama.cpp preset INI content.
 * Pure function — no side effects, easy to test.
 *
 * @param effectiveCtxFor per-model effective context (tokens); when provided
 *   its value is written as `ctx-size` for that section, overriding the raw
 *   config `ctx`. Absent/undefined → the config `ctx` is used as before.
 */
export function renderPresetIni(
  config: LlamaConfig,
  modelsDir: string,
  effectiveCtxFor?: (id: string) => number | undefined,
): string {
  const lines: string[] = [];

  for (const [id, model] of Object.entries(config.models)) {
    lines.push(...renderModelSection(id, model, modelsDir, effectiveCtxFor));
  }

  return lines.join("\n");
}

/**
 * Write the preset INI to disk. Called by the manager before spawning
 * llama-server. Returns the absolute path to the written file.
 *
 * The .llm-proxy/ directory is created if it doesn't exist. The file is
 * regenerated on every start (idempotent).
 *
 * MIGRATION (S1, Bun 1.4.0): the write uses `Bun.file().write()` (async,
 * non-blocking) instead of `fs.writeFileSync`. The render stays pure and
 * unchanged; only the write mechanism changed, so the function is async now.
 */
export async function writePresetIni(
  config: LlamaConfig,
  modelsDir: string,
  effectiveCtxFor?: (id: string) => number | undefined,
): Promise<string> {
  const content = renderPresetIni(config, modelsDir, effectiveCtxFor);
  const presetDir = path.resolve(PRESET_DIR);

  if (!fs.existsSync(presetDir)) {
    fs.mkdirSync(presetDir, { recursive: true });
  }

  const filePath = path.join(presetDir, PRESET_FILENAME);
  await Bun.file(filePath).write(content);

  console.log(
    `[backend] preset written: ${filePath} (${Object.keys(config.models).length} models)`,
  );

  return filePath;
}

export { PRESET_DIR, PRESET_FILENAME };
