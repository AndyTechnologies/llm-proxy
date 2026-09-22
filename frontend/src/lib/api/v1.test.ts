/**
 * bun:test suite for the /v1 client (v1.ts, U11). Drives both wire paths
 * with an injected fake fetch — JSON completion, OpenAI-wire SSE streams,
 * the 401 Bearer envelope, the 404 unknown-model envelope, stream split
 * across chunk boundaries, truncation, and mid-stream abort.
 *
 * Mirrors the config.test.ts / http.test.ts conventions: bun:test,
 * describe/test, imports with explicit .js extensions, no real network.
 */

import { describe, expect, test } from "bun:test";
import {
  chatCompletion,
  chatCompletionStream,
  splitSSEFrames,
  v1ErrorFrom,
} from "./v1.js";
import type { ChatStreamHandlers, V1ChatRequest, V1StreamEvent } from "./v1.js";
import { ApiError } from "./http.js";

const encoder = new TextEncoder();

const REQUEST: V1ChatRequest = {
  model: "gateway/summary",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers });
}

/** Fake fetch returning an SSE body built from raw text chunks. */
function sseResponse(chunks: string[]): typeof fetch {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return async () =>
    new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Capture the RequestInit a fetch impl receives (header/body assertions). */
function captureFetch(): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse({ ok: true })();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function collectStream(
  body: V1ChatRequest,
  handlers: ChatStreamHandlers,
  fetchImpl: typeof fetch,
): Promise<V1StreamEvent[]> {
  const events: V1StreamEvent[] = [];
  for await (const event of chatCompletionStream(body, handlers, {
    origin: "http://test",
    fetchImpl,
  })) {
    events.push(event);
  }
  return events;
}

const COMPLETION = {
  id: "cmpl-1",
  object: "chat.completion",
  created: 1710000000,
  model: "gateway/summary",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

describe("splitSSEFrames()", () => {
  test("splits one frame per chunk and keeps an unterminated tail", () => {
    const state = { rest: "" };
    expect(splitSSEFrames(state, "data: a\n\n")).toEqual(["data: a"]);
    expect(state.rest).toBe("");
    expect(splitSSEFrames(state, "data: b")).toEqual([]);
    expect(state.rest).toBe("data: b");
    expect(splitSSEFrames(state, "\n\ndata: c\n\n")).toEqual(["data: b", "data: c"]);
    expect(state.rest).toBe("");
  });

  test("completes a frame split across ANY chunk boundary, LF or CRLF", () => {
    const state = { rest: "" };
    // LF separator, separator itself split across chunks
    expect(splitSSEFrames(state, "data: o")).toEqual([]);
    expect(splitSSEFrames(state, "ne\n")).toEqual([]);
    expect(splitSSEFrames(state, "\n")).toEqual(["data: one"]);
    // CRLF separator
    expect(splitSSEFrames(state, "data: two\r\n\r")).toEqual([]);
    expect(splitSSEFrames(state, "\n")).toEqual(["data: two"]);
    expect(state.rest).toBe("");
  });

  test("handles multiple complete frames in one chunk", () => {
    const state = { rest: "" };
    expect(splitSSEFrames(state, "data: 1\n\ndata: 2\n\ndata: 3\n\n")).toEqual([
      "data: 1",
      "data: 2",
      "data: 3",
    ]);
  });
});

describe("v1ErrorFrom()", () => {
  test("extracts the OpenAI envelope verbatim", () => {
    const err = v1ErrorFrom(
      404,
      JSON.stringify({
        error: { message: "The model 'nope' does not exist", type: "invalid_request_error", param: null, code: "model_not_found" },
      }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("The model 'nope' does not exist");
    expect(err.code).toBe("model_not_found");
    expect(err.errors).toEqual({
      error: { message: "The model 'nope' does not exist", type: "invalid_request_error", param: null, code: "model_not_found" },
    });
  });

  test("keeps non-JSON bodies as raw text verbatim", () => {
    const err = v1ErrorFrom(502, "upstream exploded");
    expect(err.status).toBe(502);
    expect(err.message).toBe("http_502");
    expect(err.errors).toBe("upstream exploded");
  });
});

describe("chatCompletion()", () => {
  test("parses a JSON completion body", async () => {
    const result = await chatCompletion(REQUEST, {
      origin: "http://test",
      fetchImpl: jsonResponse(COMPLETION),
    });
    expect(result).toEqual(COMPLETION);
  });

  test("posts the typed body to /v1/chat/completions with stream:false and NO Authorization header", async () => {
    const { fetchImpl, calls } = captureFetch();
    await chatCompletion(
      { ...REQUEST, temperature: 0.4 },
      { origin: "http://test", fetchImpl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://test/v1/chat/completions");
    const init = calls[0].init;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.model).toBe("gateway/summary");
    expect(sent.stream).toBe(false);
    expect(sent.temperature).toBe(0.4);
  });

  test("omits temperature when not provided", async () => {
    const { fetchImpl, calls } = captureFetch();
    await chatCompletion(REQUEST, { origin: "http://test", fetchImpl });
    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect("temperature" in sent).toBe(false);
  });

  test("throws ApiError with the 401 Bearer envelope verbatim", async () => {
    const err = await chatCompletion(REQUEST, {
      origin: "http://test",
      fetchImpl: jsonResponse(
        { error: { message: "Unauthorized", type: "authentication_error", param: null, code: null } },
        401,
      ),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.message).toBe("Unauthorized");
    expect(apiError.errors).toMatchObject({ error: { message: "Unauthorized" } });
  });

  test("throws ApiError with the unknown-model 404 envelope verbatim", async () => {
    const err = await chatCompletion(
      { ...REQUEST, model: "qwen-local" },
      {
        origin: "http://test",
        fetchImpl: jsonResponse(
          { error: { message: "The model 'qwen-local' does not exist", type: "invalid_request_error", param: null, code: "model_not_found" } },
          404,
        ),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.message).toBe("The model 'qwen-local' does not exist");
    expect(apiError.code).toBe("model_not_found");
  });

  test("rejects as aborted when the signal fires before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    // Realistic browser fetch: an already-aborted signal rejects immediately.
    const signalAwareFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const err = await chatCompletion(REQUEST, {
      origin: "http://test",
      fetchImpl: signalAwareFetch,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("aborted");
  });
});

describe("chatCompletionStream()", () => {
  const CHUNK_1 = JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 1710000000,
    model: "gateway/summary",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
  });
  const CHUNK_2 = JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 1710000000,
    model: "gateway/summary",
    choices: [{ index: 0, delta: { content: "!" }, finish_reason: "stop" }],
  });

  test("yields parsed frames, then done, with raw text and rolled-up content", async () => {
    const rawParts: string[] = [];
    let summary: unknown = null;
    const events = await collectStream(
      { ...REQUEST, stream: true },
      {
        onRaw: (chunk) => rawParts.push(chunk),
        onDone: (s) => {
          summary = s;
        },
      },
      sseResponse([`data: ${CHUNK_1}\n\n`, `data: ${CHUNK_2}\n\n`, "data: [DONE]\n\n"]),
    );
    expect(events.map((e) => e.type)).toEqual(["frame", "frame", "done"]);
    expect(rawParts.join("")).toBe(`data: ${CHUNK_1}\n\ndata: ${CHUNK_2}\n\ndata: [DONE]\n\n`);
    const first = events[0];
    if (first.type !== "frame") throw new Error("expected first frame");
    expect(first.payload.choices[0].delta.content).toBe("Hello");
    expect(summary).toEqual({
      done: true,
      raw: `data: ${CHUNK_1}\n\ndata: ${CHUNK_2}\n\ndata: [DONE]\n\n`,
      content: "Hello!",
      frames: 2,
    });
  });

  test("parses frames split across chunk boundaries (mid-JSON cut)", async () => {
    const events = await collectStream(
      { ...REQUEST, stream: true },
      { onRaw: () => {} },
      sseResponse([`data: ${CHUNK_1.slice(0, 24)}`, `${CHUNK_1.slice(24)}\n\ndata: [DONE]\n\n`]),
    );
    expect(events.map((e) => e.type)).toEqual(["frame", "done"]);
  });

  test("throws ApiError(404) with the envelope verbatim, before any event", async () => {
    const events: V1StreamEvent[] = [];
    let caught: unknown = null;
    try {
      for await (const event of chatCompletionStream(
        { ...REQUEST, stream: true },
        { onRaw: () => {} },
        {
          origin: "http://test",
          fetchImpl: jsonResponse(
            { error: { message: "The model 'x' does not exist", type: "invalid_request_error", param: null, code: "model_not_found" } },
            404,
          ),
        },
      )) {
        events.push(event);
      }
    } catch (err) {
      caught = err;
    }
    expect(events).toEqual([]);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("The model 'x' does not exist");
  });

  test("yields truncated when the body ends without the terminal [DONE]", async () => {
    let summary: unknown = null;
    const events = await collectStream(
      { ...REQUEST, stream: true },
      {
        onRaw: () => {},
        onDone: (s) => {
          summary = s;
        },
      },
      sseResponse([`data: ${CHUNK_1}\n\n`]),
    );
    expect(events.map((e) => e.type)).toEqual(["frame", "truncated"]);
    expect(summary).toMatchObject({ done: false, frames: 1 });
  });

  test("yields aborted mid-stream and skips onDone", async () => {
    const controller = new AbortController();
    const pendingRead = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });
    pendingRead.catch(() => {});
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode(`data: ${CHUNK_1}\n\n`));
      },
      async pull() {
        await pendingRead;
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    let doneCalled = false;
    const events: V1StreamEvent[] = [];
    const iterator = chatCompletionStream(
      { ...REQUEST, stream: true },
      {
        onRaw: () => {},
        onDone: () => {
          doneCalled = true;
        },
        signal: controller.signal,
      },
      { origin: "http://test", fetchImpl },
    );
    for await (const event of iterator) {
      events.push(event);
      if (event.type === "frame") controller.abort();
    }
    expect(events.map((e) => e.type)).toEqual(["frame", "aborted"]);
    expect(doneCalled).toBe(false);
  });
});