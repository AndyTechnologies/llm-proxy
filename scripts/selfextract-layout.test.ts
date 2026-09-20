import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  RENDER_ENV_NAME,
  TRAILER_FORMAT_VERSION,
  TRAILER_HASH_LEN,
  TRAILER_LEN,
  TRAILER_MAGIC,
  TRAILER_MAGIC_LEN,
  TRAILER_SIZE_LEN,
  TRAILER_VERSION_LEN,
  buildTrailer,
  extractCacheDir,
  parseTrailer,
  payloadSha256Hex,
  renderTrailerHeader,
  resolveCacheBase,
  withRenderEnv,
} from "../scripts/selfextract-layout.js";

const PAYLOAD = Buffer.from("fake tar.gz bytes for tests");

describe("trailer layout (single source of truth for the appended payload)", () => {
  test("trailer length is magic + version + size + sha256 hex", () => {
    expect(TRAILER_MAGIC_LEN).toBe(Buffer.byteLength(TRAILER_MAGIC, "ascii"));
    expect(TRAILER_MAGIC).toBe("WEAVELLM");
    expect(TRAILER_LEN).toBe(
      TRAILER_MAGIC_LEN + TRAILER_VERSION_LEN + TRAILER_SIZE_LEN + TRAILER_HASH_LEN,
    );
    expect(TRAILER_LEN).toBe(8 + 1 + 8 + 64);
  });

  test("buildTrailer emits magic, version byte, LE size and sha256 hex", () => {
    const trailer = buildTrailer(PAYLOAD);
    expect(trailer.length).toBe(TRAILER_LEN);
    expect(trailer.subarray(0, TRAILER_MAGIC_LEN).toString("ascii")).toBe(
      TRAILER_MAGIC,
    );
    expect(trailer[TRAILER_MAGIC_LEN]).toBe(TRAILER_FORMAT_VERSION);
    expect(trailer.readBigUInt64LE(TRAILER_MAGIC_LEN + TRAILER_VERSION_LEN)).toBe(
      BigInt(PAYLOAD.length),
    );
    expect(
      trailer
        .subarray(TRAILER_MAGIC_LEN + TRAILER_VERSION_LEN + TRAILER_SIZE_LEN)
        .toString("ascii"),
    ).toBe(payloadSha256Hex(PAYLOAD));
  });

  test("parseTrailer round-trips the payload size and hash", () => {
    const parsed = parseTrailer(buildTrailer(PAYLOAD));
    expect(parsed).toEqual({
      payloadSize: PAYLOAD.length,
      sha256: payloadSha256Hex(PAYLOAD),
    });
  });

  test("parseTrailer rejects a bad magic", () => {
    const trailer = buildTrailer(PAYLOAD);
    trailer[0] = 0x58; // "X"
    expect(parseTrailer(trailer)).toBeNull();
  });

  test("parseTrailer rejects a mismatched format version", () => {
    const trailer = buildTrailer(PAYLOAD);
    trailer[TRAILER_MAGIC_LEN] = TRAILER_FORMAT_VERSION + 1;
    expect(parseTrailer(trailer)).toBeNull();
  });

  test("parseTrailer rejects a truncated trailer", () => {
    expect(parseTrailer(buildTrailer(PAYLOAD).subarray(0, TRAILER_LEN - 1))).toBeNull();
  });

  test("renderTrailerHeader emits #defines matching the TS constants", () => {
    const header = renderTrailerHeader();
    expect(header).toContain(`#define WEAVELLM_TRAILER_MAGIC "${TRAILER_MAGIC}"`);
    expect(header).toContain(`#define WEAVELLM_TRAILER_MAGIC_LEN ${TRAILER_MAGIC_LEN}`);
    expect(header).toContain(`#define WEAVELLM_TRAILER_VERSION ${TRAILER_FORMAT_VERSION}`);
    expect(header).toContain(`#define WEAVELLM_TRAILER_VERSION_LEN ${TRAILER_VERSION_LEN}`);
    expect(header).toContain(`#define WEAVELLM_TRAILER_SIZE_LEN ${TRAILER_SIZE_LEN}`);
    expect(header).toContain(`#define WEAVELLM_TRAILER_HASH_LEN ${TRAILER_HASH_LEN}`);
    expect(header).toContain(`#define WEAVELLM_TRAILER_LEN ${TRAILER_LEN}`);
  });

  test("renderTrailerHeader is idempotent", () => {
    expect(renderTrailerHeader()).toBe(renderTrailerHeader());
  });
});

describe("cache base resolution (mirrors the C stub)", () => {
  test("XDG_CACHE_HOME wins when set and non-empty", () => {
    expect(resolveCacheBase("/custom/cache", "/home/user")).toBe("/custom/cache");
  });

  test("an empty XDG_CACHE_HOME falls back to ~/.cache", () => {
    expect(resolveCacheBase("", "/home/user")).toBe(join("/home/user", ".cache"));
  });

  test("missing XDG_CACHE_HOME uses ~/.cache", () => {
    expect(resolveCacheBase(undefined, "/home/user")).toBe(
      join("/home/user", ".cache"),
    );
  });

  test("missing HOME fails loudly", () => {
    expect(() => resolveCacheBase(undefined, undefined)).toThrow(/HOME|XDG_CACHE_HOME/);
  });
});

describe("extraction cache dir", () => {
  test("is <base>/weavellm/<payload sha256>", () => {
    const base = resolveCacheBase(undefined, "/home/user");
    expect(extractCacheDir(base, payloadSha256Hex(PAYLOAD))).toBe(
      join("/home/user", ".cache", "weavellm", payloadSha256Hex(PAYLOAD)),
    );
  });
});

describe("render env merge (mirrors the C stub)", () => {
  test("adds WEBKIT_DISABLE_DMABUF_RENDERER=1 when absent", () => {
    expect(withRenderEnv({ PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      [RENDER_ENV_NAME]: "1",
    });
  });

  test("an explicit override wins, even when empty", () => {
    expect(withRenderEnv({ [RENDER_ENV_NAME]: "0" })[RENDER_ENV_NAME]).toBe("0");
    expect(withRenderEnv({ [RENDER_ENV_NAME]: "" })[RENDER_ENV_NAME]).toBe("");
  });

  test("undefined values are dropped", () => {
    const merged = withRenderEnv({ PATH: "/usr/bin", MAYBE: undefined });
    expect("MAYBE" in merged).toBe(false);
    expect(merged).toEqual({ PATH: "/usr/bin", [RENDER_ENV_NAME]: "1" });
  });
});