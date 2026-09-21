/**
 * Phase 3 — DownloadEngine (model-downloads): queue / cancel→resumable /
 * resume / resume-all, SHA256 verification with discard-on-mismatch, and
 * SQLite persistence of download state (downloads + models registry rows).
 *
 * The transfer runner is injected (`run`) so the whole lifecycle is tested
 * with a scripted fake gosh; the only real I/O is the temp file used to prove
 * digest verification actually runs against bytes on disk.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import {
  createDownloadEngine,
  verifySha256Hex,
  type DownloadEngine,
  type TransferRunner,
} from "./engine.js";

const HEX = async (bytes: Uint8Array): Promise<string> => {
  const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  buf.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const PREFIXED = (hex: string): string => `sha256:${hex}`;

function memoryDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

/** Fake gosh: records argv, emits scripted stdout lines, returns an exit code. */
function fakeRunner(script: {
  lines?: string[];
  exitCode?: number;
  abortExitCode?: number;
}): { run: TransferRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: TransferRunner = async (args, { signal, onLine }) => {
    calls.push([...args]);
    for (const line of script.lines ?? []) onLine(line);
    if (signal.aborted) return script.abortExitCode ?? 130;
    return script.exitCode ?? 0;
  };
  return { run, calls };
}

describe("verifySha256Hex — integrity primitive", () => {
  test("accepts a matching digest and rejects a differing one", async () => {
    const bytes = new TextEncoder().encode("llm-proxy fixture payload");
    const hex = await HEX(bytes);
    expect(await verifySha256Hex(bytes, hex)).toBe(true);
    expect(await verifySha256Hex(bytes, "00".repeat(32))).toBe(false);
  });
});

