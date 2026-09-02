/**
 * Models preset INI tests (strict TDD, S1 — Bun.file write migration).
 *
 * renderPresetIni is pure and its behavior is preserved byte-for-byte
 * (approval tests captured the current output first). writePresetIni changes
 * its write mechanism from fs.writeFileSync to Bun.file().write() — an async
 * operation — so the function becomes async and the test asserts the new
 * Promise contract plus the on-disk result.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { LlamaConfig } from "../config/schema.js";
import { renderPresetIni, writePresetIni } from "./preset.js";

const MODELS_DIR = "/tmp/llm-proxy-fixture-models";

function configWithModels(models: LlamaConfig["models"]): LlamaConfig {
  return {
    binary: "/usr/bin/llama",
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
    modelsDir: MODELS_DIR,
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
    models,
  };
}

afterEach(() => {
  fs.rmSync(path.resolve(".llm-proxy"), { recursive: true, force: true });
});

describe("renderPresetIni (pure render, unchanged)", () => {
  test("two models render as INI sections with resolved paths and per-model keys", () => {
    const cfg = configWithModels({
      smol: { file: "SmolLM3-3B-Q4_K_M.gguf", ctx: 4096, temp: 0.1 },
      phi: { file: "/abs/Phi-4.gguf" },
    });

    expect(renderPresetIni(cfg, MODELS_DIR)).toBe(
      [
        "[smol]",
        `model = ${path.join(MODELS_DIR, "SmolLM3-3B-Q4_K_M.gguf")}`,
        "ctx-size = 4096",
        "temp = 0.1",
        "",
        "[phi]",
        "model = /abs/Phi-4.gguf",
        "",
      ].join("\n"),
    );
  });

  test("CLI-style per-model args convert to INI key = value pairs, boolean flags to '= on'", () => {
    const cfg = configWithModels({
      qwen: { file: "Qwen.gguf", args: "--n-gpu-layers 99 --no-context-shift" },
    });

    expect(renderPresetIni(cfg, MODELS_DIR)).toBe(
      [
        "[qwen]",
        `model = ${path.join(MODELS_DIR, "Qwen.gguf")}`,
        "n-gpu-layers = 99",
        "no-context-shift = on",
        "",
      ].join("\n"),
    );
  });

  test("relative and absolute model files resolve as-is (no re-resolution)", () => {
    const cfg = configWithModels({
      rel: { file: "rel.gguf" },
      abs: { file: "/data/abs.gguf" },
    });
    const ini = renderPresetIni(cfg, MODELS_DIR);
    expect(ini).toContain(`model = ${path.join(MODELS_DIR, "rel.gguf")}`);
    expect(ini).toContain("model = /data/abs.gguf");
  });
});

describe("writePresetIni (Bun.file write)", () => {
  test("returns a Promise resolving to the preset path and writes the rendered content", async () => {
    const cfg = configWithModels({
      a: { file: "a.gguf" },
      b: { file: "b.gguf" },
    });

    const ret = writePresetIni(cfg, MODELS_DIR);
    // New async contract: Bun.file().write() is async — the call must not
    // block with a sync fs write.
    expect(ret).toBeInstanceOf(Promise);

    const filePath = await ret;
    expect(filePath).toBe(path.resolve(".llm-proxy", "models.ini"));
    expect(fs.readFileSync(filePath, "utf8")).toBe(
      renderPresetIni(cfg, MODELS_DIR),
    );
  });

  test("regenerates idempotently and logs the model count", async () => {
    const cfg = configWithModels({ a: { file: "a.gguf" } });
    const log = console.log;
    const messages: string[] = [];
    console.log = (msg: unknown) => messages.push(String(msg));
    try {
      await writePresetIni(cfg, MODELS_DIR);
      await writePresetIni(cfg, MODELS_DIR);
      expect(messages.join("\n")).toContain(
        "[backend] preset written: " + path.resolve(".llm-proxy", "models.ini") + " (1 models)",
      );
    } finally {
      console.log = log;
    }
  });
});