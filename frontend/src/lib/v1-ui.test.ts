/**
 * bun:test suite for the playground's pure rendering helpers (v1-ui.ts).
 * highlightJson must be byte-preserving (join(tokens) === source) and must
 * classify keys/strings/numbers/bools/null correctly on a serialized body.
 */

import { describe, expect, test } from "bun:test";
import { highlightJson, type JsonToken } from "./v1-ui.js";

const SAMPLE = JSON.stringify(
  {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1710000000,
    model: "gateway/summary",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello, \"world\"!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, sorted: true, extra: null },
  },
  null,
  2,
);

function kindsOf(tokens: JsonToken[]): JsonToken["kind"][] {
  return tokens.map((t) => t.kind);
}

describe("highlightJson()", () => {
  test("round-trips byte-identically (join === source)", () => {
    const tokens = highlightJson(SAMPLE);
    expect(tokens.map((t) => t.value).join("")).toBe(SAMPLE);
  });

  test("classifies keys, strings, numbers, bools and null", () => {
    const kinds = kindsOf(highlightJson(SAMPLE));
    expect(kinds).toContain("key");
    expect(kinds).toContain("string");
    expect(kinds).toContain("number");
    expect(kinds).toContain("bool");
    expect(kinds).toContain("null");
    // punctuation + whitespace are preserved verbatim as punct tokens
    expect(kinds).toContain("punct");
  });

  test("'true' and 'null' become bool/null, not strings", () => {
    const tokens = highlightJson('{"sorted": true, "extra": null}');
    expect(tokens.filter((t) => t.value === "true")[0]?.kind).toBe("bool");
    expect(tokens.filter((t) => t.value === "null")[0]?.kind).toBe("null");
  });

  test("non-key strings are never classified as keys", () => {
    const tokens = highlightJson('{"a": "hello", "b": ["x", "y"]}');
    const keys = tokens.filter((t) => t.kind === "key").map((t) => t.value);
    expect(keys).toEqual(['"a"', '"b"']);
    const strings = tokens.filter((t) => t.kind === "string").map((t) => t.value);
    expect(strings).toEqual(['"hello"', '"x"', '"y"']);
  });

  test("escaped quotes stay inside one string token", () => {
    const tokens = highlightJson('{"c": "a \\"b\\" c"}');
    const stringTokens = tokens.filter((t) => t.kind === "string");
    expect(stringTokens).toHaveLength(1);
    expect(stringTokens[0]?.value).toBe('"a \\"b\\" c"');
  });

  test("empty input yields no tokens", () => {
    expect(highlightJson("")).toEqual([]);
  });
});