/**
 * Phase 3 — gosh CLI integration (model-downloads): arg building for the
 * direct-mode transfer command, the REQUIRED `sha256:<hex>` checksum prefix
 * guard, and the tolerant `--output json` event parser.
 *
 * Verified against gosh-dl-cli v0.6.3+ (goshitsarch-eng/gosh-dl-cli):
 *   `gosh <url> -d <dir> -o <name> -x <N> --checksum sha256:<hex> --output json`
 * The bare-hex form fails silently upstream, so the prefix is validated here.
 */
import { describe, expect, test } from "bun:test";
import {
  assertChecksumPrefix,
  buildGoshTransferArgs,
  parseGoshEvent,
} from "./gosh.js";

const HEX64 = "ab".repeat(32);

describe("assertChecksumPrefix (RED: missing sha256: prefix errors)", () => {
  test("accepts and normalizes a sha256:<hex> prefix", () => {
    expect(assertChecksumPrefix(`sha256:${HEX64}`)).toBe(`sha256:${HEX64}`);
  });

  test("accepts uppercase hex and lowercases the canonical form", () => {
    expect(assertChecksumPrefix(`SHA256:${HEX64.toUpperCase()}`)).toBe(
      `sha256:${HEX64}`,
    );
  });

  test("rejects a bare hex checksum (no prefix)", () => {
    expect(() => assertChecksumPrefix(HEX64)).toThrow(/sha256:/);
  });

  test("rejects wrong-length and malformed checksums", () => {
    expect(() => assertChecksumPrefix(`sha256:${"ab".repeat(31)}`)).toThrow();
    expect(() => assertChecksumPrefix("sha256:not-hex-at-all")).toThrow();
    expect(() => assertChecksumPrefix("md5:1234567890abcdef1234567890abcdef")).toThrow(
      /sha256/,
    );
  });
});

describe("buildGoshTransferArgs", () => {
  test("direct-mode argv carries url, dir, out, connections, checksum, json output", () => {
    const args = buildGoshTransferArgs({
      url: "https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf",
      dir: "/data/models",
      out: "model.Q8_0.gguf",
      checksumHex: `sha256:${HEX64}`,
      maxConnections: 16,
    });
    // argv[0] must be the binary itself (Bun.spawn cmd shape).
    expect(args[0]).toBe("gosh");
    expect(args).toContain("https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf");
    expect(args).toContain("-d");
    expect(args).toContain("/data/models");
    expect(args).toContain("-o");
    expect(args).toContain("model.Q8_0.gguf");
    expect(args).toContain("-x");
    expect(args).toContain("16");
    expect(args).toContain("--checksum");
    expect(args).toContain(`sha256:${HEX64}`);
    expect(args).toContain("--output");
    expect(args).toContain("json");
  });

  test("defaults max connections to 8 when omitted (gosh default)", () => {
    const args = buildGoshTransferArgs({
      url: "https://example.com/model.gguf",
      dir: "/data/models",
      out: "model.gguf",
      checksumHex: `sha256:${"cd".repeat(32)}`,
    });
    expect(args[args.indexOf("-x") + 1]).toBe("8");
  });

  test("validates the checksum prefix before building args", () => {
    expect(() =>
      buildGoshTransferArgs({
        url: "https://example.com/model.gguf",
        dir: "/data/models",
        out: "model.gguf",
        checksumHex: "cd".repeat(32), // bare hex — silently ignored upstream
      }),
    ).toThrow(/sha256:/);
  });
});

describe("parseGoshEvent — --output json line parser", () => {
  test("parses a downloading progress event with percent and bytes", () => {
    const ev = parseGoshEvent(
      `{"status":"downloading","progress":{"percent":42.5,"bytes":123456}}`,
    );
    expect(ev).toEqual({ status: "downloading", percent: 42.5, bytes: 123456 });
  });

  test("parses a completed event", () => {
    const ev = parseGoshEvent(
      `{"status":"completed","path":"/data/models/model.gguf","bytes":987654}`,
    );
    expect(ev).toEqual({ status: "completed", bytes: 987654 });
  });

  test("parses an error event", () => {
    const ev = parseGoshEvent(`{"status":"error","error":"checksum mismatch"}`);
    expect(ev).toEqual({ status: "error", error: "checksum mismatch" });
  });

  test("returns null for non-JSON lines (keepalives, blanks, TUI noise)", () => {
    expect(parseGoshEvent("")).toBeNull();
    expect(parseGoshEvent("not json at all")).toBeNull();
    expect(parseGoshEvent(":-keepalive")).toBeNull();
  });
});