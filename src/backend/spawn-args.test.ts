/**
 * Phase 2 RED/GREEN — llama-server spawn argument builder, stdout port
 * parsing, and the b9908+ version floor. Pure functions; no process I/O.
 * Specs: backend-management (single spawn, YaRN/KV flags, cache-ram
 * semantics, version floor), model-advanced-config (KV q8_0, cache-ram
 * host-only), gguf-metadata (YaRN orig context used at spawn).
 */
import { describe, expect, test } from "bun:test";
import {
  buildLlamaSpawnArgs,
  parseListeningPort,
  checkLlamaVersionFloor,
  assertSafeSpawnArg,
  Q8_0_BYTES_PER_ELEMENT,
  type LlamaSpawnArgsInput,
} from "./spawn-args.js";

const SHELL_METACHARS = [";", "&", "|", "<", ">", "$", "`", '"', "'", "\\", "\n", "\t"];

describe("buildLlamaSpawnArgs — single-model spawn flags", () => {
  test("spawns one llama-server with --port 0 and loopback host", () => {
    const args = buildLlamaSpawnArgs({ modelPath: "/m/models/q4.gguf" });
    expect(args).toContain("--port");
    expect(args[args.indexOf("--port") + 1]).toBe("0");
    expect(args).toContain("--host");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
  });

  test("per-model flags: ctx 8192 + q8_0 KV cache (backend-management scenario)", () => {
    const args = buildLlamaSpawnArgs({
      modelPath: "/m/models/q4.gguf",
      ctxSize: 8192,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
    });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("/m/models/q4.gguf");
    expect(args).toContain("--ctx-size");
    expect(args[args.indexOf("--ctx-size") + 1]).toBe("8192");
    expect(args).toContain("--cache-type-k");
    expect(args[args.indexOf("--cache-type-k") + 1]).toBe("q8_0");
    expect(args).toContain("--cache-type-v");
    expect(args[args.indexOf("--cache-type-v") + 1]).toBe("q8_0");
  });

  test("YaRN flags at spawn: 32K→128K yields --ctx-size 131072 --rope-scaling yarn", () => {
    const args = buildLlamaSpawnArgs({
      modelPath: "/m/models/q4.gguf",
      ctxSize: 131072,
      rope: { scale: 4, origCtx: 32768 },
    });
    expect(args).toContain("--ctx-size");
    expect(args[args.indexOf("--ctx-size") + 1]).toBe("131072");
    expect(args).toContain("--rope-scaling");
    expect(args[args.indexOf("--rope-scaling") + 1]).toBe("yarn");
    expect(args).toContain("--rope-scale");
    expect(args[args.indexOf("--rope-scale") + 1]).toBe("4");
    expect(args).toContain("--yarn-orig-ctx");
    expect(args[args.indexOf("--yarn-orig-ctx") + 1]).toBe("32768");
  });

  test("cache-ram caps the host prompt cache only — KV args are present and unchanged", () => {
    const base: LlamaSpawnArgsInput = {
      modelPath: "/m/models/q4.gguf",
      ctxSize: 8192,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      cacheRam: 2048,
    };
    const args = buildLlamaSpawnArgs(base);
    expect(args).toContain("--cache-ram");
    expect(args[args.indexOf("--cache-ram") + 1]).toBe("2048");
    // cache-ram must never suppress or re-order the KV quant args
    expect(args).toContain("--cache-type-k");
    expect(args).toContain("--cache-type-v");
  });

  test("optional offload/sampler-side flags: n-cache-gpu, ngl, flash-attn", () => {
    const args = buildLlamaSpawnArgs({
      modelPath: "/m/models/q4.gguf",
      nCacheGpu: 4,
      ngl: 99,
      flashAttn: true,
    });
    expect(args).toContain("--n-cache-gpu");
    expect(args).toContain("--ngl");
    expect(args).toContain("-fa");
    expect(args[args.indexOf("-fa") + 1]).toBe("on");
  });

  test("q8_0 KV sizing constant is 1.0625 bytes/element", () => {
    expect(Q8_0_BYTES_PER_ELEMENT).toBe(1.0625);
  });
});

describe("buildLlamaSpawnArgs — embeddings mode (embeddings-rag)", () => {
  test("embeddings: true pushes --embeddings immediately after the --model pair", () => {
    const args = buildLlamaSpawnArgs({ modelPath: "/m/models/q4.gguf", embeddings: true });
    expect(args).toContain("--embeddings");
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("/m/models/q4.gguf");
    expect(args[modelIdx + 2]).toBe("--embeddings");
  });

  test("embeddings omitted → the flag is absent", () => {
    const args = buildLlamaSpawnArgs({ modelPath: "/m/models/q4.gguf" });
    expect(args).not.toContain("--embeddings");
  });

  test("embeddings: false → the flag is absent", () => {
    const args = buildLlamaSpawnArgs({ modelPath: "/m/models/q4.gguf", embeddings: false });
    expect(args).not.toContain("--embeddings");
  });

  test("existing flags stay in order with the embeddings field set (full argv pinned)", () => {
    const args = buildLlamaSpawnArgs({
      modelPath: "/m/models/q4.gguf",
      ctxSize: 8192,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      embeddings: true,
    });
    expect(args).toEqual([
      "--model",
      "/m/models/q4.gguf",
      "--embeddings",
      "--ctx-size",
      "8192",
      "--cache-type-k",
      "q8_0",
      "--cache-type-v",
      "q8_0",
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ]);
  });
});

describe("assertSafeSpawnArg — shell metachar denial (threat matrix)", () => {
  test("every shell metacharacter in a value is rejected with a clear error", () => {
    for (const ch of SHELL_METACHARS) {
      expect(() => assertSafeSpawnArg(`/m/models/q4${ch}evil.gguf`)).toThrow(
        /metacharacter|rejected/i,
      );
    }
  });

  test("safe values pass, including spaces (paths on macOS Application Support)", () => {
    expect(() =>
      assertSafeSpawnArg("/Users/x/Library/Application Support/weavellm/models/q4.gguf"),
    ).not.toThrow();
    expect(() => assertSafeSpawnArg("q8_0")).not.toThrow();
  });
});

describe("parseListeningPort — --port 0 detection from stdout", () => {
  test("extracts the bound port from llama-server stdout", () => {
    expect(parseListeningPort("llama-server: listening on 127.0.0.1:54321")).toBe(54321);
    expect(parseListeningPort("llama-server: listening on http://127.0.0.1:12345")).toBe(12345);
    expect(parseListeningPort("llama-server: listening on [::1]:8080")).toBe(8080);
  });

  test("returns null for garbage or unrelated lines", () => {
    expect(parseListeningPort("loading model...")).toBeNull();
    expect(parseListeningPort("")).toBeNull();
  });
});

describe("checkLlamaVersionFloor — b9908+ gate", () => {
  test("older builds fail fast with an actionable upgrade message", () => {
    expect(() => checkLlamaVersionFloor("llama.cpp version: b4140 (abc123)")).toThrow(
      /b9908|upgrade|update/i,
    );
  });

  test("b9908 and newer pass; returns the normalized build tag", () => {
    expect(checkLlamaVersionFloor("llama.cpp version: b9908 (x)")).toBe("b9908");
    expect(checkLlamaVersionFloor("build: b12345 (x)")).toBe("b12345");
  });

  test("unparseable version output fails the gate (cannot prove the floor)", () => {
    expect(() => checkLlamaVersionFloor("llama-server 1.2.3")).toThrow(
      /unable to determine|version/i,
    );
  });
});