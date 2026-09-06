#!/usr/bin/env bun
/**
 * Task 4.2 — bundle size guard for the compiled Svelte SPA.
 *
 * Measures the gzip size of the production app JS entry (dist/ui/assets/*)
 * and fails the build when it exceeds the budget (default 100 KB gzip).
 *
 * Usage:
 *   bun run scripts/measure-bundle.ts            # measure + assert (expects dist/ui present)
 *   BUDGET_KB=200 bun run scripts/measure-bundle.ts  # custom budget
 *
 * Pure helpers are exported for unit tests; the CLI entry only runs when
 * this module is executed directly (import.meta.main).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

/** Default gzip budget for the prod app JS entry, in KB. */
export const DEFAULT_BUDGET_KB = 100;

/** The Vite entry chunk naming: index-<hash>.js (hashed asset). */
const APP_JS_PATTERN = /^index-.*\.js$/;

/**
 * Gzip-compress the given bytes and return the compressed byte length.
 * Pure and deterministic — the bundle guard's core measurement.
 */
export function gzipBytes(input: Uint8Array): number {
  return gzipSync(input, { level: 9 }).byteLength;
}

/**
 * Locate the production app JS entry among the emitted asset file names.
 * Vite names the entry `index-<hash>.js`; any other `.js` file (vendor,
 * polyfill chunks) does not represent the app entry.
 *
 * @returns the matching file name, or undefined when no entry was emitted.
 */
export function findAppJs(files: readonly string[]): string | undefined {
  return files.find((file) => APP_JS_PATTERN.test(file));
}

/**
 * Parse the budget override from a raw string (env var / CLI arg).
 * Non-numeric or empty input falls back to DEFAULT_BUDGET_KB.
 */
export function parseBudgetKB(raw: string | undefined): number {
  if (!raw) return DEFAULT_BUDGET_KB;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_BUDGET_KB;
}

/** Result of a bundle measurement run — used by the CLI and tests. */
export interface BundleMeasurement {
  /** File name of the measured entry (relative to assets dir). */
  entry: string;
  /** Raw (uncompressed) byte length of the entry. */
  rawBytes: number;
  /** Gzip byte length of the entry. */
  gzipBytes: number;
  /** Size in KB (gzipBytes / 1024), rounded to 2 decimals. */
  gzipKB: number;
  /** The budget the measurement was checked against, in KB. */
  budgetKB: number;
}

/**
 * Measure the prod app JS entry under `dist/ui/assets`.
 *
 * @returns the measurement, or null when the build directory is missing or
 *   contains no index-*.js entry.
 */
export function measureBundle(uiDir: string, budgetKB: number): BundleMeasurement | null {
  const assetsDir = path.join(uiDir, "assets");
  if (!existsSync(assetsDir)) return null;
  const files = readdirSync(assetsDir);
  const entry = findAppJs(files);
  if (!entry) return null;
  const bytes = readFileSync(path.join(assetsDir, entry));
  const gzipped = gzipBytes(bytes);
  return {
    entry,
    rawBytes: bytes.byteLength,
    gzipBytes: gzipped,
    gzipKB: Math.round((gzipped / 1024) * 100) / 100,
    budgetKB,
  };
}

// ── CLI entry (only when executed directly) ────────────────────────────────
async function main(): Promise<void> {
  const uiDir = path.join(process.cwd(), "dist", "ui");
  const budgetKB = parseBudgetKB(process.env.BUDGET_KB);
  const measured = measureBundle(uiDir, budgetKB);

  if (!measured) {
    console.error(
      `[bundle] dist/ui missing or no index-*.js entry — run "bun run build:ui" first`,
    );
    process.exit(1);
  }

  console.log(
    `[bundle] app JS: ${measured.entry} (${measured.rawBytes} B raw, ` +
      `${measured.gzipKB} KB gzip; budget ${measured.budgetKB} KB)`,
  );

  if (measured.gzipKB > measured.budgetKB) {
    console.error(
      `[bundle] BUDGET EXCEEDED: ${measured.gzipKB} KB > ${measured.budgetKB} KB gzip`,
    );
    process.exit(1);
  }
  console.log(`[bundle] OK — ${measured.gzipKB} KB ≤ ${measured.budgetKB} KB gzip`);
}

if (import.meta.main) {
  void main();
}