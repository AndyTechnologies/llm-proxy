/**
 * DownloadEngine (model-downloads).
 *
 * The queue/resume/cancel controller that drives the gosh CLI sidecar behind
 * the `DownloadEngine` abstraction (binding decision). All gosh CLI surface
 * lives in gosh.ts — the engine only consumes builders/parsers and the
 * injected transfer runner, so a gosh flag change never reaches the engine.
 *
 * Lifecycle per model: queued → downloading → verifying → completed;
 * interrupted (aborted / gosh exit 130) → resumable; verification mismatch or
 * non-zero exit → failed. State lives in the SQLite `downloads` table
 * (design.md Data Model, extended with file_name/sha256/dir so a restart can
 * resume a partial transfer).
 *
 * Resume semantics: gosh persists interrupted transfers in its own SQLite
 * store (v0.6.3+ "downloads survive restarts", Ctrl+C preserves downloads for
 * resume), so re-issuing the transfer command for the same URL/dir continues
 * from the last completed chunk instead of restarting. The engine does the
 * re-issue; gosh does the chunk-level resume.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { buildGoshTransferArgs, parseGoshEvent, assertChecksumPrefix } from "./gosh.js";

export type DownloadState =
  | "queued"
  | "downloading"
  | "verifying"
  | "completed"
  | "resumable"
  | "failed";

/** One download request from the catalog/UI. */
export interface DownloadSpec {
  modelId: string;
  url: string;
  /** Output filename (`-o`). */
  fileName: string;
  /** Expected digest as `sha256:<hex>` (bare hex is rejected — gosh ignores it). */
  expectedSha256: string;
  /** Output directory (`-d`). */
  dir: string;
  maxConnections?: number;
}

/**
 * Injected transfer runner. The default spawns the real gosh binary; tests
 * inject a fake covering the whole lifecycle without a subprocess.
 */
export type TransferRunner = (
  args: string[],
  opts: { signal: AbortSignal; onLine: (line: string) => void },
) => Promise<number>;

export interface DownloadEngineOptions {
  /** Transfer runner — defaults to spawning the real `gosh` binary. */
  run?: TransferRunner;
  /** Global default for `-x` when a spec does not set maxConnections. */
  maxConnections?: number;
  /** Digest verifier — defaults to reading the file and hashing it. */
  verify?: (filePath: string, expectedHex: string) => Promise<boolean>;
  /** File discard on mismatch — defaults to rmSync(force). */
  unlink?: (filePath: string) => void;
}

export interface DownloadEntry {
  modelId: string;
  url: string;
  state: DownloadState;
  bytes: number;
}

export interface DownloadEngine {
  /** Queue and transfer a download, completing when gosh exits. */
  enqueue(
    spec: DownloadSpec,
    opts?: { onProgress?: (modelId: string, percent: number) => void },
  ): Promise<void>;
  /** Resume one resumable download (re-issue the transfer). */
  resume(modelId: string): Promise<void>;
  /** Resume every resumable download in the queue. */
  resumeAll(): Promise<void>;
  /** Abort the in-flight transfer; the download becomes resumable. */
  cancel(modelId: string): Promise<void>;
  /** Current persisted state for one model, or null when never queued. */
  state(modelId: string): DownloadState | null;
  /** Every download row (catalog/UI queue view). */
  list(): DownloadEntry[];
}

interface DownloadRow {
  model_id: string;
  url: string;
  state: DownloadState;
  bytes: number;
  file_name: string | null;
  sha256: string | null;
  dir: string | null;
}

/** Hex SHA-256 of an in-memory byte buffer (pure, WebCrypto). */
export async function verifySha256Hex(
  bytes: Uint8Array,
  expectedHex: string,
): Promise<boolean> {
  // Copy into an ArrayBuffer-backed view — BufferSource rejects
  // ArrayBufferLike (SharedArrayBuffer-compatible) typed arrays.
  const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  buf.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.toLowerCase() === expectedHex.toLowerCase();
}

/** Read a file and verify its SHA-256 digest (registry registration gate). */
export async function verifySha256File(
  filePath: string,
  expectedHex: string,
): Promise<boolean> {
  const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
  return verifySha256Hex(bytes, expectedHex);
}

/** Default runner: spawn the real gosh binary, draining stdout line-by-line. */
const defaultRun: TransferRunner = async (args, { signal, onLine }) => {
  const proc = Bun.spawn({ cmd: args, stdout: "pipe", stderr: "pipe", signal });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
    } catch {
      // Reader aborted with the child — nothing to surface.
    }
  })();
  // Drain stderr so a chatty gosh can never deadlock the child.
  void proc.stderr.getReader().read().catch(() => {});
  return await proc.exited;
};

function rowToEntry(row: DownloadRow): DownloadEntry {
  return { modelId: row.model_id, url: row.url, state: row.state, bytes: row.bytes };
}

