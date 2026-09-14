/**
 * GGUF binary header parser and per-model context computation.
 *
 * Parses GGUF model files to extract metadata (context_length, architecture),
 * derives a hardware-safe max context from VRAM (weights + KV-cache budget),
 * and combines the user config, the GGUF native window, and the hardware
 * ceiling into the EFFECTIVE context the gateway actually configures for each
 * model (written per preset section, not via a global `--ctx-size`).
 *
 * Uses Bun.file().slice() to read only the header bytes — avoids loading
 * multi-GB model files into memory. (RDD #26 — event-loop-blocking I/O.)
 */
import { totalmem } from "node:os";

/** Injectable system memory getter (for testability). */
export type TotalMemFn = () => number;

/** Result of parsing a GGUF file header. */
export interface GgufParseResult {
  /**
   * The `{arch}.context_length` metadata value (native window of the model),
   * or null when the file does not declare it or the parse failed. The arch
   * prefix is read from `general.architecture` — `general.context_length`
   * does NOT exist in the GGUF spec.
   */
  ggufContextLength: number | null;
  /** The `general.architecture` metadata value, or null if absent/parse failure. */
  architecture: string | null;
  /** `general.block_count`, or null when absent/parse failure. */
  blockCount: number | null;
  /** `{arch}.attention.head_count_kv`, or null when absent/parse failure. */
  headCountKv: number | null;
  /** `general.file_type` (GGML_QNT_VERSION enum), or null when beyond the read window. */
  fileType: number | null;
  /**
   * True when the file started with a valid GGUF magic and a full header was
   * swept (even if individual keys are missing). False on magic mismatch or
   * truncated header. Consumers use this to decide whether the name-based
   * fallback may stand in for file-read metadata.
   */
  parsed: boolean;
}

// ── Context constants ──────────────────────────────────────────────────

/** Hard floor for any effective context. */
export const MIN_EFFECTIVE_CTX = 512;
/**
 * Hard ceiling for any effective context. Empirically this card's VRAM math
 * tops out around 65536 tokens (6 GiB − 10% reserve, smallest ~1B model);
 * 131072 is only reachable via the RAM proxy or bigger GPUs — it stays as a
 * safety clamp, never as a ground-truth signal.
 */
export const MAX_EFFECTIVE_CTX = 131072;
/** Sane default when nothing is known about a model's real context. */
export const DEFAULT_EFFECTIVE_CTX = 8192;
/** KV-cache bytes per token (q8_0 cache, ~3B-class models). */
export const DEFAULT_KV_BYTES_PER_TOKEN = 65536;
/** VRAM fraction reserved for OS/other processes before the KV budget is computed. */
const VRAM_RESERVE_FRACTION = 0.1;
/** RAM proxy factor used when no VRAM detector is available. */
const RAM_VRAM_PROXY_FRACTION = 0.5;

// ── GGUF binary constants ──────────────────────────────────────────────

const GGUF_MAGIC = 0x46554747; // "GGUF" ascii, read as little-endian u32 (matches gguf-py/llama.cpp)
const GGUF_HEADER_SIZE = 24; // magic(4) + version(4) + tensor_count(8) + kv_count(8)
const GGUF_MAX_READ = 256 * 1024; // default read window — general/arch keys come first

/**
 * GGUFValueType tags per https://github.com/ggerganov/gguf (gguf-py
 * constants.py): scalar sizes are fixed; STRING is a u64 length + bytes;
 * ARRAY is a four-byte element-type tag + u64 count + count × element.
 */
const TAG_UINT8 = 0;
const TAG_INT8 = 1;
const TAG_UINT16 = 2;
const TAG_INT16 = 3;
const TAG_UINT32 = 4;
const TAG_INT32 = 5;
const TAG_FLOAT32 = 6;
const TAG_BOOL = 7;
const TAG_STRING = 8;
const TAG_ARRAY = 9;
const TAG_UINT64 = 10;
const TAG_INT64 = 11;
const TAG_FLOAT64 = 12;

