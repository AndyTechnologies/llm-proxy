import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUPPORTED_TARGETS,
  BUNDLE_SIZE_LIMIT,
  assertBundleSize,
  targetTriples,
} from "../scripts/build-binaries-args.js";
import { enforceSizeGate } from "../scripts/build-binaries.js";

describe("bundle targets", () => {
  test("exactly the three supported platform triples", () => {
    expect(targetTriples()).toEqual([
      { platform: "darwin", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "linux", arch: "x64" },
    ]);
    expect(SUPPORTED_TARGETS).toHaveLength(3);
    expect(SUPPORTED_TARGETS.join(",")).not.toContain("win");
  });
});

describe("assertBundleSize", () => {
  test("a bundle at the limit passes (must stay UNDER 100 MB)", () => {
    expect(assertBundleSize(BUNDLE_SIZE_LIMIT).ok).toBe(true);
  });

  test("one byte over the limit fails the build with a size report", () => {
    expect(() => assertBundleSize(BUNDLE_SIZE_LIMIT + 1)).toThrow(/100 MB/);
  });

  test("a 101 MB bundle fails", () => {
    expect(() => assertBundleSize(101 * 1024 * 1024)).toThrow(/100 MB/);
  });
});

describe("enforceSizeGate", () => {
  test("collects nested bundle artifacts and enforces the gate on them", () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-gate-"));
    mkdirSync(join(dir, "dist", "darwin-arm64"), { recursive: true });
    const small = join(dir, "dist", "darwin-arm64", "weavellm.dmg");
    writeFileSync(small, Buffer.alloc(1024));
    expect(enforceSizeGate(join(dir, "dist"))).toHaveLength(1);
  });

  test("an over-limit artifact inside dist fails the gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "weavellm-gate-"));
    mkdirSync(join(dir, "dist", "linux-x64"), { recursive: true });
    const big = join(dir, "dist", "linux-x64", "weavellm.tar.gz");
    writeFileSync(big, Buffer.alloc(BUNDLE_SIZE_LIMIT + 1));
    expect(() => enforceSizeGate(join(dir, "dist"))).toThrow(/100 MB/);
  });
});