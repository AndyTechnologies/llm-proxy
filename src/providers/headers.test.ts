import { describe, expect, test } from "bun:test";
import { interpolateHeaders } from "./headers.js";

describe("interpolateHeaders — ${ENV} resolution at registry build", () => {
  test("replaces ${VAR} occurrences from the provided env", () => {
    const out = interpolateHeaders(
      { "HTTP-Referer": "https://${APP_HOST}", "X-Key": "k-${APP_TOKEN}" },
      { APP_HOST: "gate.local", APP_TOKEN: "abc" },
    );
    expect(out).toEqual({ "HTTP-Referer": "https://gate.local", "X-Key": "k-abc" });
  });

  test("missing env var resolves to an empty string", () => {
    const out = interpolateHeaders({ "X-E": "${NOPE}" }, {});
    expect(out["X-E"]).toBe("");
  });

  test("values without placeholders pass through unchanged", () => {
    const out = interpolateHeaders({ "X-Fixed": "v", "X-Mixed": "a${B}c" }, { B: "2" });
    expect(out).toEqual({ "X-Fixed": "v", "X-Mixed": "a2c" });
  });

  test("absent headers object yields an empty record", () => {
    expect(interpolateHeaders(undefined, {})).toEqual({});
  });
});