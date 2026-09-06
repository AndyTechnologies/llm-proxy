/**
 * OpenAI-compatible external provider adapter tests (strict TDD — task 2.1).
 *
 * The adapter is exercised through a fake `LanguageModelV4` (no network), so
 * every assertion runs against the real `generateText` / `streamText` part
 * pipeline of the AI SDK.
 *
 * Contract scenarios covered:
 *   - Non-streaming: OpenAI `chat.completion` envelope reconstruction from the
 *     SDK result (content, finish_reason, usage, tool_calls passthrough)
 *   - Non-streaming: non-retried error mapping (429, 404)
 *   - Streaming: raw wire chunks pass through verbatim, with exactly one
 *     terminal chunk (raw finish seen => no synthesized terminal)
 *   - Streaming: fallback synthesis from SDK parts (text-delta, tool-call,
 *     finish) when raw chunks are absent
 *   - Abort: client abort stops the stream cleanly (zero output, no throw)
 */
import { describe, expect, test } from "bun:test";
import { APICallError, NoSuchModelError } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import {
  makeOpenAICompatibleProvider,
  providerOptionsFrom,
  translateSDKError,
} from "./openai-compatible.js";
// Helpers moved to the SDK isolation surface during hardening (post-archive):
// toFinishReason lives in sdk-surface.ts together with the other SDK-boundary
// helpers (wireUsage, synthChunk, isTerminalWireChunk, sdkErrorStatus).
import { toFinishReason } from "./sdk-surface.js";

/** Wire usage values used by the fake model and the raw chunk helper. */
function fakeUsage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

interface FakeModelSpec {
  generate?: {
    result?: Partial<LanguageModelV4GenerateResult>;
    error?: unknown;
  };
  stream?: {
    parts?: LanguageModelV4StreamPart[];
    error?: unknown;
  };
}

function makeFakeModel(spec: FakeModelSpec = {}): {
  model: LanguageModelV4;
  calls: {
    generate: number;
    stream: number;
    signals: Array<AbortSignal | undefined>;
    options: Array<LanguageModelV4CallOptions>;
  };
} {
  const calls: {
    generate: number;
    stream: number;
    signals: Array<AbortSignal | undefined>;
    options: Array<LanguageModelV4CallOptions>;
  } = { generate: 0, stream: 0, signals: [], options: [] };

  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "fake-provider",
    modelId: "fake-model",
    supportedUrls: {},
    async doGenerate(options) {
      calls.generate += 1;
      calls.signals.push(options.abortSignal);
      calls.options.push(options);
      if (spec.generate?.error !== undefined) throw spec.generate.error;
      return {
        content: [{ type: "text", text: "out" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: fakeUsage(5, 2),
        warnings: [],
        ...spec.generate?.result,
      };
    },
    async doStream(options) {
      calls.stream += 1;
      calls.signals.push(options.abortSignal);
      calls.options.push(options);
      if (spec.stream?.error !== undefined) throw spec.stream.error;
      const parts = spec.stream?.parts ?? [];
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
      return { stream, response: { headers: {} } };
    },
  };

  return { model, calls };
}

/** Provider under test wired to a configurable fake model. */
function makeProvider(model: LanguageModelV4, name = "openai") {
  const requested: string[] = [];
  const provider = makeOpenAICompatibleProvider({
    name,
    baseURL: "http://fake.invalid/v1",
    models: ["gpt-4o"],
    modelFactory: (modelId) => {
      requested.push(modelId);
      return model;
    },
  });
  return { provider, requested };
}

/** Collect every yielded SSE payload (the raw JSON strings before `data: `). */
async function collect(
  gen: AsyncIterable<string>,
): Promise<string[]> {
  const out: string[] = [];
  for await (const line of gen) out.push(line);
  return out;
}

/** Build a raw wire `chat.completion.chunk` part for the fake model. */
function rawChunk(part: {
  content?: string;
  finish?: string;
  usage?: LanguageModelV4Usage;
}): LanguageModelV4StreamPart {
  return {
    type: "raw",
    rawValue: {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: part.content !== undefined ? { content: part.content } : {},
          finish_reason: part.finish ?? null,
        },
      ],
      ...(part.usage !== undefined
        ? {
            usage: {
              prompt_tokens: part.usage.inputTokens.total,
              completion_tokens: part.usage.outputTokens.total,
              total_tokens:
                (part.usage.inputTokens.total ?? 0) +
                (part.usage.outputTokens.total ?? 0),
            },
          }
        : {}),
    },
  };
}

