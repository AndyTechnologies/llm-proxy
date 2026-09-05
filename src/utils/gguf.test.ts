/**
 * GGUF header parser + per-model context computation tests.
 *
 * Covers: valid parse, magic rejection, corrupt header, missing context_length,
 * unreadable file, architecture extraction, large-file performance,
 * hardwareMaxCtx (VRAM budget) with injected memory getters, name-based native
 * context defaults, and effectiveCtx clamping/sanitization.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  parseGgufHeader,
  hardwareMaxCtx,
  effectiveCtx,
  contextLengthByName,
  MIN_EFFECTIVE_CTX,
  MAX_EFFECTIVE_CTX,
  DEFAULT_EFFECTIVE_CTX,
  type GgufParseResult,
} from "./gguf.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// ── Test fixtures ──────────────────────────────────────────────────────

const FIXTURE_DIR = join(import.meta.dir, "__gguf_fixtures__");

/**
 * Realistic GGUF header fixture, mirroring what llama.cpp/gguf-py writers
 * emit: file-level `general.*` keys first, then `{arch}.*` architecture keys
 * (context_length is NEVER a `general.*` key), an f32 to force value skipping,
 * an ARRAY to force recursive skipping, and `general.file_type` near the end.
 *
 * Format (little-endian, per GGUF spec / gguf-py constants.py):
 *   0x00  uint32  magic  ("GGUF" ascii → LE u32 0x46554747)
 *   0x04  uint32  version
 *   0x08  uint64  tensor_count
 *   0x10  uint64  metadata_kv_count
 *   0x18  ...     metadata KV pairs:
 *                   uint64 key_length | key bytes | uint32 type_tag | value
 */
const TAG = { U32: 4, F32: 6, STR: 8, ARRAY: 9 } as const;

function u64(out: number[], v: number): void {
  const b = BigInt(v);
  for (let i = 0; i < 8; i++) out.push(Number((b >> BigInt(i * 8)) & 0xffn));
}
function u32(out: number[], v: number): void {
  out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
}
function f32(out: number[], v: number): void {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(v, 0);
  for (const byte of buf) out.push(byte);
}
function str(out: number[], v: string): void {
  const bytes = Buffer.from(v, "utf-8");
  u64(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}
function kvString(out: number[], key: string, value: string): void {
  u64(out, key.length);
  for (const byte of Buffer.from(key, "utf-8")) out.push(byte);
  u32(out, TAG.STR);
  str(out, value);
}
function kvU32(out: number[], key: string, value: number): void {
  u64(out, key.length);
  for (const byte of Buffer.from(key, "utf-8")) out.push(byte);
  u32(out, TAG.U32);
  u32(out, value);
}
function kvF32(out: number[], key: string, value: number): void {
  u64(out, key.length);
  for (const byte of Buffer.from(key, "utf-8")) out.push(byte);
  u32(out, TAG.F32);
  f32(out, value);
}
/** ARRAY of u32, e.g. a head_count_kv as written by tensor-parallel exports. */
function kvU32Array(out: number[], key: string, values: number[]): void {
  u64(out, key.length);
  for (const byte of Buffer.from(key, "utf-8")) out.push(byte);
  u32(out, TAG.ARRAY);
  u32(out, TAG.U32);
  u64(out, values.length);
  for (const v of values) u32(out, v);
}
/** ARRAY of STRING, e.g. a tokenizer vocab sitting BEFORE the arch block. */
function kvStringArray(out: number[], key: string, values: string[]): void {
  u64(out, key.length);
  for (const byte of Buffer.from(key, "utf-8")) out.push(byte);
  u32(out, TAG.ARRAY);
  u32(out, TAG.STR);
  u64(out, values.length);
  for (const v of values) str(out, v);
}

function buildRealisticGguf(opts: {
  architecture?: string;
  contextLength?: number;
  blockCount?: number;
  headCountKv?: number;
  headCountKvArray?: number[];
  fileType?: number;
  /** Extra keys inserted BEFORE the arch block (forces skipping). */
  preArch?: Array<{ key: string; tag: number; value: unknown }>;
} = {}): Buffer {
  const arch = opts.architecture ?? "llama";
  const contextLength = opts.contextLength ?? 32768;
  const blockCount = opts.blockCount ?? 28;
  const headCountKv = opts.headCountKv ?? 8;
  const fileType = opts.fileType ?? 15;

  const body: number[] = [];
  [["general.architecture", arch],
   ["general.type", "model"],
   ["general.name", "FixtureModel"],
  ].forEach(([k, v]) => kvString(body, k, v as string));

  for (const extra of opts.preArch ?? []) {
    if (extra.tag === TAG.STR) kvString(body, extra.key, String(extra.value));
    else if (extra.tag === TAG.U32) kvU32(body, extra.key, Number(extra.value));
    else if (extra.tag === TAG.F32) kvF32(body, extra.key, Number(extra.value));
    else if (extra.tag === TAG.ARRAY && Array.isArray(extra.value) &&
      typeof extra.value[0] === "number") {
      kvU32Array(body, extra.key, extra.value as number[]);
    } else if (extra.tag === TAG.ARRAY) {
      kvStringArray(body, extra.key, extra.value as string[]);
    }
  }

  kvU32(body, `${arch}.block_count`, blockCount);
  kvU32(body, `${arch}.context_length`, contextLength);
  kvU32(body, `${arch}.embedding_length`, 1024);
  kvU32(body, `${arch}.attention.head_count`, 8);
  if (opts.headCountKvArray !== undefined) {
    kvU32Array(body, `${arch}.attention.head_count_kv`, opts.headCountKvArray);
  } else {
    kvU32(body, `${arch}.attention.head_count_kv`, headCountKv);
  }
  kvF32(body, `${arch}.rope.freq_base`, 10000.5); // f32 — forces value skipping
  kvU32(body, `general.tags_count`, 1);
  kvStringArray(body, "general.tags", ["small"]); // array of strings to skip
  kvU32(body, "general.file_type", fileType);

  // Base keys: arch/type/name strings (3) + block/ctx/emb/head/kv u32 (5) +
  // rope.f32 + tags_count + tags array + file_type = 12, plus extras.
  const kvCount = 12 + (opts.preArch?.length ?? 0);
  const header = [0x47, 0x47, 0x55, 0x46]; // "GGUF" ascii — the real magic bytes
  u32(header, 3); // version
  u64(header, 0); // tensor count
  u64(header, kvCount);

  return Buffer.from([...header, ...body]);
}

function writeFixture(name: string, data: Buffer): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const filePath = join(FIXTURE_DIR, name);
  writeFileSync(filePath, data);
  return filePath;
}

