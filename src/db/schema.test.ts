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

describe("openAppDatabase", () => {
  test("returns a live database handle", () => {
    const db: WeaveLlmDatabase = openAppDatabase(":memory:");
    expect(db).toBeDefined();
    const n = db.query("SELECT 1 AS one").get() as { one: number };
    expect(n.one).toBe(1);
  });
});