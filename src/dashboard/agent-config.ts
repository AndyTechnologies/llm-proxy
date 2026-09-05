/**
 * Pure helpers for the dashboard "Agents" feature: one-click sync of the
 * gateway's virtual models (`gateway/*`) into AI coding agent config files
 * (OpenCode, Pi). Patching/probing/expansion are pure and testable with plain
 * objects; file I/O is confined to `writeJsonAtomic` and stays out of the
 * patch functions so the router owns all disk access.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/** A model entry from `GET /v1/models`. */
export interface GatewayModel {
  id: string;
  description?: string;
  owned_by?: string;
  /** Effective context (tokens) reported in `meta.context_length`, when known. */
  contextLength?: number;
}

/** Keep only the virtual pipeline models (`gateway/<chain>`). */
export function gatewayModels(data: { data: GatewayModel[] }): GatewayModel[] {
  return data.data.filter((m) => m.id.startsWith("gateway/"));
}

/**
 * Detect which top-level key holds provider definitions in an OpenCode
 * config. Prefers `provider` (the current OpenCode shape — `providers` was a
 * legacy alias OpenCode ignores at runtime); falls back to `providers` for
 * older files; defaults to `provider` when neither exists.
 */
export function opencodeConfigKey(
  config: Record<string, unknown>,
): "provider" | "providers" {
  if (isRecord(config.provider)) return "provider";
  if (isRecord(config.providers)) return "providers";
  return "provider";
}

/**
 * Real generation limits of the backend model, so agents never send a prompt
 * larger than the llama-server context window (the classic "Graph produced no
 * response": agent declares huge context, backend rejects, client sees empty).
 */
export interface ModelLimits {
  /** Context window real del backend (tokens). */
  context: number;
  /** Max output tokens real del backend (`--n-predict`). */
  output: number;
}

/** Sensible fallback when real backend limits cannot be probed. */
export const DEFAULT_LIMITS: ModelLimits = { context: 8192, output: 2048 };

/**
 * Deep-clone and patch an OpenCode config: rebuild `provider["llm-proxy"]`
 * with every gateway model keyed by full id, preserving every other key in
 * the file untouched. Uses whichever top-level key the file already has.
 *
 * Each model gets the real limits of ITS own backend model (keyed by model
 * id); unknown ids fall back to DEFAULT_LIMITS.
 */
export function patchOpenCode(
  config: Record<string, unknown>,
  models: GatewayModel[],
  apiKey: string,
  baseURL: string,
  limitsByModel: Record<string, ModelLimits>,
): Record<string, unknown> {
  const out = deepClone(config);
  const key = opencodeConfigKey(out);
  const providers = isRecord(out[key]) ? out[key] : {};
  const modelsById: Record<string, unknown> = {};
  for (const m of models) {
    const limits = limitsByModel[m.id] ?? DEFAULT_LIMITS;
    modelsById[m.id] = { limits: { context: limits.context, output: limits.output } };
  }
  providers["llm-proxy"] = {
    name: "LLM-Proxy",
    npm: "@ai-sdk/openai-compatible",
    options: { apiKey, baseURL },
    models: modelsById,
  };
  out[key] = providers;
  return out;
}

/**
 * Deep-clone and patch a Pi agent config: rebuild `providers["llm-proxy"]`
 * with the models array (ids without the `gateway/` prefix — Pi references
 * them as `llm-proxy/<model>`), preserving everything else untouched.
 * Per-model limits, as in patchOpenCode.
 */
export function patchPi(
  config: Record<string, unknown>,
  models: GatewayModel[],
  apiKey: string,
  baseURL: string,
  limitsByModel: Record<string, ModelLimits>,
): Record<string, unknown> {
  const out = deepClone(config);
  const providers = isRecord(out.providers) ? out.providers : {};
  providers["llm-proxy"] = {
    baseUrl: baseURL,
    api: "openai-completions",
    apiKey,
    models: models.map((m) => {
      const limits = limitsByModel[m.id] ?? DEFAULT_LIMITS;
      return {
        id: m.id.replace(/^gateway\//, ""),
        name: m.description ?? m.id,
        reasoning: true,
        input: ["text"],
        contextWindow: limits.context,
        maxTokens: limits.output,
      };
    }),
  };
  out.providers = providers;
  return out;
}

/** Whether an agent config already carries the llm-proxy provider + how many models. */
export interface ProviderStatus {
  providerPresent: boolean;
  modelCount: number;
}

/** Probe an OpenCode config for the `llm-proxy` provider entry. */
export function opencodeProviderStatus(
  config: Record<string, unknown>,
): ProviderStatus {
  const key = opencodeConfigKey(config);
  const providers = config[key];
  if (!isRecord(providers)) return { providerPresent: false, modelCount: 0 };
  const entry = providers["llm-proxy"];
  if (!isRecord(entry)) return { providerPresent: false, modelCount: 0 };
  const models = entry.models;
  if (!isRecord(models)) return { providerPresent: true, modelCount: 0 };
  return { providerPresent: true, modelCount: Object.keys(models).length };
}

/** Probe a Pi config for the `providers["llm-proxy"]` entry. */
export function piProviderStatus(config: Record<string, unknown>): ProviderStatus {
  const providers = config.providers;
  if (!isRecord(providers)) return { providerPresent: false, modelCount: 0 };
  const entry = providers["llm-proxy"];
  if (!isRecord(entry)) return { providerPresent: false, modelCount: 0 };
  const models = entry.models;
  if (!Array.isArray(models)) return { providerPresent: true, modelCount: 0 };
  return { providerPresent: true, modelCount: models.length };
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Write `data` as pretty JSON to `filePath` atomically (tmp file + rename).
 * When the file already exists, a backup copy is written to `<filePath>.bak`
 * first. Returns the backup path (whether or not a backup was actually
 * written — absent when the file did not exist).
 */
export function writeJsonAtomic(
  filePath: string,
  data: unknown,
): { backupPath: string } {
  const backupPath = `${filePath}.bak`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
  return { backupPath };
}

function deepClone(config: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}