beforeEach(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// ── parseGgufHeader tests ──────────────────────────────────────────────

describe("parseGgufHeader", () => {
  test("parses a realistic GGUF: {arch}.* keys, f32, string arrays, file_type", async () => {
    const filePath = writeFixture(
      "realistic.gguf",
      buildRealisticGguf({
        architecture: "qwen2",
        contextLength: 32768,
        blockCount: 36,
        headCountKv: 2,
        fileType: 15,
      }),
    );

    const result: GgufParseResult = await parseGgufHeader(filePath);
    expect(result.parsed).toBe(true);
    expect(result.architecture).toBe("qwen2");
    expect(result.ggufContextLength).toBe(32768);
    expect(result.blockCount).toBe(36);
    expect(result.headCountKv).toBe(2);
    expect(result.fileType).toBe(15); // Q4_K_M
  });

  test("ignores general.context_length — the real spec uses {arch}.context_length", async () => {
    // Regression for the original bug: the parser matched a key that real
    // GGUF exports never write, so it read 0 of 6 files in /home/andy/Models.
    const filePath = writeFixture(
      "wrong-key.gguf",
      buildRealisticGguf({
        preArch: [{ key: "general.context_length", tag: TAG.U32, value: 999 }],
        contextLength: 65536,
      }),
    );
    const result: GgufParseResult = await parseGgufHeader(filePath);
    expect(result.parsed).toBe(true);
    expect(result.architecture).toBe("llama");
    expect(result.ggufContextLength).toBe(65536); // the {arch} key won
    expect(result.ggufContextLength).not.toBe(999);
  });

  test("reads head_count_kv from an ARRAY (tensor-parallel exports)", async () => {
    // IBM-Grok/granite exports write head_count_kv as a per-rank array; the
    // parser must read the first element, not skip/drop the key.
    const filePath = writeFixture(
      "array-kv.gguf",
      buildRealisticGguf({ architecture: "granite", headCountKvArray: [4, 4] }),
    );
    const result: GgufParseResult = await parseGgufHeader(filePath);
    expect(result.parsed).toBe(true);
    expect(result.architecture).toBe("granite");
    expect(result.headCountKv).toBe(4);
  });

  test("returns parsed:false + nulls for a non-GGUF file (magic mismatch)", async () => {
    const filePath = writeFixture("not-gguf.bin", Buffer.alloc(64, 0xff));
    const result: GgufParseResult = await parseGgufHeader(filePath);
    expect(result.parsed).toBe(false);
    expect(result.ggufContextLength).toBeNull();
    expect(result.architecture).toBeNull();
    expect(result.blockCount).toBeNull();
    expect(result.headCountKv).toBeNull();
    expect(result.fileType).toBeNull();
  });

  test("returns parsed:false for a truncated header (valid magic, < 24 bytes)", async () => {
    const buf = Buffer.alloc(12);
    buf.writeUInt32LE(0x46554747, 0); // the REAL magic
    const filePath = writeFixture("truncated.gguf", buf);
    const result: GgufParseResult = await parseGgufHeader(filePath);
    expect(result.parsed).toBe(false);
    expect(result.architecture).toBeNull();
    expect(result.ggufContextLength).toBeNull();
  });

  test("keeps partial fields when the KV sweep hits a clipped value", async () => {
    // Keys before the clip survive; parsed stays true (magic was valid).
    const good = buildRealisticGguf({ contextLength: 32768 });
    const clipped = Buffer.from(good.subarray(0, good.length - 5)); // cuts file_type
    const filePath = writeFixture("clipped.gguf", clipped);
    const result: GgufParseResult = await parseGgufHeader(filePath);
    expect(result.parsed).toBe(true);
    expect(result.ggufContextLength).toBe(32768);
    expect(result.blockCount).toBe(28);
    expect(result.fileType).toBeNull(); // swept past, clip hit later
  });

  test("returns nulls (parsed:false) for an unreadable file path", async () => {
    const result: GgufParseResult = await parseGgufHeader("/nonexistent/path/model.gguf");
    expect(result.parsed).toBe(false);
    expect(result.ggufContextLength).toBeNull();
    expect(result.architecture).toBeNull();
  });

  test("handles zero KV pairs gracefully", async () => {
    const out: number[] = [0x47, 0x47, 0x55, 0x46];
    u32(out, 3);
    u64(out, 0);
    u64(out, 0);
    const filePath = writeFixture("empty-kv.gguf", Buffer.from(out));
    const result: GgufParseResult = await parseGgufHeader(filePath);
    expect(result.parsed).toBe(true);
    expect(result.ggufContextLength).toBeNull();
    expect(result.architecture).toBeNull();
  });

  test("parses a large file (simulated multi-GB) in under 10ms", async () => {
    // Realistic header + 10MB of zeros — verifies the parse reads a WINDOW
    // (Bun.file().slice) instead of loading the whole file into memory.
    const header = buildRealisticGguf({ contextLength: 32768, architecture: "llama" });
    const padding = Buffer.alloc(10 * 1024 * 1024, 0);
    const filePath = writeFixture("large.gguf", Buffer.concat([header, padding]));

    const start = performance.now();
    const result = await parseGgufHeader(filePath);
    const elapsed = performance.now() - start;

    expect(result.ggufContextLength).toBe(32768);
    expect(result.architecture).toBe("llama");
    expect(elapsed).toBeLessThan(10);
  });

  test("integration: reads the REAL models in /home/andy/Models (skipped when absent)", async () => {
    // Every real export must parse with concrete {arch}.* metadata — this is
    // the regression guard for the magic + key bugs that read 0/6 files.
    // The file list is resolved lazily here (at run time) so adding models to
    // the folder automatically extends coverage.
    const { existsSync, readdirSync } = await import("node:fs");
    const dir = "/home/andy/Models";
    if (!existsSync(dir)) return; // dev-machine-only test — silently no-op
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".gguf"));
    if (files.length === 0) return;
    for (const file of files) {
      const result = await parseGgufHeader(`${dir}/${file}`);
      expect(result.parsed, file).toBe(true);
      expect(result.architecture, file).not.toBeNull();
      expect(result.ggufContextLength, file).not.toBeNull();
      expect(result.ggufContextLength!, file).toBeGreaterThan(0);
      expect(result.blockCount, file).not.toBeNull();
      expect(result.headCountKv, file).not.toBeNull();
      // file_type often sits past the 256KB window (huge tokenizer vocabs) —
      // it may be null without failing the structural parse.
    }
  });
});