// Known metadata keys. Architecture-level facts are ALWAYS namespaced by the
// model architecture (e.g. `phi3.context_length`, `llama.block_count`) — the
// `general.*` keys carry file-level facts only. Empirically confirmed against
// real exports (llama.cpp/gguf-py writers).
const KEY_ARCHITECTURE = "general.architecture";
const KEY_FILE_TYPE = "general.file_type";
const KEY_HEAD_COUNT_KV_GLOBAL = "attention.head_count_kv"; // legacy arch-less form

/**
 * Read a small integral metadata value. Some writers store shapes like
 * `head_count_kv` as an ARRAY (one entry per tensor-parallel rank, e.g.
 * `[16, 8]`); when the value is an integral array we report its FIRST element,
 * otherwise the scalar itself. Returns the value and the offset after the
 * whole value, or null when it cannot be read within the buffer.
 */
function readIntegralValue(
  view: DataView,
  offset: number,
  length: number,
  tag: number,
): { value: number | null; next: number } | null {
  const scalar = (size: number, read: () => number): { value: number | null; next: number } | null =>
    offset + size <= length ? { value: read(), next: offset + size } : null;
  switch (tag) {
    case TAG_UINT32:
      return scalar(4, () => view.getUint32(offset, true));
    case TAG_INT32:
      return scalar(4, () => view.getInt32(offset, true));
    case TAG_UINT64:
      return scalar(8, () => Number(view.getBigUint64(offset, true)));
    case TAG_INT64:
      return scalar(8, () => Number(view.getBigInt64(offset, true)));
    case TAG_ARRAY: {
      if (offset + 12 > length) return null;
      const elemTag = view.getUint32(offset, true);
      const count = Number(view.getBigUint64(offset + 4, true));
      const elemSize =
        elemTag === TAG_UINT8 || elemTag === TAG_INT8 || elemTag === TAG_BOOL ? 1 :
        elemTag === TAG_UINT16 || elemTag === TAG_INT16 ? 2 :
        elemTag === TAG_UINT32 || elemTag === TAG_INT32 || elemTag === TAG_FLOAT32 ? 4 :
        elemTag === TAG_UINT64 || elemTag === TAG_INT64 || elemTag === TAG_FLOAT64 ? 8 :
        null;
      if (elemSize === null) return null; // array of non-scalars — not ours
      const total = offset + 12 + elemSize * count;
      if (total > length) return null;
      const value =
        count > 0
          ? readIntegralValue(view, offset + 12, length, elemTag)?.value ?? null
          : null;
      return { value, next: total };
    }
    default:
      return null; // non-integral tag (f32/bool/string/…)
  }
}

// ── GGUF value reading / skipping ──────────────────────────────────────

/**
 * Skip one metadata value of the given tag, returning the offset just after
 * it, or -1 when the value would exceed the buffer (or the tag is unknown).
 * ARRAY elements are skipped recursively.
 */
function skipGgufValue(
  view: DataView,
  offset: number,
  length: number,
  tag: number,
): number {
  switch (tag) {
    case TAG_UINT8:
    case TAG_INT8:
    case TAG_BOOL:
      return offset + 1 <= length ? offset + 1 : -1;
    case TAG_UINT16:
    case TAG_INT16:
      return offset + 2 <= length ? offset + 2 : -1;
    case TAG_UINT32:
    case TAG_INT32:
    case TAG_FLOAT32:
      return offset + 4 <= length ? offset + 4 : -1;
    case TAG_UINT64:
    case TAG_INT64:
    case TAG_FLOAT64:
      return offset + 8 <= length ? offset + 8 : -1;
    case TAG_STRING: {
      if (offset + 8 > length) return -1;
      const strLen = Number(view.getBigUint64(offset, true));
      return offset + 8 + strLen <= length ? offset + 8 + strLen : -1;
    }
    case TAG_ARRAY: {
      if (offset + 12 > length) return -1;
      const elemTag = view.getUint32(offset, true);
      const count = Number(view.getBigUint64(offset + 4, true));
      let cursor = offset + 12;
      for (let i = 0; i < count; i++) {
        cursor = skipGgufValue(view, cursor, length, elemTag);
        if (cursor === -1) return -1;
      }
      return cursor;
    }
    default:
      return -1; // unknown tag — cannot determine its size
  }
}

