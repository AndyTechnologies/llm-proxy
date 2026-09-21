import { describe, expect, test } from "bun:test";
import { makeOpenRouterAdapter } from "./adapter-openrouter.js";
import { ProviderMisconfiguredError } from "./adapters.js";

const completionResponse = {
  id: "chatcmpl-or",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "deepseek/deepseek-chat",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "via OpenRouter" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

describe("adapter-openrouter — thin OpenAI-wire provider", () => {
  test("chat round-trip targets the OpenRouter base URL with Bearer auth", async () => {
    const seen: { url: string; auth: string | null } = { url: "", auth: null };
    const provider = makeOpenRouterAdapter({
      keyResolver: async () => "sk-or-42",
      headers: { "HTTP-Referer": "https://weavellm.local" },
      models: ["deepseek/deepseek-chat"],
      fetcher: (url, init) => {
        seen.url = url;
        seen.auth = new Headers(init?.headers).get("authorization");
        return Promise.resolve(Response.json(completionResponse, { status: 200 }));
      },
    });

    const result = await provider.chat({
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen.auth).toBe("Bearer sk-or-42");
    expect(result).toEqual(completionResponse);
  });

  test("missing key raises ProviderMisconfiguredError", async () => {
    const provider = makeOpenRouterAdapter({
      keyResolver: async () => null,
      headers: {},
      models: [],
      fetcher: () => Promise.resolve(Response.json({}, { status: 200 })),
    });
    await expect(
      provider.chat({ model: "deepseek/deepseek-chat", messages: [] }),
    ).rejects.toThrow(ProviderMisconfiguredError);
  });
});