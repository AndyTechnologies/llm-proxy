import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import { SecretStore, type KeychainBackend } from "../secrets/keychain.js";
import { buildProviderRegistry, type ProviderRegistry } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import type { Embedder } from "../providers/embeddings.js";
import { makeV1Handler } from "./v1.js";
import type { WorkflowRunner, ChainCompletion } from "../orchestrator/runner.js";

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

async function makeHarness(fetchers: Record<string, Fetcher>, embeddings?: () => Embedder | null) {
  const db = new Database(":memory:");
  applySchema(db);
  db.query(
    "INSERT INTO providers (kind, base_url, fallback_id) VALUES ('openai', NULL, 'anthropic'), ('anthropic', NULL, NULL)",
  ).run();
  db.query(
    "INSERT INTO models (id, source, name, url, state) VALUES ('gpt-4o','openai','','','ready'), ('claude-x','anthropic','','','ready')",
  ).run();
  const store = new SecretStore(db, memoryBackend());
  for (const kind of ["openai", "anthropic"]) {
    await store.set(`provider:${kind}`, `sk-${kind}`);
  }
  const registry: ProviderRegistry = await buildProviderRegistry({
    db,
    store,
    fetcher: (url, init) => {
      const kind = url.includes("api.openai.com") ? "openai" : "anthropic";
      if (fetchers[kind] === undefined) {
        throw new Error(`no fake upstream for ${kind}`);
      }
      return fetchers[kind](url, init);
    },
  });

  const localModels = ["tiny-local"];
  const localProvider: Provider = {
    name: "local",
    async chat(_request) {
      return {
        id: "local-1",
        object: "chat.completion",
        created: 1,
        model: "tiny-local",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "local says hi" },
            finish_reason: "stop",
          },
        ],
      };
    },
    async *chatStream(_request, signal) {
      void signal;
      yield JSON.stringify({
        id: "local-s",
        choices: [{ index: 0, delta: { content: "local" }, finish_reason: null }],
      });
    },
  };

  const handler = makeV1Handler({
    registry,
    localProvider: () => localProvider,
    localModels: () => localModels,
    virtualModels: () => ["gateway/orchestrator"],
    embeddings,
  });
  return { handler, registry };
}

function openaiCompletion(content: string, model = "gpt-4o") {
  return Response.json(
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    },
    { status: 200 },
  );
}

function anthropicMessage(text: string) {
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

const sseChunk = (content: string) =>
  `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

function sseBody(text: string): Response {
  return new Response(`${sseChunk(text)}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("makeV1Handler — OpenAI-compatible /v1 surface", () => {
  test("POST /v1/chat/completions routes by model and returns OpenAI JSON", async () => {
    const { handler } = await makeHarness({
      openai: () => Promise.resolve(openaiCompletion("from openai")),
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("from openai");
  });

  test("a model mapped to Anthropic is translated back to OpenAI wire shape", async () => {
    const { handler } = await makeHarness({
      anthropic: () => Promise.resolve(anthropicMessage("from claude")),
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("from claude");
  });

  test("unknown model returns 404 with the unknown-model envelope", async () => {
    const { handler } = await makeHarness({});
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nope-9000", messages: [] }),
      }),
    );
    expect(res!.status).toBe(404);
    const body = (await res!.json()) as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("nope-9000");
  });

  test("non-stream calls apply provider fallback on 429", async () => {
    const { handler } = await makeHarness({
      openai: () => Promise.resolve(new Response("busy", { status: 429 })),
      anthropic: () => Promise.resolve(anthropicMessage("fallback ok")),
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("fallback ok");
  });

  test("local provider models route to the managed backend", async () => {
    const { handler } = await makeHarness({});
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tiny-local", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("local says hi");
  });

  test("invalid JSON body returns 400 invalid_request_error", async () => {
    const { handler } = await makeHarness({});
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("streaming chat relays OpenAI-wire SSE ending with exactly one [DONE]", async () => {
    const { handler } = await makeHarness({
      openai: () => Promise.resolve(sseBody("streaming hi")),
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/event-stream");
    const text = await res!.text();
    expect(text).toContain("streaming hi");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(text.split("data: [DONE]").length - 1).toBe(1);
  });

  test("GET /v1/models lists provider, local and virtual models", async () => {
    const { handler } = await makeHarness({
      openai: () => Promise.resolve(openaiCompletion("x")),
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/models", { method: "GET" }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    const ids = body.data.map((m) => m.id).sort();
    expect(ids).toEqual(["claude-x", "gateway/orchestrator", "gpt-4o", "tiny-local"]);
  });

  test("POST /v1/completions wraps the legacy API into a chat call", async () => {
    const { handler } = await makeHarness({
      openai: () => Promise.resolve(openaiCompletion("legacy answer")),
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", prompt: "2+2" }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      object: string;
      choices: Array<{ text: string; finish_reason: string }>;
    };
    expect(body.object).toBe("text_completion");
    expect(body.choices[0].text).toBe("legacy answer");
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  test("streaming /v1/completions relays text-shaped chunks", async () => {
    const { handler } = await makeHarness({
      openai: () => Promise.resolve(sseBody("legacy stream")),
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", prompt: "x", stream: true }),
      }),
    );
    const text = await res!.text();
    // every data frame is a text_completion chunk with a `text` field,
    // and the stream ends with exactly one terminal [DONE]
    const payloads = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    expect(text.split("data: [DONE]").length - 1).toBe(1);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(payloads[0].choices[0].text).toBe("legacy stream");
  });

  test("unknown /v1 paths are declined (null) so the server answers 404", async () => {
    const { handler } = await makeHarness({});
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "x" }),
      }),
    );
    expect(res).toBeNull();
  });

  test("a wired auth gate rejects bad keys with the authentication_error envelope", async () => {
    const { registry } = await makeHarness({});
    const authed = makeV1Handler({
      registry,
      localProvider: () => null,
      localModels: () => [],
      auth: async (req) => req.headers.get("authorization") === "Bearer sk-good",
    });
    const denied = await authed(
      new Request("http://127.0.0.1:4317/v1/models", { method: "GET" }),
    );
    expect(denied!.status).toBe(401);
    const body = (await denied!.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");

    const admitted = await authed(
      new Request("http://127.0.0.1:4317/v1/models", {
        method: "GET",
        headers: { Authorization: "Bearer sk-good" },
      }),
    );
    expect(admitted!.status).toBe(200);
  });
});

describe("makeV1Handler — /v1/embeddings", () => {
  const embedHarness = () =>
    makeHarness({}, () => ({
      model: "local-embed",
      embed: async (_input: string | string[]) => ({
        object: "list" as const,
        data: [
          { object: "embedding" as const, embedding: [1.0], index: 0 },
          { object: "embedding" as const, embedding: [2.0], index: 1 },
        ],
        model: "local-embed",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    }));

  test("embeds a string input into the OpenAI embeddings shape", async () => {
    const { handler } = await embedHarness();
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "local-embed", input: "hi" }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      object: string;
      data: Array<{ object: string; embedding: number[]; index: number }>;
      model: string;
    };
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.object).toBe("embedding");
    expect(body.data[0]?.embedding).toEqual([1.0]);
    expect(body.model).toBe("local-embed");
  });

  test("missing input is a 400 invalid_request_error", async () => {
    const { handler } = await embedHarness();
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "local-embed" }),
      }),
    );
    expect(res!.status).toBe(400);
  });

  test("no embedder configured → 404 model_not_found", async () => {
    const { handler } = await makeHarness({});
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nope", input: "x" }),
      }),
    );
    expect(res!.status).toBe(404);
    const body = (await res!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });

  test("non-string array entries are rejected with 400", async () => {
    const { handler } = await embedHarness();
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "local-embed", input: [1, 2] }),
      }),
    );
    expect(res!.status).toBe(400);
  });
});
// ── Chain routing (6.6): gateway/<name> + X-Chain-ID ───────────────────────