// ── parseGgufHeader ────────────────────────────────────────────────────

/**
 * Parse the GGUF binary header from a file on disk.
 *
 * Reads only the first `maxBytes` via Bun.file().slice() (sub-millisecond on
 * multi-GB model files), validates the magic bytes (`GGUF` in LE), and scans
 * metadata KV pairs, recording:
 *
 *   - `general.architecture`             (STRING)  — enables `{arch}.*` keys
 *   - `{arch}.context_length`            (UINT32)  — native window
 *   - `general.block_count`              (UINT32)
 *   - `{arch}.attention.head_count_kv`   (UINT32)  (legacy: `attention.head_count_kv`)
 *   - `general.file_type`                (UINT32)
 *
 * Every GGUFValueType is either parsed or skipped by its exact byte layout
 * (ARRAYs recurse), so an f32 value or a huge vocab array never derails the
 * scan. Unknown tags stop the scan but do NOT invalidate what was read.
 *
 * NEVER throws — all errors are caught and returned as null fields with
 * `parsed: false`.
 */
export async function parseGgufHeader(
  filePath: string,
  maxBytes: number = GGUF_MAX_READ,
): Promise<GgufParseResult> {
  try {
    const file = Bun.file(filePath);
    const slice = new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());

    if (slice.length < GGUF_HEADER_SIZE) {
      return nullResult();
    }

    const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);

    // Validate magic
    if (view.getUint32(0, true) !== GGUF_MAGIC) {
      return nullResult();
    }

    // Read metadata KV count at offset 16 (uint64 LE)
    const kvCount = Number(view.getBigUint64(16, true));

    // Scan metadata KV pairs starting at offset 24
    let offset = GGUF_HEADER_SIZE;
    let architecture: string | null = null;
    let ggufContextLength: number | null = null;
    let blockCount: number | null = null;
    let headCountKv: number | null = null;
    let fileType: number | null = null;

    for (let i = 0; i < kvCount; i++) {
      if (offset + 8 > slice.length) break; // key length header clipped

      const keyLen = Number(view.getBigUint64(offset, true));
      offset += 8;
      if (offset + keyLen + 4 > slice.length) break;
      const key = decodeUtf8(slice, offset, keyLen);
      offset += keyLen;

      const typeTag = view.getUint32(offset, true);
      const valueOffset = offset + 4;

      // ── STRING values → architecture (needed to recognize {arch}.* keys) ──
      if (typeTag === TAG_STRING && key === KEY_ARCHITECTURE) {
        if (valueOffset + 8 > slice.length) break;
        const strLen = Number(view.getBigUint64(valueOffset, true));
        offset = valueOffset + 8;
        if (offset + strLen > slice.length) break;
        architecture = decodeUtf8(slice, offset, strLen);
        offset += strLen;
        continue;
      }

      // ── Matched keys — integral scalar OR integral array (first element) ──
      if (architecture !== null) {
        const ctxKey = `${architecture}.context_length`;
        const headKey = `${architecture}.attention.head_count_kv`;
        const blockKey = `${architecture}.block_count`;
        const isArchKey =
          key === ctxKey || key === headKey || key === blockKey ||
          key === KEY_HEAD_COUNT_KV_GLOBAL;
        if (isArchKey) {
          const read = readIntegralValue(view, valueOffset, slice.length, typeTag);
          if (read === null) break; // clipped
          offset = read.next;
          if (key === ctxKey && ggufContextLength === null) {
            ggufContextLength = read.value;
          } else if (
            (key === headKey || key === KEY_HEAD_COUNT_KV_GLOBAL) &&
            headCountKv === null
          ) {
            headCountKv = read.value;
          } else if (key === blockKey && blockCount === null) {
            blockCount = read.value;
          }
          continue;
        }
      }
      if (key === KEY_FILE_TYPE && typeTag === TAG_UINT32 && fileType === null) {
        if (valueOffset + 4 > slice.length) break;
        fileType = view.getUint32(valueOffset, true);
        offset = valueOffset + 4;
        continue;
      }

      // ── Everything else: skip by exact layout (including ARRAYs) ──
      const next = skipGgufValue(view, valueOffset, slice.length, typeTag);
      if (next === -1) break; // clipped or unknown tag — keep what we have
      offset = next;

      // Early exit when every key we need is in hand.
      if (
        architecture !== null &&
        ggufContextLength !== null &&
        blockCount !== null &&
        headCountKv !== null &&
        fileType !== null
      ) {
        break;
      }
    }

    return {
      ggufContextLength,
      architecture,
      blockCount,
      headCountKv,
      fileType,
      parsed: true,
    };
  } catch {
    return nullResult();
  }
}

