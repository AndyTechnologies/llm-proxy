/**
 * Chunk store (embeddings-rag spec).
 *
 * Vector chunks live in the `chunks` table (doc / BLOB vector / text) and are
 * retrieved by top-k cosine similarity over the embedding query vector.
 * Degenerate inputs are first-class: an empty store returns [], and a chunk
 * whose vector dimension differs from the query is skipped (incomparable),
 * never an error.
 */
import type { Database } from "bun:sqlite";

export interface ChunkRecord {
  doc: string;
  text: string;
  score: number;
}

/** Cosine similarity of two vectors. Dimension mismatch → 0 (incomparable). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  if (norm === 0) return 0;
  return dot / norm;
}

/** Float32Array → little-endian BLOB bytes for the chunks.vector column. */
export function encodeVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** BLOB bytes → Float32Array (view over the stored buffer). */
export function decodeVector(buf: Uint8Array): Float32Array {
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export class ChunkStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Insert one chunk; the vector is stored as its 4-bytes-per-float BLOB. */
  add(doc: string, text: string, vector: Float32Array): void {
    this.#db
      .query("INSERT INTO chunks (doc, vector, text) VALUES (?, ?, ?)")
      .run(doc, encodeVector(vector), text);
  }

  /** Top-k chunks by cosine similarity to the query vector (descending). */
  search(query: Float32Array, k: number): ChunkRecord[] {
    const rows = this.#db
      .query("SELECT doc, vector, text FROM chunks")
      .all() as Array<{ doc: string; vector: Uint8Array; text: string }>;
    const ranked: ChunkRecord[] = [];
    for (const row of rows) {
      const vector = decodeVector(row.vector);
      if (vector.length !== query.length) continue; // incomparable dims
      ranked.push({ doc: row.doc, text: row.text, score: cosineSimilarity(query, vector) });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, k);
  }

  /** Total chunk rows (used by the UI and tests). */
  count(): number {
    const row = this.#db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    return row.n;
  }
}