/**
 * Config defaults generation tests (strict TDD — Slice A, config-load Req
 * "Config defaults generation").
 *
 * Covers the "Missing config boots on generated defaults" scenario: when no
 * config file exists, generate a minimal schema-valid config by scanning the
 * models directory for `*.gguf` (case-insensitive), listing each detected file
 * as a candidate model. The generated config MUST validate against the schema.
 */
import { describe, expect, test } from "bun:test";
import { configSchema } from "./schema.js";
import {
  buildDefaultConfig,
  generateDefaultConfig,
  scanGgufFiles,
  type DefaultsDeps,
} from "./defaults.js";

describe("buildDefaultConfig", () => {
  test("returns a schema-valid minimal config with an empty model set", () => {
    const cfg = buildDefaultConfig("~/Models", []);
    expect(configSchema.safeParse(cfg).success).toBe(true);
    expect(cfg.llama.modelsDir).toBe("~/Models");
    expect(Object.keys(cfg.llama.models)).toHaveLength(0);
  });

  test("lists each scanned gguf as a candidate model (m1.gguf -> m1)", () => {
    const cfg = buildDefaultConfig("~/Models", ["m1.gguf"]);
    expect(configSchema.safeParse(cfg).success).toBe(true);
    expect(cfg.llama.models["m1"]).toEqual({
      file: "m1.gguf",
      ctx: 65536,
      temp: 0.1,
    });
  });

  test("maps multiple files and preserves their stems", () => {
    const cfg = buildDefaultConfig("/models", [
      "SmolLM3-3B-Q4_K_M.gguf",
      "Llama3.2-3B-Instruct-Q4_K_M.gguf",
    ]);
    expect(configSchema.safeParse(cfg).success).toBe(true);
    expect(Object.keys(cfg.llama.models).sort()).toEqual([
      "Llama3.2-3B-Instruct-Q4_K_M",
      "SmolLM3-3B-Q4_K_M",
    ]);
  });
});

describe("scanGgufFiles", () => {
  test("returns only .gguf filenames, case-insensitive (.GGUF matches)", async () => {
    const deps: DefaultsDeps = {
      listFiles: () => [
        "M1.gguf", // match (lower)
        "M2.GGUF", // match (upper)
        "notes.txt", // not a model
        "README.md",
      ],
      expandHome: (p) => p,
    };
    const files = await scanGgufFiles("/models", deps);
    expect(files.sort()).toEqual(["M1.gguf", "M2.GGUF"]);
  });

  test("expands a leading tilde to the home directory before listing", async () => {
    let listed: string | undefined;
    const deps: DefaultsDeps = {
      listFiles: (dir) => {
        listed = dir;
        return [];
      },
      expandHome: (p) => p.replace(/^~/, "/home/andy"),
    };
    await scanGgufFiles("~/Models", deps);
    expect(listed).toBe("/home/andy/Models");
  });
});

describe("generateDefaultConfig", () => {
  test("produces a schema-valid config listing the scanned candidate", async () => {
    const deps: DefaultsDeps = {
      listFiles: () => ["m1.gguf"],
      expandHome: (p) => p,
    };
    const cfg = await generateDefaultConfig("~/Models", deps);
    expect(configSchema.safeParse(cfg).success).toBe(true);
    expect(cfg.llama.models["m1"]).toEqual({ file: "m1.gguf", ctx: 65536, temp: 0.1 });
  });

  test("handles an empty models directory with a valid empty config", async () => {
    const deps: DefaultsDeps = {
      listFiles: () => [],
      expandHome: (p) => p,
    };
    const cfg = await generateDefaultConfig("/empty", deps);
    expect(configSchema.safeParse(cfg).success).toBe(true);
    expect(Object.keys(cfg.llama.models)).toHaveLength(0);
  });
});
