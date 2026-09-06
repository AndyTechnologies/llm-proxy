/**
 * Task 4.3 (MAJOR-3) — binary smoke test, executed from an unrelated cwd.
 *
 * The gateway binary is built with `--asset dist/ui` (task 4.1), embedding
 * the compiled SPA. This test proves the delivery contract of the binary
 * from a cwd OUTSIDE the repository (every spawn runs in a throwaway temp
 * dir):
 *
 *   1. embedded `/ui` serves index.html (read-only path resolves)
 *   2. embedded `/ui/assets/*` serves with the correct content type
 *   3. unknown GET under /ui/ falls back to index.html; traversal is 404
 *   4. disk fallback: a `dist/ui` copy in the cwd wins over the embedded one
 *   5. `UI_DIR` override wins over both disk copy and embedded assets
 *
 * The behaviour is exercised through `collectSmokeEvidence` from
 * `binary-smoke.ts`, which performs REAL spawns of the compiled binary and
 * REAL HTTP probes; the same helpers drive the CLI script
 * (`bun scripts/binary-smoke.ts`).
 *
 * Skipped (with reason) when the prebuilt `dist/llm-proxy` or the compiled
 * `dist/ui` output is missing (mirrors `src/dashboard/e2e-smoke.test.ts`).
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSmokeEvidence, type SmokeEvidence } from "./binary-smoke.js";

const REPO_ROOT = path.join(import.meta.dir, "..");
const BINARY = path.join(REPO_ROOT, "dist", "llm-proxy");
const UI_BUILT = existsSync(path.join(REPO_ROOT, "dist", "ui", "index.html"));
const RUNNABLE = UI_BUILT && existsSync(BINARY);

/** Throwaway parent dir — every spawned binary runs with a cwd under it. */
let workspaceRoot: string;
/** Evidence collected ONCE, then asserted per-test. */
let evidence: SmokeEvidence;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "llm-proxy-smoke-"));
  if (RUNNABLE) {
    evidence = await collectSmokeEvidence(
      BINARY,
      workspaceRoot,
      path.join(REPO_ROOT, "dist", "ui"),
    );
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe.skipIf(!RUNNABLE)("binary smoke (task 4.3)", () => {
  test("embedded /ui serves index.html (read-only path resolves)", () => {
    expect(evidence.indexStatus).toBe(200);
    expect(evidence.indexContentType).toContain("text/html");
  });

  test("embedded /ui/assets/* serves the hashed app JS entry", () => {
    expect(evidence.assetStatus).toBe(200);
    expect(evidence.assetContentType).toContain("application/javascript");
  });

  test("unknown /ui/* GET falls back to index.html", () => {
    expect(evidence.fallbackStatus).toBe(200);
    expect(evidence.fallbackContentType).toContain("text/html");
  });

  test("path traversal under /ui returns 404 (no fallback)", () => {
    expect(evidence.traversalStatus).toBe(404);
    expect(evidence.traversalContentType).toContain("application/json");
  });

  test("disk fallback: dist/ui copy in the cwd wins over embedded assets", () => {
    expect(evidence.diskIndexBody).toBe("DISK-FALLBACK");
  });

  test("UI_DIR override wins over disk copy and embedded assets", () => {
    expect(evidence.overrideIndexBody).toBe("OVERRIDE-INDEX");
    expect(evidence.overrideAssetStatus).toBe(200);
  });
});