// ── hardwareMaxCtx tests ───────────────────────────────────────────────

describe("hardwareMaxCtx", () => {
  test("computes a power-of-two KV budget from VRAM minus weights", () => {
    // 6 GiB VRAM, ~2 GiB model file → budget ≈ 3.8 GiB / 65536 ≈ 61k → 32768
    const vram = 6 * 1024 * 1024 * 1024; // 6 GiB
    const modelBytes = Math.round(2.1 * 1024 * 1024 * 1024); // ~2.1 GiB
    const result = hardwareMaxCtx({ vramBytes: vram, modelBytes });
    expect(result).toBe(32768);
    expect(result).toBe(Math.pow(2, Math.floor(Math.log2(result))));
  });

  test("returns DEFAULT_EFFECTIVE_CTX when the model does not fit in VRAM", () => {
    const vram = 6 * 1024 * 1024 * 1024;
    const modelBytes = 10 * 1024 * 1024 * 1024; // bigger than VRAM
    expect(hardwareMaxCtx({ vramBytes: vram, modelBytes })).toBe(
      DEFAULT_EFFECTIVE_CTX,
    );
  });

  test("returns DEFAULT_EFFECTIVE_CTX when VRAM detection fails entirely", () => {
    const noVram = () => undefined;
    const noMem = () => 0;
    expect(hardwareMaxCtx({ getVramBytes: noVram, getTotalMem: noMem })).toBe(
      DEFAULT_EFFECTIVE_CTX,
    );
    expect(
      hardwareMaxCtx({ modelBytes: 0, getVramBytes: noVram, getTotalMem: noMem }),
    ).toBe(DEFAULT_EFFECTIVE_CTX);
  });

  test("uses the RAM proxy when no VRAM detector is available", () => {
    // 32 GiB RAM → proxy 16 GiB, zero weights → /65536 ≈ 235k → capped at MAX
    const result = hardwareMaxCtx({
      modelBytes: 0,
      getVramBytes: () => undefined,
      getTotalMem: () => 34359738368, // 32 GiB
    });
    expect(result).toBe(MAX_EFFECTIVE_CTX); // 131072
  });

  test("respects a custom kvBytesPerToken heuristic", () => {
    // Smaller bytes/token → larger context on the same VRAM.
    const vram = 6 * 1024 * 1024 * 1024;
    const modelBytes = 0;
    const coarse = hardwareMaxCtx({ vramBytes: vram, modelBytes });
    const fine = hardwareMaxCtx({
      vramBytes: vram,
      modelBytes,
      kvBytesPerToken: 32768,
    });
    expect(fine).toBeGreaterThanOrEqual(coarse);
  });

  test("always returns a power-of-two within bounds for various VRAM sizes", () => {
    const vrams = [4_294_967_296, 8_589_934_592, 34_359_738_368]; // 4-32 GiB
    for (const vram of vrams) {
      const result = hardwareMaxCtx({ vramBytes: vram, modelBytes: 0 });
      expect(result).toBe(Math.pow(2, Math.floor(Math.log2(result))));
      expect(result).toBeGreaterThanOrEqual(MIN_EFFECTIVE_CTX);
      expect(result).toBeLessThanOrEqual(MAX_EFFECTIVE_CTX);
    }
  });

  test("sanitizes modelBytes (negative/NaN/absent → 0)", () => {
    const vram = 6 * 1024 * 1024 * 1024;
    const clean = hardwareMaxCtx({ vramBytes: vram, modelBytes: 0 });
    expect(hardwareMaxCtx({ vramBytes: vram, modelBytes: -5 })).toBe(clean);
    expect(hardwareMaxCtx({ vramBytes: vram, modelBytes: NaN })).toBe(clean);
  });
});

