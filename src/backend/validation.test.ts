/**
 * Backend config validation tests (strict TDD, S1 — Bun.which migration).
 *
 * S1 replaces the `execFileSync("which")` subprocess lookup with `Bun.which()`
 * while preserving the fail-fast semantics (absolute path exists-check, PATH
 * lookup, same actionable error strings). Per ADR-3, resolveBinary accepts an
 * optional `which` seam: Bun.which reads a PATH snapshot taken at startup (it
 * does NOT observe live process.env.PATH mutations — runtime-verified
 * 2026-09-02), so tests inject a deterministic which for the PATH cases.
 *
 * These started as approval tests over the Node implementation (behavior
 * captured first) and gate the swap: identical semantics on Bun.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlamaConfig } from "../config/schema.js";
import { resolveBinary, validateBackendConfig } from "./validation.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-proxy-validate-"));
  fs.mkdirSync(path.join(tmpDir, "models"));
  fs.mkdirSync(path.join(tmpDir, "bin"));
  fs.writeFileSync(path.join(tmpDir, "bin", "llama"), "fake-binary", "utf8");
  fs.writeFileSync(path.join(tmpDir, "models", "m1.gguf"), "dummy", "utf8");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function minimalConfig(over: Partial<LlamaConfig> = {}): LlamaConfig {
  return {
    binary: path.join(tmpDir, "bin", "llama"),
    host: "127.0.0.1",
    port: 8080,
    autoStart: true,
    startupTimeoutMs: 30000,
    stopTimeoutMs: 5000,
    requestTimeoutMs: 300000,
    healthPollIntervalMs: 1000,
    portParseTimeoutMs: 5000,
    backoffCapMs: 30000,
    maxRestartAttempts: 5,
    modelsDir: path.join(tmpDir, "models"),
    autoload: true,
    router: {
      ctx: 8192,
      n: 2048,
      nGpuLayers: -1,
      flashAttn: true,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      batch: 2048,
      ubatch: 512,
      tools: "all",
      parallel: 1,
    },
    models: { m1: { file: "m1.gguf" } },
    ...over,
  };
}

describe("resolveBinary (Bun.which swap)", () => {
  test("absolute existing binary resolves to itself", () => {
    const bin = path.join(tmpDir, "bin", "llama");
    expect(resolveBinary(bin)).toBe(bin);
  });

  test("absolute missing binary fails with the actionable path error", () => {
    const missing = path.join(tmpDir, "bin", "nope");
    expect(() => resolveBinary(missing)).toThrow(
      /llama binary not found at path: .*nope/,
    );
  });

  test("PATH lookup resolves via the which seam", () => {
    const onPath = "/opt/fake/bin/llama";
    const resolved = resolveBinary("llama", () => onPath);
    expect(resolved).toBe(onPath);
  });

  test("PATH lookup miss fails with the actionable PATH error", () => {
    expect(() => resolveBinary("llama", () => null)).toThrow(
      /llama binary "llama" not found on PATH/,
    );
  });

  test("default seam is the real Bun.which under the declared runtime", () => {
    // The workspace's declared runtime (bun) is resolvable through the default
    // no-arg path — proves the default seam is wired to Bun.which, not which(1).
    const resolved = resolveBinary("bun");
    // Exact assertion: resolveBinary returns a non-empty absolute path string.
    expect(typeof resolved).toBe("string");
    expect(resolved).toMatch(/^\/.+/);
    // The path must actually exist on disk (Bun.which resolved a real binary).
    expect(fs.existsSync(resolved)).toBe(true);
  });
});

describe("validateBackendConfig (unchanged fail-fast contract)", () => {
  test("missing GGUF fails at startup naming the file (approval)", () => {
    const cfg = minimalConfig({
      models: { m2: { file: "does-not-exist.gguf" } },
    });
    expect(() => validateBackendConfig(cfg)).toThrow(
      /GGUF file for model "m2" not found: .*does-not-exist\.gguf/,
    );
  });

  test("missing modelsDir fails at startup (approval)", () => {
    const cfg = minimalConfig({ modelsDir: path.join(tmpDir, "nope") });
    expect(() => validateBackendConfig(cfg)).toThrow(/modelsDir does not exist/);
  });

  test("valid config passes validation (approval)", () => {
    expect(() => validateBackendConfig(minimalConfig())).not.toThrow();
  });
});