function fakeChainRunner(): WorkflowRunner {
  const completion: ChainCompletion = {
    id: "chatcmpl-chain",
    object: "chat.completion",
    created: 1,
    model: "gateway/orchestrator",
    choices: [
      { index: 0, message: { role: "assistant", content: "chain says hi" }, finish_reason: "stop" },
    ],
    usage: null,
  };
  return {
    ids: () => ["orchestrator"],
    run: async (name) =>
      name === "orchestrator"
        ? { ok: true, output: completion }
        : { ok: false, status: 404, error: "model_not_found" },
  };
}

async function chainHarness(runner: WorkflowRunner = fakeChainRunner()) {
  const base = await makeHarness({});
  const handler = makeV1Handler({
    registry: base.registry,
    localProvider: () => null,
    localModels: () => [],
    chainRunner: runner,
  });
  return { handler };
}

describe("v1 chain routing (6.6)", () => {
  test("gateway/<name> runs the workflow and returns the completion", async () => {
    const { handler } = await chainHarness();
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gateway/orchestrator", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.model).toBe("gateway/orchestrator");
    expect(body.choices[0].message.content).toBe("chain says hi");
  });

  test("X-Chain-ID header wins over the model id", async () => {
    const { handler } = await chainHarness();
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Chain-ID": "orchestrator" },
        body: JSON.stringify({ model: "some-other-model", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as { model: string }).model).toBe("gateway/orchestrator");
  });

  test("a streamed chain emits one chunk then exactly one [DONE]", async () => {
    const { handler } = await chainHarness();
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gateway/orchestrator", stream: true, messages: [] }),
      }),
    );
    const text = await res!.text();
    expect(text).toContain("chain says hi");
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).toContain("chat.completion.chunk");
  });

  test("an unknown gateway name is the unknown-model 404", async () => {
    const { handler } = await chainHarness();
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gateway/ghost", messages: [] }),
      }),
    );
    expect(res!.status).toBe(404);
  });

  test("gateway models without a runner configured are 404 too", async () => {
    const base = await makeHarness({});
    const handler = makeV1Handler({
      registry: base.registry,
      localProvider: () => null,
      localModels: () => [],
    });
    const res = await handler(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gateway/orchestrator", messages: [] }),
      }),
    );
    expect(res!.status).toBe(404);
  });

  test("/v1/models advertises gateway workflow models from the runner", async () => {
    const { handler } = await chainHarness();
    const res = await handler(new Request("http://127.0.0.1:4317/v1/models"));
    const body = (await res!.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((m) => m.id === "gateway/orchestrator")).toBe(true);
  });
});