describe("DownloadEngine queue → verify → register (3.1/3.3)", () => {
  test("downloads, verifies the real file digest, and registers the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-dl-"));
    const db = memoryDb();
    try {
      const filePath = join(dir, "model.Q8_0.gguf");
      const bytes = new TextEncoder().encode("fake gguf bytes for the engine");
      writeFileSync(filePath, bytes);
      const sha = await HEX(bytes);

      const { run, calls } = fakeRunner({
        lines: [JSON.stringify({ status: "completed", bytes: 1234 })],
        exitCode: 0,
      });
      const engine: DownloadEngine = createDownloadEngine(db, { run });

      await engine.enqueue({
        modelId: "model-a",
        url: "https://example.com/model-a.gguf",
        fileName: "model.Q8_0.gguf",
        dir,
        expectedSha256: PREFIXED(sha),
      });

      // The transfer argv carries the REQUIRED sha256:<hex> prefix.
      const argv = calls[0];
      expect(argv).toContain("--checksum");
      expect(argv).toContain(`sha256:${sha}`);
      expect(argv).toContain("-d");
      expect(argv).toContain(dir);

      // Registered: models row points at the verified file.
      const model = db
        .query("SELECT id, source, path, sha256, state FROM models WHERE id = ?")
        .get("model-a") as Record<string, unknown>;
      expect(model.path).toBe(filePath);
      expect(model.sha256).toBe(sha);
      expect(model.state).toBe("ready");

      const dl = db
        .query("SELECT state, bytes FROM downloads WHERE model_id = ?")
        .get("model-a") as Record<string, unknown>;
      expect(dl.state).toBe("completed");
      expect(dl.bytes).toBe(1234);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forwards gosh progress lines to the onProgress callback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-dl-"));
    const db = memoryDb();
    try {
      const filePath = join(dir, "m.gguf");
      const bytes = new TextEncoder().encode("progress fixture");
      writeFileSync(filePath, bytes);
      const sha = await HEX(bytes);

      const { run } = fakeRunner({
        lines: [
          JSON.stringify({
            status: "downloading",
            progress: { percent: 42.5, bytes: 987 },
          }),
          JSON.stringify({ status: "completed", bytes: 987 }),
        ],
        exitCode: 0,
      });
      const seen: Array<{ modelId: string; percent: number }> = [];
      const engine = createDownloadEngine(db, { run });
      await engine.enqueue(
        {
          modelId: "model-b",
          url: "https://example.com/m.gguf",
          fileName: "m.gguf",
          dir,
          expectedSha256: PREFIXED(sha),
        },
        {
          onProgress: (modelId, percent) => seen.push({ modelId, percent }),
        },
      );
      expect(seen).toContainEqual({ modelId: "model-b", percent: 42.5 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checksum mismatch discards the file and does NOT register the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-dl-"));
    const db = memoryDb();
    try {
      const filePath = join(dir, "evil.gguf");
      const bytes = new TextEncoder().encode("corrupt bytes");
      writeFileSync(filePath, bytes);
      const wrongSha = "00".repeat(32); // declared digest does NOT match file

      const { run } = fakeRunner({ exitCode: 0 });
      const unlinked: string[] = [];
      const engine = createDownloadEngine(db, {
        run,
        unlink: (p) => {
          unlinked.push(p);
          rmSync(p, { force: true });
        },
      });

      await engine.enqueue({
        modelId: "model-bad",
        url: "https://example.com/evil.gguf",
        fileName: "evil.gguf",
        dir,
        expectedSha256: PREFIXED(wrongSha),
      });

      const model = db
        .query("SELECT COUNT(*) AS n FROM models WHERE id = ?")
        .get("model-bad") as { n: number };
      expect(model.n).toBe(0); // unregistered

      const dl = db
        .query("SELECT state FROM downloads WHERE model_id = ?")
        .get("model-bad") as { state: string };
      expect(dl.state).toBe("failed");
      expect(unlinked).toContain(filePath); // discarded
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cancel → resumable, resume, resume-all (3.4)", () => {
  test("cancel aborts the child and leaves the download resumable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-dl-"));
    const db = memoryDb();
    try {
      const filePath = join(dir, "m.gguf");
      const bytes = new TextEncoder().encode("resume fixture");
      writeFileSync(filePath, bytes);
      const sha = await HEX(bytes);

      const { run, calls } = fakeRunner({ abortExitCode: 130 });
      const engine = createDownloadEngine(db, { run });

      const p = engine.enqueue({
        modelId: "model-c",
        url: "https://example.com/m.gguf",
        fileName: "m.gguf",
        dir,
        expectedSha256: PREFIXED(sha),
      });
      await engine.cancel("model-c");
      await p;

      const dl = db
        .query("SELECT state FROM downloads WHERE model_id = ?")
        .get("model-c") as { state: string };
      expect(dl.state).toBe("resumable");
      expect(engine.state("model-c")).toBe("resumable");
      // The fake received an aborted signal (gosh Ctrl+C exit 130 → resumable).
      expect(calls.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resume re-runs the transfer for one resumable download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-dl-"));
    const db = memoryDb();
    try {
      const filePath = join(dir, "m.gguf");
      const bytes = new TextEncoder().encode("resume fixture");
      writeFileSync(filePath, bytes);
      const sha = await HEX(bytes);

      const { run, calls } = fakeRunner({ abortExitCode: 130 });
      const engine = createDownloadEngine(db, { run });

      const p = engine.enqueue({
        modelId: "model-c",
        url: "https://example.com/m.gguf",
        fileName: "m.gguf",
        dir,
        expectedSha256: PREFIXED(sha),
      });
      await engine.cancel("model-c");
      await p;
      expect(engine.state("model-c")).toBe("resumable");

      // Second run succeeds → completed.
      calls.length = 0;
      const run2 = fakeRunner({ exitCode: 0 });
      const engine2 = createDownloadEngine(db, { run: run2.run });
      await engine2.resume("model-c");

      expect(run2.calls.length).toBe(1);
      expect(engine2.state("model-c")).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resumeAll re-runs every resumable download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-dl-"));
    const db = memoryDb();
    try {
      const mk = async (id: string, name: string): Promise<string> => {
        const filePath = join(dir, name);
        const bytes = new TextEncoder().encode(`fixture ${id}`);
        writeFileSync(filePath, bytes);
        return await HEX(bytes);
      };
      const shaA = await mk("a", "a.gguf");
      const shaB = await mk("b", "b.gguf");

      // Seed two resumable rows with full resume metadata (as a cancelled
      // enqueue would persist them).
      db.query(
        `INSERT INTO downloads (model_id, url, state, bytes, file_name, sha256, dir)
         VALUES (?, ?, 'resumable', 0, 'a.gguf', ?, ?)`,
      ).run("a", "https://example.com/a.gguf", `sha256:${shaA}`, dir);
      db.query(
        `INSERT INTO downloads (model_id, url, state, bytes, file_name, sha256, dir)
         VALUES (?, ?, 'resumable', 0, 'b.gguf', ?, ?)`,
      ).run("b", "https://example.com/b.gguf", `sha256:${shaB}`, dir);

      const { run, calls } = fakeRunner({ exitCode: 0 });
      const engine = createDownloadEngine(db, {
        run,
        verify: async (filePath) => {
          const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
          return filePath.endsWith("a.gguf")
            ? (await HEX(bytes)) === shaA
            : (await HEX(bytes)) === shaB;
        },
      });

      await engine.resumeAll();

      expect(calls.length).toBe(2);
      expect(engine.state("a")).toBe("completed");
      expect(engine.state("b")).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("download state persists in SQLite", () => {
  test("downloads and models rows survive a database reopen", async () => {
    const temp = mkdtempSync(join(tmpdir(), "weavellm-dl-"));
    const dir = join(temp, "models");
    const dbFile = join(temp, "weavellm.db");
    try {
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, "m.gguf");
      writeFileSync(filePath, "persisted", "utf8");
      const sha = await HEX(new TextEncoder().encode("persisted"));
      const expected = PREFIXED(sha);

      const db1 = new Database(dbFile);
      applySchema(db1);
      const { run } = fakeRunner({ exitCode: 0 });
      await createDownloadEngine(db1, { run }).enqueue({
        modelId: "persist",
        url: "https://example.com/p.gguf",
        fileName: "m.gguf",
        dir,
        expectedSha256: expected,
      });
      db1.close();

      // Reload — the registry rebuilds entirely from SQLite (3.6).
      const db2 = new Database(dbFile);
      applySchema(db2);
      const dl = db2
        .query("SELECT state FROM downloads WHERE model_id = ?")
        .get("persist") as { state: string };
      expect(dl.state).toBe("completed");
      const model = db2
        .query("SELECT sha256 FROM models WHERE id = ?")
        .get("persist") as { sha256: string };
      expect(model.sha256).toBe(sha);
      expect(db2.query("SELECT COUNT(*) AS n FROM models").get()).toEqual({ n: 1 });
      db2.close();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});