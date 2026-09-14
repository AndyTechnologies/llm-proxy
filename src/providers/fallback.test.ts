import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import { SecretStore, type KeychainBackend } from "../secrets/keychain.js";
import { buildProviderRegistry, type ProviderRegistry } from "./registry.js";
import { chatStreamWithFallback, chatWithFallback } from "./fallback.js";

function memoryBackend(): KeychainBackend {
  const map = new Map<string, string>();
  return {
    async get() {
      return map.get("weavellm-master") ?? null;
    },
    async set(value: string) {
      map.set("weavellm-master", value);
    },
  };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Registry with hand-rolled per-kind fetchers (fake upstreams). */
async function makeRegistry(fetchers: Record<string, Fetcher>): Promise<{
  db: Database;
  registry: ProviderRegistry;
}> {
  const db = new Database(":memory:");
  applySchema(db);
  db.query(
    "INSERT INTO providers (kind, base_url, fallback_id) VALUES ('openai', NULL, 'anthropic'), ('anthropic', NULL, 'openrouter'), ('openrouter', NULL, NULL)",
  ).run();
  db.query(
    "INSERT INTO models (id, source, name, url, state) VALUES ('gpt-4o','openai','','','ready'), ('claude-x','anthropic','','','ready'), ('deepseek-x','openrouter','','','ready')",
  ).run();
  const store = new SecretStore(db, memoryBackend());
  for (const kind of ["openai", "anthropic", "openrouter"]) {
    await store.set(`provider:${kind}`, `sk-${kind}`);
  }
  const registry = await buildProviderRegistry({
    db,
    store,
    fetcher: (url, init) => {
      const kind = url.includes("api.openai.com")
        ? "openai"
        : url.includes("api.anthropic.com")
          ? "anthropic"
          : "openrouter";
      if (fetchers[kind] === undefined) {
        throw new Error(`no fake upstream configured for ${kind}`);
      }
      return fetchers[kind](url, init);
    },
  });
  return { db, registry };
}

/* Wire-accurate upstream fakes ---------------------------------------- */

function openaiCompletion(id: string): Response {
  return Response.json(
    {
      id,
      object: "chat.completion",
      created: 1_700_000_000,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    { status: 200 },
  );
}

function anthropicMessage(text: string): Response {
  return Response.json(
    {
      id: "msg_x",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 3 },
    },
    { status: 200 },
  );
}

function rawSse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/** Anthropic stream that emits `text` as the only content. */
function anthropicSse(text: string): Response {
  const events = [
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
    { type: "message_stop" },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const contentChunk = (text: string) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;

const roleChunk = `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`;

const doneChunk = "data: [DONE]\n\n";

function brokenAfter(chunks: string[], err: Error): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
    },
    pull() {
      throw err;
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/* Tests ---------------------------------------------------------------- */

describe("chatWithFallback — non-streaming fallback on 429/5xx/network", () => {
  test("429 on the primary provider retries on the fallback", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(new Response("rate limited", { status: 429 })),
      anthropic: () => Promise.resolve(anthropicMessage("fallback ok")),
    });

    const result = await chatWithFallback(registry, "openai", {
      model: "gpt-4o",
      messages: [],
    });
    const content = (result.choices as Array<{ message: { content: string } }>)[0].message.content;
    expect(content).toBe("fallback ok");
  });

  test("5xx on the primary provider retries on the fallback", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(new Response("boom", { status: 503 })),
      anthropic: () => Promise.resolve(anthropicMessage("recovered")),
    });
    const result = await chatWithFallback(registry, "openai", { model: "gpt-4o", messages: [] });
    const content = (result.choices as Array<{ message: { content: string } }>)[0].message.content;
    expect(content).toBe("recovered");
  });

  test("network failure (fetch throws) retries on the fallback", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.reject(new TypeError("fetch failed")),
      anthropic: () => Promise.resolve(anthropicMessage("from wire")),
    });
    const result = await chatWithFallback(registry, "openai", { model: "gpt-4o", messages: [] });
    const content = (result.choices as Array<{ message: { content: string } }>)[0].message.content;
    expect(content).toBe("from wire");
  });

  test("a 400 client error does NOT fall back — it propagates", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(new Response("bad request", { status: 400 })),
      anthropic: () => Promise.resolve(anthropicMessage("must not run")),
    });
    await expect(
      chatWithFallback(registry, "openai", { model: "gpt-4o", messages: [] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("a chain of two fallbacks is followed until one succeeds", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(new Response("too fast", { status: 429 })),
      anthropic: () => Promise.resolve(new Response("also busy", { status: 429 })),
      openrouter: () => Promise.resolve(openaiCompletion("chatcmpl-or")),
    });
    const result = await chatWithFallback(registry, "openai", { model: "gpt-4o", messages: [] });
    expect(result.id).toBe("chatcmpl-or");
  });

  test("all providers failing propagates the last error", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(new Response("a", { status: 429 })),
      anthropic: () => Promise.resolve(new Response("b", { status: 502 })),
      openrouter: () => Promise.resolve(new Response("c", { status: 503 })),
    });
    await expect(
      chatWithFallback(registry, "openai", { model: "gpt-4o", messages: [] }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test("no fallback configured propagates the primary error untouched", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(new Response("quota", { status: 429 })),
      openrouter: () => Promise.resolve(new Response("quota", { status: 429 })),
    });
    // openrouter is the chain tail: no fallback link stored
    const openrouter = registry.get("openrouter");
    expect(openrouter?.fallbackId).toBeNull();
    await expect(
      chatWithFallback(registry, "openrouter", { model: "deepseek-x", messages: [] }),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe("chatStreamWithFallback — streaming fallback without duplicating tokens", () => {
  test("HTTP failure before any content streams the fallback cleanly", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(new Response("busy", { status: 429 })),
      anthropic: () => Promise.resolve(anthropicSse("from claude")),
    });

    const seen: string[] = [];
    for await (const payload of chatStreamWithFallback(
      registry,
      "openai",
      { model: "gpt-4o", messages: [] },
      new AbortController().signal,
    )) {
      seen.push((JSON.parse(payload) as { choices: Array<{ delta: { content?: string } }> }).choices[0].delta.content ?? "");
    }
    // Anthropic translation: role chunk (released at commit), text delta, terminal
    expect(seen).toEqual(["", "from claude", ""]);
  });

  test("failure AFTER content was emitted does NOT trigger fallback (no duplicates)", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(brokenAfter([contentChunk("partial")], new Error("upstream died mid-stream"))),
      anthropic: () => Promise.resolve(anthropicSse("FALLBACK MUST NOT RUN")),
    });

    const seen: string[] = [];
    let threw = false;
    try {
      for await (const payload of chatStreamWithFallback(
        registry,
        "openai",
        { model: "gpt-4o", messages: [] },
        new AbortController().signal,
      )) {
        seen.push((JSON.parse(payload) as { choices: Array<{ delta: { content?: string } }> }).choices[0].delta.content ?? "");
      }
    } catch {
      threw = true;
    }
    expect(seen).toEqual(["partial"]);
    expect(threw).toBe(true);
  });

  test("failure after only a role prefix chunk (no content) falls back without echoing the prefix", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(brokenAfter([roleChunk], new Error("died before content"))),
      anthropic: () => Promise.resolve(anthropicSse("claude only")),
    });

    const seen: string[] = [];
    for await (const payload of chatStreamWithFallback(
      registry,
      "openai",
      { model: "gpt-4o", messages: [] },
      new AbortController().signal,
    )) {
      seen.push((JSON.parse(payload) as { choices: Array<{ delta: { content?: string } }> }).choices[0].delta.content ?? "");
    }
    // role chunk released at commit + translated text + terminal
    expect(seen).toEqual(["", "claude only", ""]);
  });

  test("a healthy stream passes through untouched", async () => {
    const { registry } = await makeRegistry({
      openai: () => Promise.resolve(rawSse([contentChunk("hi"), contentChunk(" there"), doneChunk])),
      anthropic: () => Promise.resolve(anthropicSse("NO")),
    });

    const seen: string[] = [];
    for await (const payload of chatStreamWithFallback(
      registry,
      "openai",
      { model: "gpt-4o", messages: [] },
      new AbortController().signal,
    )) {
      seen.push((JSON.parse(payload) as { choices: Array<{ delta: { content?: string } }> }).choices[0].delta.content ?? "");
    }
    expect(seen).toEqual(["hi", " there"]);
  });
});