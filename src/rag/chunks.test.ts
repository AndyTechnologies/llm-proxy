/**
 * Chunk store tests (embeddings-rag spec).
 *
 * RED-first: cosine ranking over the `chunks` table with Float32Array vectors
 * stored as BLOBs; empty store and dimension mismatches are handled without
 * errors.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import {
  ChunkStore,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  type ChunkRecord,
} from "./chunks.js";

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe("cosineSimilarity — vector math", () => {
  test("identical vectors score 1", () => {
    expect(cosineSimilarity(vec(1, 0, 0), vec(1, 0, 0))).toBeCloseTo(1);
  });

  test("orthogonal vectors score 0", () => {
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
  });

  test("opposite vectors score -1", () => {
    expect(cosineSimilarity(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1);
  });

  test("magnitude is normalized (scale-invariant)", () => {
    expect(cosineSimilarity(vec(2, 0), vec(3, 0))).toBeCloseTo(1);
    expect(cosineSimilarity(vec(2, 2), vec(1, 0))).toBeCloseTo(Math.SQRT1_2);
  });

  test("zero vectors are incomparable → 0", () => {
    expect(cosineSimilarity(vec(0, 0), vec(1, 0))).toBeCloseTo(0);
  });

  test("dimension mismatch → 0 (incompatible)", () => {
    expect(cosineSimilarity(vec(1, 2), vec(1, 2, 3))).toBe(0);
  });
});

describe("vector blob encoding — Float32Array round-trip", () => {
  test("encode produces 4 bytes per float; decode restores the values", () => {
    const original = vec(1.5, -2.25, 3.125, 0.0625);
    const blob = encodeVector(original);
    expect(blob.byteLength).toBe(16);
    const restored = decodeVector(blob);
    expect(restored).toBeInstanceOf(Float32Array);
    expect(Array.from(restored)).toEqual(Array.from(original));
  });
});

function makeStore(): ChunkStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new ChunkStore(db);
}

describe("ChunkStore — top-k cosine retrieval", () => {
  test("empty store returns [] (never an error)", () => {
    const store = makeStore();
    expect(store.count()).toBe(0);
    expect(store.search(vec(1, 0), 5)).toEqual([]);
  });

  test("ranks chunks by cosine similarity, closest first", () => {
    const store = makeStore();
    store.add("doc-a", "cat", vec(1, 0));
    store.add("doc-b", "dog", vec(0.9, 0.1));
    store.add("doc-c", "bird", vec(0, 1));
    const res = store.search(vec(1, 0), 3);
    expect(res.map((r) => r.doc)).toEqual(["doc-a", "doc-b", "doc-c"]);
    expect(res[0]?.text).toBe("cat");
    expect(res[0]?.score).toBeGreaterThan(res[1]?.score ?? 1);
  });

  test("k limits the number of returned chunks", () => {
    const store = makeStore();
    // distinct directions: d0 at angle 0 (closest to the query), d4 furthest
    for (let i = 0; i < 5; i++) {
      store.add(`d${i}`, `t${i}`, vec(Math.cos(i * 0.5), Math.sin(i * 0.5)));
    }
    const res = store.search(vec(1, 0), 2);
    expect(res).toHaveLength(2);
    expect(res[0]?.doc).toBe("d0");
    expect(res[1]?.doc).toBe("d1");
  });

  test("chunks with a different vector dimension are skipped, not fatal", () => {
    const store = makeStore();
    store.add("same-dim", "hello", vec(1, 0));
    store.add("wrong-dim", "noise", vec(1, 0, 0, 0));
    const res = store.search(vec(1, 0), 5);
    expect(res).toHaveLength(1);
    expect(res[0]?.doc).toBe("same-dim");
  });

  test("count reflects inserted rows", () => {
    const store = makeStore();
    store.add("a", "x", vec(1));
    store.add("b", "y", vec(1));
    expect(store.count()).toBe(2);
  });

  test("search returns ChunkRecord-shaped results with the source doc", () => {
    const store = makeStore();
    store.add("guide", "recipes", vec(1, 1));
    const [top] = store.search(vec(1, 1), 1) as [ChunkRecord];
    expect(top).toMatchObject({ doc: "guide", text: "recipes" });
    expect(typeof top.score).toBe("number");
  });
});