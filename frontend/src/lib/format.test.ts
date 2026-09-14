import { describe, expect, test } from "bun:test";
import { formatBytes, formatContext } from "./format.js";

describe("formatBytes", () => {
  test("zero maps to a plain zero byte label", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  test("binary units scale by 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(5.5 * 1024 ** 3)).toBe("5.5 GiB");
  });

  test("invalid or negative sizes render a dash, never NaN", () => {
    expect(formatBytes(-5)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatContext", () => {
  test("whole kibibyte contexts shorten to k notation", () => {
    expect(formatContext(32768)).toBe("32k");
    expect(formatContext(131072)).toBe("128k");
  });

  test("non-round contexts stay exact", () => {
    expect(formatContext(3000)).toBe("3000");
  });

  test("missing or invalid contexts are unknown", () => {
    expect(formatContext(null)).toBe("unknown");
    expect(formatContext(0)).toBe("unknown");
  });
});