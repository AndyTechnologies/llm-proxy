/**
 * Phase 3 — Local Model Catalog (local-model-catalog): curated list, Hugging
 * Face search filtered to GGUF repos, local-path registration with GGUF parse
 * validation (non-GGUF → clear error, no row), and the SQLite registry as the
 * source of truth that reloads after restart.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import {
  importHfModel,
  listCuratedModels,
  listRegistryModels,
  registerLocalPath,
  searchHuggingFace,
  type HfRepo,
} from "./catalog.js";
import type { GgufParseResult } from "../utils/gguf.js";

function memoryDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

const PARSED = (over: Partial<GgufParseResult> = {}): GgufParseResult => ({
  ggufContextLength: 32768,
  architecture: "llama",
  blockCount: 32,
  headCountKv: null,
  fileType: null,
  parsed: true,
  ...over,
});

/** Fake HF API response — repos with and without GGUF siblings. */
const HF_BODY = JSON.stringify({
  items: [
    {
      id: "org/gguf-model",
      downloads: 1200,
      likes: 45,
      siblings: [
        { rfilename: "model.Q8_0.gguf" },
        { rfilename: "model.safetensors" },
      ],
    },
    {
      id: "org/not-gguf",
      downloads: 99,
      likes: 3,
      siblings: [{ rfilename: "model.safetensors" }],
    },
  ],
});

const hfFetcher = async (): Promise<Response> =>
  new Response(HF_BODY, { status: 200, headers: { "Content-Type": "application/json" } });

describe("curated catalog (3.5)", () => {
  test("curated entries carry url, quant, size, and context metadata", () => {
    const curated = listCuratedModels();
    expect(curated.length).toBeGreaterThanOrEqual(3);
    const first = curated[0];
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.url.startsWith("https://")).toBe(true);
    expect(first.quant).toBeTruthy();
    expect(first.sizeBytes).toBeGreaterThan(0);
    expect(first.ggufCtx).toBeGreaterThan(0);
  });
});

describe("Hugging Face search (3.5)", () => {
  test("returns only repos that contain GGUF files", async () => {
    const repos: HfRepo[] = await searchHuggingFace({
      query: "llama",
      fetcher: hfFetcher,
    });
    expect(repos).toHaveLength(1);
    expect(repos[0].repoId).toBe("org/gguf-model");
    expect(repos[0].ggufFiles).toContain("model.Q8_0.gguf");
    expect(repos[0].ggufFiles).not.toContain("model.safetensors");
  });

  test("importHfModel registers the selected GGUF as downloadable", () => {
    const db = memoryDb();
    const id = importHfModel(db, {
      repoId: "org/gguf-model",
      fileName: "model.Q8_0.gguf",
      downloads: 1200,
    });
    expect(id).toBe("org/gguf-model/model.Q8_0.gguf");
    const row = db
      .query("SELECT source, url, state, quant FROM models WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.source).toBe("hf");
    expect(row.url).toBe(
      "https://huggingface.co/org/gguf-model/resolve/main/model.Q8_0.gguf",
    );
    expect(row.state).toBe("registered");
    expect(row.quant).toBe("Q8_0");
  });
});

describe("local path registration (3.5)", () => {
  test("valid GGUF registers with parsed metadata", async () => {
    const db = memoryDb();
    const id = await registerLocalPath(db, "/data/models/custom.Q4_K_M.gguf", {
      parse: async () => PARSED({ ggufContextLength: 65536 }),
    });
    expect(id).toBe("custom.Q4_K_M.gguf");
    const row = db
      .query("SELECT source, path, gguf_ctx, quant, state, name FROM models WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.path).toBe("/data/models/custom.Q4_K_M.gguf");
    expect(row.gguf_ctx).toBe(65536);
    expect(row.quant).toBe("Q4_K_M");
    expect(row.state).toBe("registered");
    expect(row.name).toBe("custom.Q4_K_M.gguf");
  });

  test("non-GGUF file is rejected with a clear parse error and no entry", () => {
    const db = memoryDb();
    expect(() =>
      registerLocalPath(db, "/data/models/not-a-model.txt", {
        parse: async () => PARSED({ parsed: false, ggufContextLength: null }),
      }),
    ).toThrow(/GGUF/);
    const n = db.query("SELECT COUNT(*) AS n FROM models").get() as { n: number };
    expect(n.n).toBe(0); // no entry created
  });
});

describe("SQLite registry survives restart (3.6)", () => {
  test("reopening the database reloads the same registered models", async () => {
    const dir = (await import("node:fs")).mkdtempSync(
      await import("node:os").then((os) => os.tmpdir()).then((t) => `${t}/weavellm-cat-`),
    );
    const file = `${dir}/weavellm.db`;
    const { rmSync } = await import("node:fs");
    try {
      const db1 = new Database(file);
      applySchema(db1);
      importHfModel(db1, { repoId: "org/m", fileName: "m.Q8_0.gguf" });
      await registerLocalPath(db1, "/data/models/local.Q4_K_M.gguf", {
        parse: async () => PARSED(),
      });
      const before = listRegistryModels(db1);
      expect(before.map((m) => m.id).sort()).toEqual([
        "local.Q4_K_M.gguf",
        "org/m/m.Q8_0.gguf",
      ]);
      db1.close();

      const db2 = new Database(file);
      applySchema(db2);
      const after = listRegistryModels(db2);
      expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
      const local = after.find((m) => m.id === "local.Q4_K_M.gguf");
      expect(local?.path).toBe("/data/models/local.Q4_K_M.gguf");
      expect(local?.quant).toBe("Q4_K_M");
      expect(local?.ggufCtx).toBe(32768);
      const hf = after.find((m) => m.id === "org/m/m.Q8_0.gguf");
      expect(hf?.source).toBe("hf");
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});