/**
 * Task 4.2 tests — bundle size guard for the compiled Svelte SPA.
 *
 * Pure-function tests: gzipBytes, findAppJs, parseBudgetKB.
 * The build-and-assert script (measure-bundle.ts) reuses these functions.
 */
import { describe, expect, test } from "bun:test";
import {
  gzipBytes,
  findAppJs,
  parseBudgetKB,
  DEFAULT_BUDGET_KB,
} from "./measure-bundle.js";

// ── gzipBytes ───────────────────────────────────────────────────────────────

describe("gzipBytes", () => {
  test("returns compressed size for known input", async () => {
    const input = Buffer.from("hello world ".repeat(1000));
    const gzipped = await gzipBytes(input);
    // Repeated strings compress well — gzip should be much smaller.
    expect(gzipped).toBeLessThan(input.byteLength);
    expect(gzipped).toBeGreaterThan(0);
  });

  test("zero-length input produces minimal gzip", async () => {
    const gzipped = await gzipBytes(Buffer.alloc(0));
    // gzip header alone is ~20 bytes.
    expect(gzipped).toBeLessThanOrEqual(30);
    expect(gzipped).toBeGreaterThanOrEqual(0);
  });
});

// ── findAppJs ───────────────────────────────────────────────────────────────

describe("findAppJs", () => {
  test("returns path for index-*.js file", () => {
    const files = [
      "index-C_9lFY4X.css",
      "index-uxwfYP_f.js",
      "favicon.svg",
    ];
    const result = findAppJs(files);
    expect(result).toBe("index-uxwfYP_f.js");
  });

  test("returns undefined when no JS match", () => {
    const files = ["index-C_9lFY4X.css", "favicon.svg"];
    const result = findAppJs(files);
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty list", () => {
    const result = findAppJs([]);
    expect(result).toBeUndefined();
  });

  test("prefers index-*.js over other .js files", () => {
    const files = ["vendor-abc.js", "index-xyz.js", "polyfill-def.js"];
    const result = findAppJs(files);
    expect(result).toBe("index-xyz.js");
  });
});

// ── parseBudgetKB ───────────────────────────────────────────────────────────

describe("parseBudgetKB", () => {
  test("parses numeric string to KB", () => {
    expect(parseBudgetKB("200")).toBe(200);
  });

  test("returns default for empty string", () => {
    expect(parseBudgetKB("")).toBe(DEFAULT_BUDGET_KB);
  });

  test("returns default for non-numeric string", () => {
    expect(parseBudgetKB("abc")).toBe(DEFAULT_BUDGET_KB);
  });

  test("parses zero as zero (valid, but will fail budget check)", () => {
    expect(parseBudgetKB("0")).toBe(0);
  });
});

// ── DEFAULT_BUDGET_KB ───────────────────────────────────────────────────────

describe("DEFAULT_BUDGET_KB", () => {
  test("is 100 KB", () => {
    expect(DEFAULT_BUDGET_KB).toBe(100);
  });
});
