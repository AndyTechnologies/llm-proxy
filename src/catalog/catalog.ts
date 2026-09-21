/**
 * Local model catalog (local-model-catalog): curated list, Hugging Face
 * search filtered to GGUF repos, local-path registration with GGUF header
 * validation, and the SQLite `models` table as the registry source of truth.
 *
 * Sources:
 * - `curated` — entries from curated.ts (one-click downloads; sha256 only
 *   when published on the model card, never fabricated).
 * - `hf` — a GGUF file picked from a search result; registered as
 *   downloadable (url = resolve/main), state `registered` until downloaded.
 * - `local` — a user-provided GGUF path; validated by reading the header
 *   (magic + metadata sweep), rejected with a clear error when it is not a
 *   real GGUF file. `gguf_ctx` is recorded so the registry can plan context.
 */
import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import {
  parseGgufHeader,
  type GgufParseResult,
} from "../utils/gguf.js";
import { listCuratedModels, type CuratedModel } from "./curated.js";

export { listCuratedModels };
export type { CuratedModel };

/** Error with a catalog-facing message (surfaced to the UI as-is). */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/** One HF repo as a search result, filtered to its GGUF siblings. */
export interface HfRepo {
  repoId: string;
  downloads: number | null;
  likes: number | null;
  /** rfilename values ending in `.gguf` (case-insensitive). */
  ggufFiles: string[];
}

interface HfApiItem {
  id: string;
  downloads: number | null;
  likes: number | null;
  siblings: Array<{ rfilename: string }>;
}

/** Derive the quant tag from a GGUF filename (e.g. `Q8_0`, `Q4_K_M`). */
export function quantFromFileName(fileName: string): string | null {
  const m = /\.(q[a-z0-9_]+)\.gguf$/i.exec(fileName);
  return m === null ? null : m[1].toUpperCase();
}

const isGgufSibling = (rfilename: string): boolean => /\.gguf$/i.test(rfilename);

/**
 * Search the Hugging Face model hub and keep only repos that actually carry
 * GGUF files (client-side sibling filter on top of the `filter=gguf` query —
 * robust even if a repo tags itself loosely).
 */
export async function searchHuggingFace(opts: {
  query: string;
  fetcher?: (url: string) => Promise<Response>;
}): Promise<HfRepo[]> {
  const fetcher = opts.fetcher ?? ((url: string) => fetch(url));
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(
    opts.query,
  )}&filter=gguf&order=downloads&limit=20`;
  let res: Response;
  try {
    res = await fetcher(url);
  } catch (err) {
    throw new CatalogError(
      `Hugging Face search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new CatalogError(
      `Hugging Face search failed with HTTP ${res.status} (${res.statusText})`,
    );
  }
  const body = (await res.json()) as { items?: HfApiItem[] };
  const items = body.items ?? [];
  return items
    .map((item): HfRepo => {
      const ggufFiles = (item.siblings ?? [])
        .map((s) => s.rfilename)
        .filter(isGgufSibling);
      return {
        repoId: item.id,
        downloads: item.downloads ?? null,
        likes: item.likes ?? null,
        ggufFiles,
      };
    })
    .filter((repo) => repo.ggufFiles.length > 0);
}

/**
 * Register a GGUF file from a search result as downloadable (id
 * `<repo>/<file>`), ready for the download engine.
 */
export function importHfModel(
  db: Database,
  opts: { repoId: string; fileName: string; downloads?: number; likes?: number },
): string {
  const id = `${opts.repoId}/${opts.fileName}`;
  const url = `https://huggingface.co/${opts.repoId}/resolve/main/${opts.fileName}`;
  db.query(
    `INSERT INTO models (id, source, name, url, quant, state)
     VALUES (?, 'hf', ?, ?, ?, 'registered')
     ON CONFLICT(id) DO UPDATE SET
       url = excluded.url, quant = excluded.quant, state = 'registered'`,
  ).run(id, opts.fileName, url, quantFromFileName(opts.fileName));
  return id;
}

/**
 * Register a local GGUF file path. The header is parsed (injectable for
 * tests); a file that does not open as GGUF is rejected before any row is
 * created.
 */
export async function registerLocalPath(
  db: Database,
  filePath: string,
  opts: { parse?: (filePath: string) => Promise<GgufParseResult> } = {},
): Promise<string> {
  const parse = opts.parse ?? parseGgufHeader;
  const result = await parse(filePath);
  if (!result.parsed) {
    throw new CatalogError(
      `"${filePath}" is not a valid GGUF model (no GGUF header found).`,
    );
  }
  const id = basename(filePath);
  db.query(
    `INSERT INTO models (id, source, name, path, quant, gguf_ctx, state)
     VALUES (?, 'local', ?, ?, ?, ?, 'registered')
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path, quant = excluded.quant, gguf_ctx = excluded.gguf_ctx,
       state = 'registered'`,
  ).run(id, id, filePath, quantFromFileName(id), result.ggufContextLength);
  return id;
}

export interface ModelEntry {
  id: string;
  source: string;
  name: string | null;
  path: string | null;
  url: string | null;
  sha256: string | null;
  quant: string | null;
  sizeBytes: number | null;
  ggufCtx: number | null;
  yarnOrigCtx: number | null;
  state: string;
  probeStatus: string | null;
}

interface ModelRow {
  id: string;
  source: string;
  name: string | null;
  path: string | null;
  url: string | null;
  sha256: string | null;
  quant: string | null;
  size_bytes: number | null;
  gguf_ctx: number | null;
  yarn_orig_ctx: number | null;
  state: string;
  probe_status: string | null;
}

const toEntry = (row: ModelRow): ModelEntry => ({
  id: row.id,
  source: row.source,
  name: row.name,
  path: row.path,
  url: row.url,
  sha256: row.sha256,
  quant: row.quant,
  sizeBytes: row.size_bytes,
  ggufCtx: row.gguf_ctx,
  yarnOrigCtx: row.yarn_orig_ctx,
  state: row.state,
  probeStatus: row.probe_status,
});

/** Full registry view (reloads from disk on every call — source of truth). */
export function listRegistryModels(db: Database): ModelEntry[] {
  return (db.query("SELECT * FROM models ORDER BY id").all() as ModelRow[]).map(toEntry);
}

/** One registry entry by model id, or null. */
export function getRegistryModel(db: Database, modelId: string): ModelEntry | null {
  const row = db.query("SELECT * FROM models WHERE id = ?").get(modelId) as
    | ModelRow
    | undefined;
  return row === undefined ? null : toEntry(row);
}