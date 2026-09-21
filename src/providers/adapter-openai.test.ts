import { describe, expect, test } from "bun:test";
import { makeOpenAIAdapter } from "./adapter-openai.js";
import { ProviderMisconfiguredError } from "./adapters.js";

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

class FakeUpstream {
  calls: Call[] = [];
  respond: (call: Call, i: number) => Response;

  constructor(respond: (call: Call, i: number) => Response) {
    this.respond = respond;
  }

  fetcher = (url: string, init?: RequestInit): Promise<Response> => {
    const call = {
      url,
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    this.calls.push(call);
    return Promise.resolve(this.respond(call, this.calls.length - 1));
  };
}

function sseBody(payloads: string[]): Response {
  const text = payloads.map((p) => `data: ${p}\n\n`).join("");
  return new Response(text, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

const completionResponse = {
  id: "chatcmpl-upstream",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

describe("adapter-openai — OpenAI wire adapter", () => {
  test("chat round-trip sends Bearer auth and returns the upstream JSON", async () => {
    const upstream = new FakeUpstream(() =>
      Response.json(completionResponse, { status: 200 }),
    );
    const provider = makeOpenAIAdapter({
      baseUrl: "https://api.openai.com/v1",
      keyResolver: async () => "sk-test-123",
      headers: {},
      models: ["gpt-4o"],
      fetcher: upstream.fetcher,
    });

    const result = await provider.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test-123");
    expect(call.body.model).toBe("gpt-4o");
    expect(result).toEqual(completionResponse);
  });

  test("chatStream relays raw data payloads and consumes the upstream [DONE]", async () => {
    const upstream = new FakeUpstream(() =>
      sseBody([
        JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] }),
        JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] }),
        "[DONE]",
      ]),
    );
    const provider = makeOpenAIAdapter({
      baseUrl: "https://api.openai.com/v1",
      keyResolver: async () => "sk-test-123",
      headers: {},
      models: ["gpt-4o"],
      fetcher: upstream.fetcher,
    });

    const chunks: string[] = [];
    for await (const payload of provider.chatStream(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true },
      new AbortController().signal,
    )) {
      chunks.push(payload);
    }

    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0]).choices[0].delta.content).toBe("Hel");
    expect(JSON.parse(chunks[1]).choices[0].delta.content).toBe("lo");
    expect(upstream.calls[0].body.stream).toBe(true);
  });

  test("missing key raises ProviderMisconfiguredError and never touches upstream", async () => {
    const upstream = new FakeUpstream(() => Response.json({}, { status: 200 }));
    const provider = makeOpenAIAdapter({
      baseUrl: "https://api.openai.com/v1",
      keyResolver: async () => null,
      headers: {},
      models: ["gpt-4o"],
      fetcher: upstream.fetcher,
    });

    await expect(
      provider.chat({ model: "gpt-4o", messages: [] }),
    ).rejects.toThrow(ProviderMisconfiguredError);
    await expect(
      (async () => {
        for await (const _ of provider.chatStream(
          { model: "gpt-4o", messages: [] },
          new AbortController().signal,
        )) {
          // drain
        }
      })(),
    ).rejects.toThrow(ProviderMisconfiguredError);
    expect(upstream.calls).toHaveLength(0);
  });

  test("upstream 429 surfaces as an Error carrying the status (fallback terget)", async () => {
    const upstream = new FakeUpstream(() =>
      Response.json(
        { error: { message: "rate limited", type: "rate_limit_error" } },
        { status: 429 },
      ),
    );
    const provider = makeOpenAIAdapter({
      baseUrl: "https://api.openai.com/v1",
      keyResolver: async () => "sk-test-123",
      headers: {},
      models: ["gpt-4o"],
      fetcher: upstream.fetcher,
    });

    const err = await provider
      .chat({ model: "gpt-4o", messages: [] })
      .then(() => null)
      .catch((e: unknown) => e as Error & { status?: number });
    expect(err).not.toBeNull();
    expect((err as Error & { status?: number }).status).toBe(429);
  });
});