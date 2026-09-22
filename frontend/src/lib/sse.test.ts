/**
 * bun:test suite for the pure SSE token-frame decoder (sse.ts). No IO — the
 * decoder only sees strings, so every frame shape the server (or the local
 * one-shot encoder) can produce is covered directly.
 */

import { describe, expect, test } from "bun:test";
import { decodeTokenData, encodeTokenFrame } from "./sse.js";

function completionFrame(completion: unknown): string {
  return `data: ${JSON.stringify(completion)}\n\n`;
}

function completion(text: string): unknown {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gateway/demo",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: null,
  };
}

function chunk(text: string): unknown {
  return {
    id: "cmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text } }],
  };
}

describe("decodeTokenData", () => {
  test("extracts content from a chat.completion frame", () => {
    const result = decodeTokenData(completionFrame(completion("Hello!")));
    expect(result).toEqual({ content: "Hello!", done: false });
  });

  test("extracts content from a chat.completion.chunk delta frame", () => {
    const result = decodeTokenData(completionFrame(chunk("Hel")));
    expect(result).toEqual({ content: "Hel", done: false });
  });

  test("a [DONE] frame sets the terminal flag", () => {
    expect(decodeTokenData("data: [DONE]\n\n")).toEqual({ content: "", done: true });
  });

  test("content frame then [DONE] in one payload aggregates and terminates", () => {
    const data = completionFrame(completion("Hello!")) + "data: [DONE]\n\n";
    expect(decodeTokenData(data)).toEqual({ content: "Hello!", done: true });
  });

  test("multiple data frames in one event concatenate content in order", () => {
    const data =
      completionFrame(chunk("The ")) + completionFrame(chunk("answer ")) + completionFrame(chunk("is 42."));
    expect(decodeTokenData(data)).toEqual({ content: "The answer is 42.", done: false });
  });

  test("CRLF frame separators are tolerated", () => {
    const data = "data: {\"choices\":[{\"message\":{\"content\":\"hi\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
    expect(decodeTokenData(data)).toEqual({ content: "hi", done: true });
  });

  test("multi-line data fields join into one JSON payload", () => {
    const data = 'data: {"choices":[{"message":{"content":\ndata: "multi"}}]}\n\n';
    expect(decodeTokenData(data)).toEqual({ content: "multi", done: false });
  });

  test("frames without a data: field are ignored", () => {
    const data = ": comment\n\nevent: message\n\n";
    expect(decodeTokenData(data)).toEqual({ content: "", done: false });
  });

  test("a non-JSON data frame is skipped, not thrown", () => {
    expect(decodeTokenData("data: not json at all\n\n")).toEqual({ content: "", done: false });
  });

  test("an empty payload decodes to nothing", () => {
    expect(decodeTokenData("")).toEqual({ content: "", done: false });
  });

  test("whitespace-only frames are ignored", () => {
    expect(decodeTokenData("   \n\n")).toEqual({ content: "", done: false });
  });
});

describe("encodeTokenFrame", () => {
  test("round-trips through decodeTokenData", () => {
    const decoded = decodeTokenData(encodeTokenFrame("one-shot output"));
    expect(decoded).toEqual({ content: "one-shot output", done: false });
  });

  test("empty content round-trips as an empty (not done) frame", () => {
    expect(decodeTokenData(encodeTokenFrame(""))).toEqual({ content: "", done: false });
  });

  test("frames that carry no completion text yield no content", () => {
    const data = completionFrame({ id: "x", object: "chat.completion", choices: [] });
    expect(decodeTokenData(data)).toEqual({ content: "", done: false });
  });
});