// ── hardwareMaxCtx ─────────────────────────────────────────────────────

export interface HardwareCtxInput {
  /** Model file size in bytes (the GGUF weights that must live in VRAM). */
  modelBytes?: number;
  /** Total VRAM bytes (injectable for tests). */
  vramBytes?: number;
  /** Fraction of VRAM reserved for OS/other (default 0.1). */
  reserveFraction?: number;
  /** Bytes per token heuristic for the KV cache (default 65536). */
  kvBytesPerToken?: number;
  /** Injectable VRAM getter (default: detectVramBytes). */
  getVramBytes?: () => number | undefined;
  /** Injectable total-memory getter for the RAM proxy fallback (default os.totalmem). */
  getTotalMem?: TotalMemFn;
}

/** Memoized VRAM probe result (nvidia-smi is queried at most once). */
let cachedVramBytes: number | undefined;
let vramProbed = false;

/**
 * Detect total VRAM in bytes via a single `nvidia-smi` subprocess (memoized).
 * Returns undefined on any failure — missing binary, no GPU, parse error.
 */
function detectVramBytes(): number | undefined {
  if (!vramProbed) {
    vramProbed = true;
    try {
      const res = Bun.spawnSync(
        ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const line = res.stdout?.toString().trim().split("\n")[0] ?? "";
      const miB = Number(line);
      if (Number.isFinite(miB) && miB > 0) {
        cachedVramBytes = miB * 1024 * 1024;
      }
    } catch {
      cachedVramBytes = undefined;
    }
  }
  return cachedVramBytes;
}

/** RAM-proxy VRAM estimate (half of system RAM) when no VRAM is detectable. */
function ramProxyVram(getTotalMem?: TotalMemFn): number | undefined {
  try {
    const mem = (getTotalMem ?? totalmem)();
    if (!Number.isFinite(mem) || mem <= 0) return undefined;
    return mem * RAM_VRAM_PROXY_FRACTION;
  } catch {
    return undefined;
  }
}

/**
 * Derive a hardware-safe maximum context for a model from VRAM.
 *
 * Budget = VRAM − reserve − weights (model file size); context = budget ÷
 * KV bytes/token, floored to a power of two and clamped to [MIN_EFFECTIVE_CTX,
 * MAX_EFFECTIVE_CTX]. When the model does not fit in VRAM (budget ≤ 0) or no
 * memory data is available at all, DEFAULT_EFFECTIVE_CTX is returned.
 *
 * NEVER throws.
 */
export function hardwareMaxCtx(input: HardwareCtxInput = {}): number {
  const modelBytes = positiveInt(input.modelBytes) ?? 0;
  const reserveFraction =
    positiveFraction(input.reserveFraction) ?? VRAM_RESERVE_FRACTION;
  const kvBytesPerToken =
    positiveInt(input.kvBytesPerToken) ?? DEFAULT_KV_BYTES_PER_TOKEN;

  const vramBytes =
    positiveInt(input.vramBytes) ??
    (input.getVramBytes ?? detectVramBytes)() ??
    ramProxyVram(input.getTotalMem);
  if (vramBytes === undefined) return DEFAULT_EFFECTIVE_CTX;

  const budget = vramBytes * (1 - reserveFraction) - modelBytes;
  if (budget <= 0) return DEFAULT_EFFECTIVE_CTX;

  const tokens = Math.floor(budget / kvBytesPerToken);
  return clamp(
    floorToPowerOfTwo(tokens),
    MIN_EFFECTIVE_CTX,
    MAX_EFFECTIVE_CTX,
  );
}

// ── Name-based native context defaults ─────────────────────────────────

/**
 * Proven native context lengths by model name, matched case-insensitively as
 * a substring over the model id/file. Values verified EMPIRICALLY against the
 * real files in /home/andy/Models (SmolLM3-3B → 65536, not the 8192 the HF
 * card used to claim; granite-family → 131072). The GGUF parse is the source
 * of truth when it succeeds; this map ONLY fills the gap for files whose
 * metadata is missing, renamed, or unreadable.
 */
const NATIVE_CTX_BY_NAME: ReadonlyArray<{ pattern: string; ctx: number }> = [
  { pattern: "phi-4-mini", ctx: 131072 },
  { pattern: "llama-3.2-3b", ctx: 131072 },
  { pattern: "llama3.2-3b", ctx: 131072 },
  { pattern: "qwen2.5-coder-3b", ctx: 32768 },
  { pattern: "smol", ctx: 65536 },
  { pattern: "granite", ctx: 131072 },
  // IBM-Grok exports report arch=granite (131072 native) — the NAME says
  // grok, so keep a fallback for it too (verified on the real file).
  { pattern: "grok", ctx: 131072 },
];

/** Look up the native context length by model name, or null when unknown. */
export function contextLengthByName(name: string): number | null {
  const normalized = name.toLowerCase();
  for (const { pattern, ctx } of NATIVE_CTX_BY_NAME) {
    if (normalized.includes(pattern)) return ctx;
  }
  return null;
}

// ── effectiveCtx ───────────────────────────────────────────────────────

export interface EffectiveCtxInput {
  /** Per-model config value (llama.models[<id>].ctx), when the user set one. */
  userCtx?: unknown;
  /** Native context length READ FROM THE FILE (`{arch}.context_length`). */
  ggufContextLength?: unknown;
  /**
   * True when the GGUF header parsed successfully (magic OK, KV swept) — even
   * if it does not declare a context length. When false/null/absent, a file
   * may or may not have been readable, so the name-based map may stand in.
   */
  ggufParsed?: unknown;
  /** Hardware ceiling from hardwareMaxCtx. */
  hardwareMaxCtx?: unknown;
  /** Model id and/or file name — powers the name-based fallback. */
  name?: string;
  /** Clamp bounds + fallback (defaults: 512 / 131072 / 8192). */
  min?: number;
  max?: number;
  fallback?: number;
}

/**
 * Resolve the EFFECTIVE context length for a model:
 *   clamp(min(user ctx, native ctx, hardware ctx), min, max)
 *
 * All signals are sanitized (positive finite numbers only — negatives, NaN,
 * and non-numbers are ignored). The name-based map is a LAST-RESORT stand-in
 * for a file that could not be parsed, and it NEVER reduces an explicit
 * user-configured ctx: it only participates when `ggufParsed` is falsy AND
 * `userCtx` is absent. A successfully parsed file that simply lacks a
 * context_length key contributes nothing (no guesses over real metadata).
 * When nothing is known the `fallback` (default 8192) is returned, clamped.
 */
export function effectiveCtx(input: EffectiveCtxInput = {}): number {
  const min = positiveInt(input.min) ?? MIN_EFFECTIVE_CTX;
  const max = positiveInt(input.max) ?? MAX_EFFECTIVE_CTX;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const fallback = positiveInt(input.fallback) ?? DEFAULT_EFFECTIVE_CTX;

  const userCtx = positiveInt(input.userCtx);
  const fileNative = positiveInt(input.ggufContextLength);
  const nameNative =
    userCtx === undefined && input.ggufParsed !== true
      ? contextLengthByName(input.name ?? "")
      : null;
  const known = [userCtx, fileNative, nameNative, positiveInt(input.hardwareMaxCtx)]
    .filter((v): v is number => v !== undefined && v !== null);

  if (known.length === 0) return clamp(fallback, lo, hi);
  return clamp(Math.min(...known), lo, hi);
}

// ── Internal helpers ───────────────────────────────────────────────────

function nullResult(): GgufParseResult {
  return {
    ggufContextLength: null,
    architecture: null,
    blockCount: null,
    headCountKv: null,
    fileType: null,
    parsed: false,
  };
}

function decodeUtf8(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(bytes.slice(offset, offset + length));
}

function floorToPowerOfTwo(n: number): number {
  if (n <= 0) return 1;
  let power = 1;
  while (power * 2 <= n) {
    power *= 2;
  }
  return power;
}

/** Sanitize a value into a positive integer, or undefined when invalid. */
function positiveInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
}