// ── contextLengthByName tests ──────────────────────────────────────────

describe("contextLengthByName", () => {
  test("matches known models case-insensitively by substring", () => {
    // Values verified EMPIRICALLY against the real exports in /home/andy/Models:
    // SmolLM3-3B declares 65536 (the 8192 the HF card once claimed is wrong).
    expect(contextLengthByName("SmolLM3-3B-Q4_K_M.gguf")).toBe(65536);
    expect(contextLengthByName("Llama-3.2-3B-Instruct-Q4_K_M.gguf")).toBe(131072);
    expect(contextLengthByName("Llama3.2-3B-abliterated-Q8_0.gguf")).toBe(131072);
    expect(contextLengthByName("Qwen2.5-Coder-3B-Q4_K_M.gguf")).toBe(32768);
    expect(contextLengthByName("Phi-4-Mini-Instruct-Q4_K_M.gguf")).toBe(131072);
    expect(contextLengthByName("phi-4-mini-instruct-q8_0.gguf")).toBe(131072);
    expect(contextLengthByName("granite-4.2-3b-Q4_K_M.gguf")).toBe(131072);
    expect(contextLengthByName("IBM-Grok4-Ultra.Fast.Coder-1B-Q5_K_M.gguf")).toBe(131072);
  });

  test("returns null for unknown or empty names", () => {
    expect(contextLengthByName("mystery-7b.gguf")).toBeNull();
    expect(contextLengthByName("")).toBeNull();
  });
});

