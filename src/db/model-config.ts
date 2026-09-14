/**
 * model_config store (model-advanced-config): per-model advanced settings
 * persisted in SQLite, plus the sampler-override wire mapping applied per
 * llm.call node (engine layer consumes `samplerBody`).
 */
import type { Database } from "bun:sqlite";

/** Per-call sampler overrides — settable per llm.call node (workflow YAML). */
export interface SamplerOverrides {
  temperature?: number;
  topP?: number;
  minP?: number;
  typicalP?: number;
  topK?: number;
  repeatPenalty?: number;
}

/** Advanced runtime configuration for one model (model_config row). */
export interface ModelConfig {
  ctxSize?: number;
  /** KV cache quantization, e.g. "q8_0" (--cache-type-k). */
  kvK?: string;
  /** KV cache quantization, e.g. "q8_0" (--cache-type-v). */
  kvV?: string;
  /** KV offload to GPU layers (--n-cache-gpu). */
  nCacheGpu?: number;
  /** Host prompt-cache cap in MiB (--cache-ram) — never caps the KV cache. */
  cacheRam?: number;
  /** GPU layers (--ngl). */
  ngl?: number;
  /** Flash attention (-fa on). */
  flashAttn?: boolean;
  /** Per-call max output tokens. */
  maxTokens?: number;
}

const PICK_COLUMNS = [
  "ctx_size",
  "kv_k",
  "kv_v",
  "n_cache_gpu",
  "cache_ram",
  "ngl",
  "flash_attn",
  "max_tokens",
] as const;

function rowToConfig(row: Record<string, unknown>): ModelConfig {
  const cfg: ModelConfig = {};
  if (row.ctx_size != null) cfg.ctxSize = Number(row.ctx_size);
  if (row.kv_k != null) cfg.kvK = String(row.kv_k);
  if (row.kv_v != null) cfg.kvV = String(row.kv_v);
  if (row.n_cache_gpu != null) cfg.nCacheGpu = Number(row.n_cache_gpu);
  if (row.cache_ram != null) cfg.cacheRam = Number(row.cache_ram);
  if (row.ngl != null) cfg.ngl = Number(row.ngl);
  if (row.flash_attn != null) cfg.flashAttn = Boolean(row.flash_attn);
  if (row.max_tokens != null) cfg.maxTokens = Number(row.max_tokens);
  return cfg;
}

/** Read one model's advanced config; null when no row exists. */
export function getModelConfig(db: Database, modelId: string): ModelConfig | null {
  const row = db
    .query(`SELECT ${PICK_COLUMNS.join(", ")} FROM model_config WHERE model_id = ?`)
    .get(modelId) as Record<string, unknown> | null;
  return row === null || row === undefined ? null : rowToConfig(row);
}

/** Upsert one model's advanced config (per-model persistence across restarts). */
export function setModelConfig(db: Database, modelId: string, cfg: ModelConfig): void {
  db.query(
    `INSERT INTO model_config (model_id, ctx_size, kv_k, kv_v, n_cache_gpu, cache_ram, ngl, flash_attn, max_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model_id) DO UPDATE SET
       ctx_size = excluded.ctx_size,
       kv_k = excluded.kv_k,
       kv_v = excluded.kv_v,
       n_cache_gpu = excluded.n_cache_gpu,
       cache_ram = excluded.cache_ram,
       ngl = excluded.ngl,
       flash_attn = excluded.flash_attn,
       max_tokens = excluded.max_tokens`,
  ).run(
    modelId,
    cfg.ctxSize ?? null,
    cfg.kvK ?? null,
    cfg.kvV ?? null,
    cfg.nCacheGpu ?? null,
    cfg.cacheRam ?? null,
    cfg.ngl ?? null,
    cfg.flashAttn == null ? null : cfg.flashAttn ? 1 : 0,
    cfg.maxTokens ?? null,
  );
}

/**
 * Map sampler overrides to the OpenAI request-body shape (snake_case wire
 * fields) — consumed by llm.call nodes when they execute.
 */
export function samplerBody(overrides: SamplerOverrides): Record<string, number> {
  const body: Record<string, number> = {};
  if (overrides.temperature !== undefined) body.temperature = overrides.temperature;
  if (overrides.topP !== undefined) body.top_p = overrides.topP;
  if (overrides.minP !== undefined) body.min_p = overrides.minP;
  if (overrides.typicalP !== undefined) body.typical_p = overrides.typicalP;
  if (overrides.topK !== undefined) body.top_k = overrides.topK;
  if (overrides.repeatPenalty !== undefined) body.repeat_penalty = overrides.repeatPenalty;
  return body;
}