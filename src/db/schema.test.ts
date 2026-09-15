import { describe, expect, test } from "bun:test";
import {
  applySchema,
  openAppDatabase,
  EXPECTED_TABLES,
  type WeaveLlmDatabase,
} from "./schema.js";

describe("applySchema", () => {
  test("creates exactly the ten persisted tables", () => {
    const db = openAppDatabase(":memory:");
    applySchema(db);
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  test("models table carries YaRN origin and probe columns", () => {
    const db = openAppDatabase(":memory:");
    applySchema(db);
    const cols = (
      db.query("PRAGMA table_info(models)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "yarn_orig_ctx",
        "gguf_ctx",
        "probe_status",
        "sha256",
        "state",
      ]),
    );
  });

  test("secrets seal columns and chunks vector blob exist", () => {
    const db = openAppDatabase(":memory:");
    applySchema(db);
    const secretCols = (
      db.query("PRAGMA table_info(secrets)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(secretCols).toEqual(
      expect.arrayContaining(["scope", "nonce", "ciphertext"]),
    );
    const chunkCols = (
      db.query("PRAGMA table_info(chunks)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(chunkCols).toEqual(expect.arrayContaining(["doc", "vector", "text"]));
  });

  test("workflows persist the YAML graph and downloads track state", () => {
    const db = openAppDatabase(":memory:");
    applySchema(db);
    const wfCols = (
      db.query("PRAGMA table_info(workflows)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(wfCols).toEqual(expect.arrayContaining(["name", "version", "yaml_graph"]));
    const dlCols = (
      db.query("PRAGMA table_info(downloads)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(dlCols).toEqual(expect.arrayContaining(["model_id", "state", "bytes"]));
  });

  test("re-applying the schema is idempotent", () => {
    const db = openAppDatabase(":memory:");
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });
});

describe("models.active migration (wire-local-backend)", () => {
  test("fresh DB: models carries active INTEGER NOT NULL DEFAULT 0", () => {
    const db = openAppDatabase(":memory:");
    applySchema(db);
    const col = (
      db.query("PRAGMA table_info(models)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === "active");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    // DEFAULT 0: a row inserted without active reads back 0
    db.query("INSERT INTO models (id, path) VALUES (?, ?)").run("fresh", "/m/fresh.gguf");
    const row = db.query("SELECT active FROM models WHERE id = ?").get("fresh") as {
      active: number;
    };
    expect(row.active).toBe(0);
  });

  test("pre-migration DB without active gains the column; existing rows read active=0", () => {
    const db = openAppDatabase(":memory:");
    // Pre-migration shape: models WITHOUT the active column.
    db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id     TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'local',
        path   TEXT,
        state  TEXT NOT NULL DEFAULT 'registered'
      )
    `);
    db.query("INSERT INTO models (id, path) VALUES (?, ?)").run("m1", "/m/m1.gguf");
    applySchema(db);
    const cols = (
      db.query("PRAGMA table_info(models)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("active");
    const row = db.query("SELECT active FROM models WHERE id = ?").get("m1") as {
      active: number;
    };
    expect(row.active).toBe(0);
  });

  test("migration is idempotent: second applySchema run never alters the column twice", () => {
    const db = openAppDatabase(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id     TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'local',
        path   TEXT,
        state  TEXT NOT NULL DEFAULT 'registered'
      )
    `);
    expect(() => {
      applySchema(db);
      applySchema(db);
    }).not.toThrow();
    const cols = (
      db.query("PRAGMA table_info(models)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols.filter((c) => c === "active")).toHaveLength(1);
  });

  test("settings table accepts the embedding_model designation row (fixture)", () => {
    const db = openAppDatabase(":memory:");
    applySchema(db);
    db.query(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', 'bge-m3')",
    ).run();
    const row = db.query("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
      | { value: string }
      | null;
    expect(row?.value).toBe("bge-m3");
  });
});

describe("openAppDatabase", () => {
  test("returns a live database handle", () => {
    const db: WeaveLlmDatabase = openAppDatabase(":memory:");
    expect(db).toBeDefined();
    const n = db.query("SELECT 1 AS one").get() as { one: number };
    expect(n.one).toBe(1);
  });
});