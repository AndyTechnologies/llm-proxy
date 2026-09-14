/**
 * Phase 2 — model_config store (model-advanced-config): per-model advanced
 * settings persisted in SQLite, plus the sampler-override wire mapping used
 * by llm.call nodes (applied per call at engine level).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { applySchema } from "./schema.js";
import {
  getModelConfig,
  setModelConfig,
  samplerBody,
  type ModelConfig,
} from "./model-config.js";

function memoryDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("model_config store", () => {
  test("persists per-model config and reads it back", () => {
    const db = memoryDb();
    const cfg: ModelConfig = {
      ctxSize: 131072,
      kvK: "q8_0",
      kvV: "q8_0",
      nCacheGpu: 4,
      cacheRam: 2048,
      ngl: 99,
      flashAttn: true,
      maxTokens: 4096,
    };
    setModelConfig(db, "model-a", cfg);
    // A different model must not leak config across rows
    setModelConfig(db, "model-b", { ctxSize: 8192 });
    const got = getModelConfig(db, "model-a");
    expect(got).toEqual(cfg);
    expect(getModelConfig(db, "model-b")).toEqual({ ctxSize: 8192 });
  });

  test("unknown model returns null (no config row)", () => {
    const db = memoryDb();
    expect(getModelConfig(db, "nobody")).toBeNull();
  });

  test("upsert replaces the previous config for the same model", () => {
    const db = memoryDb();
    setModelConfig(db, "model-a", { ctxSize: 8192 });
    setModelConfig(db, "model-a", { ctxSize: 131072, kvK: "q8_0" });
    expect(getModelConfig(db, "model-a")).toEqual({ ctxSize: 131072, kvK: "q8_0" });
  });

  test("config survives a database reopen (persistence across restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-mcfg-"));
    const file = join(dir, "weavellm.db");
    try {
      const db1 = new Database(file);
      applySchema(db1);
      setModelConfig(db1, "model-a", { ctxSize: 131072 });
      db1.close();

      const db2 = new Database(file);
      applySchema(db2);
      expect(getModelConfig(db2, "model-a")).toEqual({ ctxSize: 131072 });
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("samplerBody — per-call sampler overrides (node-level, not stored)", () => {
  test("maps override keys to OpenAI request-body fields", () => {
    expect(
      samplerBody({
        temperature: 0.7,
        topP: 0.9,
        minP: 0.05,
        typicalP: 0.95,
        topK: 40,
        repeatPenalty: 1.1,
      }),
    ).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      min_p: 0.05,
      typical_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
    });
  });

  test("empty or partial overrides map to empty/partial bodies", () => {
    expect(samplerBody({})).toEqual({});
    expect(samplerBody({ temperature: 0.2 })).toEqual({ temperature: 0.2 });
  });
});