const finishStop: { finishReason: LanguageModelV4FinishReason } = {
  finishReason: { unified: "stop", raw: "stop" },
};
const usageStop = fakeUsage(5, 2);

describe("non-streaming chat (OpenAI envelope)", () => {
  test("reconstructs the OpenAI chat.completion envelope from the SDK result", async () => {
    const { model, calls } = makeFakeModel({
      generate: {
        result: {
          content: [{ type: "text", text: "hello world" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usageStop,
        },
      },
    });
    const { provider, requested } = makeProvider(model);

    const body = await provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(requested).toEqual(["gpt-4o"]);
    expect(body.status).toBe(200);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-4o");
    expect(body.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "hello world" },
        finish_reason: "stop",
      },
    ]);
    expect(body.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
    expect(calls.generate).toBe(1);
  });

  test("passes through tool_calls and maps the tool-calls finish reason", async () => {
    const { model } = makeFakeModel({
      generate: {
        result: {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "getWeather",
              input: JSON.stringify({ city: "Buenos Aires" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: usageStop,
        },
      },
    });
    const { provider } = makeProvider(model);

    const body = await provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "weather?" }],
    });
    const message = (body.choices as Array<Record<string, unknown>>)[0]
      .message as Record<string, unknown>;

    expect(message).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "getWeather",
            arguments: '{"city":"Buenos Aires"}',
          },
        },
      ],
    });
    expect((body.choices as Array<Record<string, unknown>>)[0].finish_reason).toBe("tool_calls");
  });

  test("routes non-reserved request keys into providerOptions under the provider name", async () => {
    const { model, calls } = makeFakeModel({
      generate: { result: { usage: usageStop } },
    });
    const { provider } = makeProvider(model);

    await provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 10,
      stop: ["END"],
      seed: 3,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      tools: [
        { type: "function", function: { name: "f", parameters: {} } },
      ],
      tool_choice: "auto",
      top_k: 50,
      min_p: 0.1,
    });

    expect(calls.options[0].providerOptions).toEqual({
      openai: {
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        tool_choice: "auto",
        top_k: 50,
        min_p: 0.1,
      },
    });
  });

  test("maps standard parameters directly to SDK call settings (S4.2)", async () => {
    const { model, calls } = makeFakeModel({
      generate: { result: { usage: usageStop } },
    });
    const { provider } = makeProvider(model);

    await provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 10,
      stop: ["END"],
    });

    // S4.2 — the design request->wire table maps these DIRECTLY to SDK call
    // settings: temperature->temperature, top_p->topP, max_tokens->
    // maxOutputTokens, stop->stopSequences (asserted on the real options the
    // SDK handed to the model).
    expect(calls.options[0]).toMatchObject({
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 10,
      stopSequences: ["END"],
    });

    // triangulation: a string stop is normalized to a single-element array
    await provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stop: "END",
    });
    expect(calls.options[1]).toMatchObject({ stopSequences: ["END"] });
  });

  test("maps a 429 APICallError to Error & { status: 429 } without retrying", async () => {
    const apiError = new APICallError({
      message: "rate limited",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "rate limited",
      isRetryable: true,
    });
    const { model, calls } = makeFakeModel({
      generate: { error: apiError },
    });
    const { provider } = makeProvider(model);

    await expect(
      provider.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ status: 429, isRetryable: true });
    expect(calls.generate).toBe(1); // maxRetries: 0 — the SDK never retried
  });

  test("maps a 5xx APICallError to Error & { status: <statusCode> }", async () => {
    // S3.3 — upstream 5xx maps to ITS OWN status (design error table:
    // APICallError -> statusCode). 503 stays 503, exactly like 429 stays 429.
    const apiError = new APICallError({
      message: "service unavailable",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      responseBody: "service unavailable",
      isRetryable: true,
    });
    const { model } = makeFakeModel({
      generate: { error: apiError },
    });
    const { provider } = makeProvider(model);

    await expect(
      provider.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ status: 503, isRetryable: true });
  });

  test("maps NoSuchModelError to Error & { status: 404 }", async () => {
    const { model } = makeFakeModel({
      generate: {
        error: new NoSuchModelError({
          modelId: "gpt-4o",
          modelType: "languageModel",
        }),
      },
    });
    const { provider } = makeProvider(model);

    await expect(
      provider.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("streaming chat (OpenAI wire chunks)", () => {
  test("yields raw wire chunks verbatim with a single terminal chunk", async () => {
    const { model, calls } = makeFakeModel({
      stream: {
        parts: [
          rawChunk({ content: "hello " }),
          rawChunk({ content: "world", finish: "stop", usage: usageStop }),
          { type: "finish", ...finishStop, usage: usageStop },
        ],
      },
    });
    const { provider } = makeProvider(model);

    const signal = new AbortController().signal;
    const lines = await collect(
      provider.chatStream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, signal),
    );
    const chunks = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    // the two raw chunks pass through unchanged (verbatim wire fidelity)
    expect(lines).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
    });
    expect(chunks[0]).toMatchObject({
      choices: [{ index: 0, delta: { content: "hello " }, finish_reason: null }],
    });
    expect(chunks[1]).toMatchObject({
      choices: [
        {
          index: 0,
          delta: { content: "world" },
          finish_reason: "stop",
        },
      ],
    });
    expect(chunks[1]).toMatchObject({
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    expect(calls.stream).toBe(1);
  });

  test("synthesizes wire chunks from SDK parts when raw chunks are absent", async () => {
    const { model } = makeFakeModel({
      stream: {
        parts: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "fallback " },
          { type: "text-delta", id: "t1", delta: "text" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "length", raw: "length" }, usage: usageStop },
        ],
      },
    });
    const { provider } = makeProvider(model);

    const signal = new AbortController().signal;
    const chunks = (await collect(
      provider.chatStream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, signal),
    )).map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "fallback " }, finish_reason: null }],
    });
    expect(chunks[1]).toMatchObject({
      choices: [{ index: 0, delta: { content: "text" }, finish_reason: null }],
    });
    // exactly one terminal chunk, carrying finish_reason + usage
    expect(chunks[2]).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });

  test("synthesizes tool_calls deltas from SDK tool-call parts", async () => {
    const { model } = makeFakeModel({
      stream: {
        parts: [
          {
            type: "tool-call",
            toolCallId: "call_9",
            toolName: "getWeather",
            input: '{"city":"x"}',
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usageStop },
        ],
      },
    });
    const { provider } = makeProvider(model);

    const signal = new AbortController().signal;
    const chunks = (await collect(
      provider.chatStream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, signal),
    )).map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_9",
                type: "function",
                function: {
                  name: "getWeather",
                  arguments: '{"city":"x"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    expect(chunks[1]).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  });

  test("a finish part without a raw finish chunk still yields one terminal chunk", async () => {
    const { model } = makeFakeModel({
      stream: {
        parts: [
          rawChunk({ content: "only text, never a finish" }),
          { type: "finish", ...finishStop, usage: usageStop },
        ],
      },
    });
    const { provider } = makeProvider(model);

    const signal = new AbortController().signal;
    const chunks = (await collect(
      provider.chatStream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, signal),
    )).map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      choices: [
        {
          index: 0,
          delta: { content: "only text, never a finish" },
          finish_reason: null,
        },
      ],
    });
    expect(chunks[1]).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  });

  test("maps a streamed error part to the underlying status without retrying", async () => {
    const apiError = new APICallError({
      message: "rate limited",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "rate limited",
      isRetryable: true,
    });
    const { model, calls } = makeFakeModel({
      stream: { parts: [{ type: "error", error: apiError }] },
    });
    const { provider } = makeProvider(model);

    const signal = new AbortController().signal;
    await expect(
      collect(provider.chatStream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, signal)),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls.stream).toBe(1); // maxRetries: 0 — the SDK never retried
  });

  test("aborting the signal cleanly stops the stream with zero output", async () => {
    const { model } = makeFakeModel({
      stream: { parts: [rawChunk({ content: "partial" })] },
    });
    const { provider } = makeProvider(model);

    const controller = new AbortController();
    controller.abort();

    const out = await collect(
      provider.chatStream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, controller.signal),
    );
    expect(out).toEqual([]);
  });

  test("forwards the abort signal to the model call", async () => {
    const { model, calls } = makeFakeModel({
      stream: {
        parts: [
          rawChunk({ content: "x", finish: "stop", usage: usageStop }),
          { type: "finish", ...finishStop, usage: usageStop },
        ],
      },
    });
    const { provider } = makeProvider(model);

    const controller = new AbortController();
    await collect(
      provider.chatStream({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, controller.signal),
    );

    expect(calls.signals[0]).toBe(controller.signal);
  });
});

