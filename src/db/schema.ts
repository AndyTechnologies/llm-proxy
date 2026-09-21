import { Database } from "bun:sqlite";

export type WeaveLlmDatabase = Database;

/** The ten persisted tables (design.md Data Model). */
export const EXPECTED_TABLES = [
  "models",
  "model_config",
  "workflows",
  "execution_log",
  "providers",
  "secrets",
  "kv_memory",
  "chunks",
  "downloads",
  "settings",
] as const;

export const MODELS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS models (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'local',
  name          TEXT,
  path          TEXT,
  url           TEXT,
  sha256        TEXT,
  quant         TEXT,
  size_bytes    INTEGER,
  gguf_ctx      INTEGER,
  yarn_orig_ctx INTEGER,
  active        INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'registered',
  probe_status  TEXT
)`;

/** Idempotent migration: add the models.active column when absent. */
function migrateModelsActive(db: WeaveLlmDatabase): void {
  const cols = db
    .query("PRAGMA table_info(models)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "active")) {
    db.exec("ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0");
  }
}

export const MODEL_CONFIG_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS model_config (
  model_id    TEXT PRIMARY KEY REFERENCES models(id),
  ctx_size    INTEGER,
  kv_k        TEXT,
  kv_v        TEXT,
  n_cache_gpu INTEGER,
  cache_ram   INTEGER,
  ngl         INTEGER,
  flash_attn  INTEGER,
  max_tokens  INTEGER
)`;

export const WORKFLOWS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS workflows (
  name       TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 1,
  yaml_graph TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const EXECUTION_LOG_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS execution_log (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  started_at  TEXT NOT NULL,
  ms          INTEGER
)`;

export const PROVIDERS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS providers (
  kind          TEXT PRIMARY KEY,
  base_url      TEXT,
  fallback_id   TEXT,
  misconfigured INTEGER NOT NULL DEFAULT 0
)`;

export const SECRETS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS secrets (
  scope      TEXT PRIMARY KEY,
  nonce      BLOB NOT NULL,
  ciphertext BLOB NOT NULL
)`;

export const KV_MEMORY_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS kv_memory (
  conv_id TEXT NOT NULL,
  role    TEXT NOT NULL,
  content TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const CHUNKS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS chunks (
  doc    TEXT NOT NULL,
  vector BLOB NOT NULL,
  text   TEXT NOT NULL,
  ts     TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const DOWNLOADS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS downloads (
  model_id   TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'queued',
  bytes      INTEGER NOT NULL DEFAULT 0,
  file_name  TEXT,
  sha256     TEXT,
  dir        TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const SETTINGS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** Apply the full schema — idempotent (CREATE TABLE IF NOT EXISTS). */
export function applySchema(db: WeaveLlmDatabase): void {
  db.exec(MODELS_TABLE);
  db.exec(MODEL_CONFIG_TABLE);
  db.exec(WORKFLOWS_TABLE);
  db.exec(EXECUTION_LOG_TABLE);
  db.exec(PROVIDERS_TABLE);
  db.exec(SECRETS_TABLE);
  db.exec(KV_MEMORY_TABLE);
  db.exec(CHUNKS_TABLE);
  db.exec(DOWNLOADS_TABLE);
  db.exec(SETTINGS_TABLE);
  migrateModelsActive(db);
}

/** Open the app database (":memory:" for tests) with WAL for file dbs. */
export function openAppDatabase(location: string): WeaveLlmDatabase {
  const db = new Database(location);
  if (location !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Open (or create) the app database at the appData directory path. */
export function openAppDataDatabase(appData: string): WeaveLlmDatabase {
  const db = openAppDatabase(`${appData}/weavellm.db`);
  applySchema(db);
  return db;
}