/** Sanitize a value into a fraction in (0, 1), or undefined when invalid. */
function positiveFraction(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 1) {
    return undefined;
  }
  return v;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

// ── YaRN original-context derivation + rope-scale guard (gguf-metadata) ──

/** Minimum accepted rope-scale ratio; any target below the original context is rejected. */
export const MIN_ROPE_SCALE = 1;

/**
 * The model's ORIGINAL (unscaled) context window for YaRN: the parsed
 * `{arch}.context_length` value (model-advanced-config). Null when the GGUF
 * does not declare it — no automatic YaRN can be applied then.
 */
export function yarnOrigCtx(
  parseResult: Pick<GgufParseResult, "ggufContextLength">,
): number | null {
  const raw = parseResult.ggufContextLength;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

/**
 * Rope-scale factor = target ÷ original. Rejects degenerate inputs and any
 * ratio below 1 (scaling DOWN is meaningless/unsupported — guard ≥ 1).
 */
export function yarnScale(origCtx: number, targetCtx: number): number {
  if (typeof origCtx !== "number" || !Number.isFinite(origCtx) || origCtx <= 0) {
    throw new RangeError("yarn_orig_ctx must be a positive integer");
  }
  if (typeof targetCtx !== "number" || !Number.isFinite(targetCtx) || targetCtx < 1) {
    throw new RangeError("target ctx must be a positive integer");
  }
  const scale = targetCtx / origCtx;
  if (scale < MIN_ROPE_SCALE) {
    throw new RangeError(
      `YaRN config rejected: rope scale ${scale.toFixed(3)} is below 1 ` +
        `(target ctx ${targetCtx} must be >= yarn_orig_ctx ${origCtx})`,
    );
  }
  return scale;
}

/**
 * Resolve automatic YaRN from GGUF metadata: derives yarn_orig_ctx and the
 * scale for the requested target ctx. Returns null when the GGUF has no
 * context_length (no YaRN, no guard). Throws when the scale would be < 1.
 */
export function resolveYaRN(
  parseResult: Pick<GgufParseResult, "ggufContextLength">,
  opts: { targetCtx: number },
): { origCtx: number; scale: number } | null {
  const origCtx = yarnOrigCtx(parseResult);
  if (origCtx === null) return null;
  return { origCtx, scale: yarnScale(origCtx, opts.targetCtx) };
}