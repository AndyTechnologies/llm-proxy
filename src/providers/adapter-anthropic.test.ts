import { describe, expect, test } from "bun:test";
import {
  anthropicEventToChunk,
  anthropicResponseToOpenAI,
  translateChatRequestToAnthropic,
  type AnthropicStreamState,
} from "./adapter-anthropic.js";
import { makeAnthropicAdapter } from "./adapter-anthropic.js";
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

function sseBody(events: Array<{ event: string; data: string }>): Response {
  const text = events
    .map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`)
    .join("");
  return new Response(text, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("translateChatRequestToAnthropic", () => {
  test("folds system messages into the top-level system field", () => {
    const out = translateChatRequestToAnthropic({
      model: "claude-3-5-sonnet",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out.system).toBe("You are terse.");
    expect(out.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  test("maps OpenAI tools to Anthropic input_schema shape", () => {
    const out = translateChatRequestToAnthropic({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "Call a tool" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather lookup",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    });
    expect(out.tools).toEqual([
      {
        name: "get_weather",
        description: "Weather lookup",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  test("defaults max_tokens to 4096 when the request does not set one", () => {
    const out = translateChatRequestToAnthropic({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(out.max_tokens).toBe(4096);
  });

  test("maps stop string to stop_sequences array and drops non-Anthropic params", () => {
    const out = translateChatRequestToAnthropic({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "Hi" }],
      stop: "END",
      temperature: 0.7,
      seed: 42,
      presence_penalty: 0.5,
    });
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.temperature).toBe(0.7);
    expect("seed" in out).toBe(false);
    expect("presence_penalty" in out).toBe(false);
  });
});

describe("anthropicResponseToOpenAI", () => {
  interface ChatCompletion {
    object: string;
    model: string;
    choices: Array<{
      message: { content: string; tool_calls?: unknown[] };
      finish_reason: string;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }

  test("maps a text response into the OpenAI chat.completion envelope", () => {
    const out = anthropicResponseToOpenAI(
      {
        id: "msg_abc",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from Claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      "claude-3-5-sonnet",
    ) as unknown as ChatCompletion;
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("claude-3-5-sonnet");
    expect(out.choices[0].message.content).toBe("Hello from Claude");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  });

  test("tool_use blocks surface as OpenAI tool_calls", () => {
    const out = anthropicResponseToOpenAI(
      {
        id: "msg_abc",
        type: "message",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "BA" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      "claude-3-5-sonnet",
    ) as unknown as ChatCompletion;
    expect(out.choices[0].message.content).toBe("");
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "BA" }) },
      },
    ]);
    expect(out.choices[0].finish_reason).toBe("tool_calls");
  });

  test("max_tokens stop reason maps to finish_reason length", () => {
    const out = anthropicResponseToOpenAI(
      {
        id: "msg_x",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "cut" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      "m",
    ) as unknown as ChatCompletion;
    expect(out.choices[0].finish_reason).toBe("length");
  });
});

describe("anthropicEventToChunk — streaming event translation", () => {
  const fresh = (): AnthropicStreamState => ({ toolCalls: new Map(), sawStart: false });

  test("message_start emits the role chunk", () => {
    const chunks = anthropicEventToChunk(
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 7 } } },
      fresh(),
    );
    expect(chunks).toHaveLength(1);
    const chunk = JSON.parse(chunks[0]) as {
      choices: Array<{ delta: { role?: string } }>;
    };
    expect(chunk.choices[0].delta.role).toBe("assistant");
  });

  test("text deltas flow as content deltas", () => {
    const state = fresh();
    anthropicEventToChunk(
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 7 } } },
      state,
    );
    const chunks = anthropicEventToChunk(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      state,
    );
    expect(JSON.parse(chunks[0]).choices[0].delta.content).toBe("Hel");
  });

  test("message_delta emits the terminal chunk with mapped finish_reason", () => {
    const state = fresh();
    const chunks = anthropicEventToChunk(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 11 },
      },
      state,
    );
    const chunk = JSON.parse(chunks[0]) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    // no content delta emitted
    expect(chunk.choices[0].finish_reason).toBe("stop");
  });

  test("tool_use start + input_json_delta produce OpenAI tool_call chunks", () => {
    const state = fresh();
    anthropicEventToChunk(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "get_weather", input: {} } },
      state,
    );
    const first = anthropicEventToChunk(
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } },
      state,
    );
    const second = anthropicEventToChunk(
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"BA"}' } },
      state,
    );
    const toolChunk = JSON.parse(first[0]) as {
      choices: Array<{ delta: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    expect(toolChunk.choices[0].delta.tool_calls?.[0].id).toBe("toolu_9");
    expect(toolChunk.choices[0].delta.tool_calls?.[0].function.name).toBe("get_weather");
    const secondChunk = JSON.parse(second[0]) as {
      choices: Array<{ delta: { tool_calls?: Array<{ function: { arguments: string } }> } }>;
    };
    expect(secondChunk.choices[0].delta.tool_calls?.[0].function.arguments).toBe('"BA"}');
  });
});

describe("makeAnthropicAdapter — fetch integration with fake upstream", () => {
  const anthropicCompletion = {
    id: "msg_up",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Claude says hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 3 },
  };

  test("non-streaming round-trip sends x-api-key and returns OpenAI shape", async () => {
    const upstream = new FakeUpstream(() =>
      Response.json(anthropicCompletion, { status: 200 }),
    );
    const provider = makeAnthropicAdapter({
      baseUrl: "https://api.anthropic.com/v1",
      keyResolver: async () => "sk-ant-test",
      headers: {},
      models: ["claude-3-5-sonnet"],
      fetcher: upstream.fetcher,
    });

    const result = (await provider.chat({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    })) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };

    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(call.init.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0].message.content).toBe("Claude says hi");
  });

  test("streaming round-trip translates Anthropic SSE into OpenAI chunks", async () => {
    const upstream = new FakeUpstream(() =>
      sseBody([
        {
          event: "message_start",
          data: JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 2 } } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
        },
        {
          event: "message_delta",
          data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
        },
        { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
      ]),
    );
    const provider = makeAnthropicAdapter({
      baseUrl: "https://api.anthropic.com/v1",
      keyResolver: async () => "sk-ant-test",
      headers: {},
      models: ["claude-3-5-sonnet"],
      fetcher: upstream.fetcher,
    });

    const chunks: string[] = [];
    for await (const payload of provider.chatStream(
      { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }], stream: true },
      new AbortController().signal,
    )) {
      chunks.push(payload);
    }

    expect(upstream.calls[0].body.stream).toBe(true);
    expect(chunks).toHaveLength(3);
    expect(JSON.parse(chunks[0]).choices[0].delta.role).toBe("assistant");
    expect(JSON.parse(chunks[1]).choices[0].delta.content).toBe("Hi");
    expect(JSON.parse(chunks[2]).choices[0].finish_reason).toBe("stop");
  });

  test("missing key raises ProviderMisconfiguredError and never touches upstream", async () => {
    const upstream = new FakeUpstream(() => Response.json({}, { status: 200 }));
    const provider = makeAnthropicAdapter({
      baseUrl: "https://api.anthropic.com/v1",
      keyResolver: async () => null,
      headers: {},
      models: ["claude-3-5-sonnet"],
      fetcher: upstream.fetcher,
    });

    await expect(
      provider.chat({ model: "claude-3-5-sonnet", messages: [] }),
    ).rejects.toThrow(ProviderMisconfiguredError);
    expect(upstream.calls).toHaveLength(0);
  });
});