// ── effectiveCtx tests ─────────────────────────────────────────────────

describe("effectiveCtx", () => {
  test("clamps to the minimum of user, native, and hardware signals", () => {
    expect(
      effectiveCtx({ userCtx: 65536, ggufContextLength: 131072, hardwareMaxCtx: 32768 }),
    ).toBe(32768);
    expect(
      effectiveCtx({ userCtx: 1024, ggufContextLength: 131072, hardwareMaxCtx: 32768 }),
    ).toBe(1024);
  });

  test("falls back to the name map when the GGUF signal is absent", () => {
    expect(effectiveCtx({ name: "SmolLM3-3B-Q4_K_M.gguf", hardwareMaxCtx: 32768 })).toBe(32768);
    expect(effectiveCtx({ name: "Llama-3.2-3B-Instruct-Q4_K_M.gguf", hardwareMaxCtx: 32768 })).toBe(32768);
    expect(effectiveCtx({ name: "Qwen2.5-Coder-3B-Q4_K_M.gguf", hardwareMaxCtx: 65536 })).toBe(32768);
    expect(effectiveCtx({ name: "granite-4.2-3b-Q4_K_M.gguf", hardwareMaxCtx: 131072 })).toBe(131072);
  });

  test("never lets the name map override a parsed file or a valid userCtx", () => {
    const hw = 131072;
    // File parsed OK but no context_length key: ggufParsed=true → name map
    // must NOT stand in (the parsed metadata is authoritative).
    expect(
      effectiveCtx({ name: "SmolLM3-3B-Q4_K_M.gguf", ggufParsed: true, hardwareMaxCtx: hw }),
    ).toBe(hw);
    // Explicit user ctx always wins over the name guess.
    expect(
      effectiveCtx({ name: "SmolLM3-3B-Q4_K_M.gguf", userCtx: 16384, hardwareMaxCtx: hw }),
    ).toBe(16384);
    expect(
      effectiveCtx({ name: "mystery-7b.gguf", userCtx: 8192, hardwareMaxCtx: hw }),
    ).toBe(8192);
  });

  test("ignores invalid signals (negative, NaN, strings, 0)", () => {
    const hw = 32768;
    expect(effectiveCtx({ userCtx: -5, ggufContextLength: NaN, hardwareMaxCtx: hw })).toBe(hw);
    expect(effectiveCtx({ userCtx: "8192", ggufContextLength: 0, hardwareMaxCtx: hw })).toBe(hw);
  });

  test("returns the clamped fallback when nothing is known", () => {
    expect(effectiveCtx({})).toBe(DEFAULT_EFFECTIVE_CTX);
    expect(effectiveCtx({ fallback: 2048 })).toBe(2048);
    expect(effectiveCtx({ fallback: 32 })).toBe(MIN_EFFECTIVE_CTX); // floored
  });

  test("sanitizes and enforces min/max bounds", () => {
    expect(effectiveCtx({ userCtx: 1_000_000, min: 512, max: 131072 })).toBe(131072);
    // Swapped bounds are coerced (lo/hi), not a crash.
    expect(effectiveCtx({ userCtx: 100, min: 131072, max: 512 })).toBe(512);
  });
});