describe("providerOptionsFrom", () => {
  test("extracts every non-settings, non-structural key under the provider name", () => {
    const opts = providerOptionsFrom(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 10,
        stop: ["END"],
        seed: 3,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        top_k: 50,
        min_p: 0.1,
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: "auto",
        n: 2,
      },
      "openai",
    );

    expect(opts).toEqual({
      openai: {
        top_k: 50,
        min_p: 0.1,
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: "auto",
        n: 2,
      },
    });
  });

  test("returns an empty object when every key is reserved", () => {
    const opts = providerOptionsFrom(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        temperature: 0.7,
      },
      "openai",
    );
    expect(opts).toEqual({});
  });
});

describe("translateSDKError", () => {
  test("maps an APICallError with statusCode 502 to Error & { status: 502 }", () => {
    // S3.3: "GIVEN an APICallError with status 502 ... THEN the error carries
    // status: 502" — the design maps APICallError to its own statusCode.
    const apiError = new APICallError({
      message: "bad gateway",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 502,
      responseBody: "bad gateway",
      isRetryable: true,
    });

    const translated = translateSDKError(apiError);
    expect(translated).toMatchObject({ status: 502, isRetryable: true });
    expect(translated.message).toBe("bad gateway");
  });

  test("maps a 503 APICallError to status 503 preserving the upstream message", () => {
    const apiError = new APICallError({
      message: "service unavailable",
      url: "http://fake.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      responseBody: "service unavailable",
      isRetryable: true,
    });

    const translated = translateSDKError(apiError);
    expect(translated.status).toBe(503);
    expect(translated.message).toBe("service unavailable");
  });

  test("falls back to status 500 for non-status-carrying errors", () => {
    const translated = translateSDKError(new Error("boom"));
    expect(translated.status).toBe(500);
    expect(translated.message).toBe("boom");
  });
});

describe("toFinishReason", () => {
  test("maps unified reasons to the OpenAI wire values", () => {
    expect(toFinishReason("stop")).toBe("stop");
    expect(toFinishReason("length")).toBe("length");
    expect(toFinishReason("tool-calls")).toBe("tool_calls");
    expect(toFinishReason("content-filter")).toBe("content_filter");
    expect(toFinishReason("error")).toBe("error");
    expect(toFinishReason("other")).toBe("other");
  });
});