export function createDownloadEngine(
  db: Database,
  opts: DownloadEngineOptions = {},
): DownloadEngine {
  const run = opts.run ?? defaultRun;
  const verify = opts.verify ?? verifySha256File;
  const unlink = opts.unlink ?? ((filePath: string) => rmSync(filePath, { force: true }));
  const active = new Map<string, AbortController>();

  const setState = (modelId: string, state: DownloadState): void => {
    db.query("UPDATE downloads SET state = ?, updated_at = datetime('now') WHERE model_id = ?").run(
      state,
      modelId,
    );
  };

  const setBytes = (modelId: string, bytes: number): void => {
    db.query("UPDATE downloads SET bytes = ? WHERE model_id = ?").run(bytes, modelId);
  };

  /** Run one full transfer lifecycle with per-download abort control. */
  const transfer = async (
    spec: DownloadSpec,
    onProgress?: (modelId: string, percent: number) => void,
  ): Promise<void> => {
    const controller = new AbortController();
    active.set(spec.modelId, controller);
    setState(spec.modelId, "downloading");
    try {
      const checksum = assertChecksumPrefix(spec.expectedSha256);
      const hex = checksum.slice("sha256:".length);
      const args = buildGoshTransferArgs({
        url: spec.url,
        dir: spec.dir,
        out: spec.fileName,
        checksumHex: spec.expectedSha256,
        maxConnections: spec.maxConnections ?? opts.maxConnections,
      });

      const exitCode = await run(args, {
        signal: controller.signal,
        onLine: (line) => {
          const ev = parseGoshEvent(line);
          if (ev === null) return;
          if (ev.status === "downloading" && ev.percent !== undefined) {
            onProgress?.(spec.modelId, ev.percent);
          }
          if (ev.bytes !== undefined) setBytes(spec.modelId, ev.bytes);
        },
      });

      if (exitCode === 130 || controller.signal.aborted) {
        // gosh Ctrl+C / abort: transfer preserved for resume.
        setState(spec.modelId, "resumable");
        return;
      }
      if (exitCode !== 0) {
        setState(spec.modelId, "failed");
        return;
      }

      // exit 0 → integrity gate: register ONLY on a verified digest.
      setState(spec.modelId, "verifying");
      const filePath = join(spec.dir, spec.fileName);
      const ok = await verify(filePath, hex);
      if (!ok) {
        unlink(filePath); // discard — never register a corrupt file
        setState(spec.modelId, "failed");
        return;
      }

      db.query(
        `INSERT INTO models (id, source, name, path, url, sha256, state)
         VALUES (?, 'download', ?, ?, ?, ?, 'ready')
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, url = excluded.url, sha256 = excluded.sha256, state = 'ready'`,
      ).run(spec.modelId, spec.fileName, filePath, spec.url, hex);
      setState(spec.modelId, "completed");
    } finally {
      active.delete(spec.modelId);
    }
  };

  const getRow = (modelId: string): DownloadRow | undefined =>
    (db.query("SELECT * FROM downloads WHERE model_id = ?").get(modelId) as
      | DownloadRow
      | undefined);

  return {
    async enqueue(spec, opts) {
      // Upsert the queue row, then drive the transfer to completion.
      db.query(
        `INSERT INTO downloads (model_id, url, state, file_name, sha256, dir)
         VALUES (?, ?, 'queued', ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           url = excluded.url, state = 'queued', file_name = excluded.file_name,
           sha256 = excluded.sha256, dir = excluded.dir`,
      ).run(spec.modelId, spec.url, spec.fileName, spec.expectedSha256, spec.dir);
      await transfer(spec, opts?.onProgress);
    },

    async resume(modelId) {
      const row = getRow(modelId);
      if (row === undefined || row.state !== "resumable") return;
      if (row.file_name === null || row.sha256 === null || row.dir === null) {
        setState(modelId, "failed"); // queue row predates resume metadata
        return;
      }
      await transfer({
        modelId,
        url: row.url,
        fileName: row.file_name,
        expectedSha256: row.sha256,
        dir: row.dir,
      });
    },

    async resumeAll() {
      const rows = db
        .query("SELECT * FROM downloads WHERE state = 'resumable'")
        .all() as DownloadRow[];
      await Promise.all(
        rows.map((row) =>
          this.resume(row.model_id).catch(() => {
            setState(row.model_id, "failed");
          }),
        ),
      );
    },

    async cancel(modelId) {
      const controller = active.get(modelId);
      if (controller !== undefined) controller.abort();
      // The in-flight transfer observes the abort and persists `resumable`.
    },

    state(modelId) {
      return getRow(modelId)?.state ?? null;
    },

    list() {
      return (db.query("SELECT * FROM downloads ORDER BY updated_at").all() as DownloadRow[]).map(
        rowToEntry,
      );
    },
  };
}