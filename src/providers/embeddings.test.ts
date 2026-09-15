/**
 * Embeddings module tests (embeddings-rag spec).
 *
 * RED-first: `makeLlamaEmbedder` posts to `{base}/v1/embeddings`, normalizes
 * the upstream payload to the OpenAI embeddings wire shape, and the pure
 * shapers (`toOpenAIEmbeddings`, `estimatePromptTokens`) produce a stable
 * response contract.
 */
import { describe, expect, test } from "bun:test";
import type { HttpFetcher } from "./http-core.js";
import {
  estimatePromptTokens,
  makeLlamaEmbedder,
  toOpenAIEmbeddings,
  type LlamaEmbedderOptions,
} from "./embeddings.js";

function fakeFetcher(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): HttpFetcher {
  return async (url: string, init?: RequestInit) => handler(url, init);
}

function makeEmbedder(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return makeLlamaEmbedder({
    baseUrl: () => "http://127.0.0.1:8080",
    model: "local-embed",
    fetcher: fakeFetcher(handler),
  } satisfies LlamaEmbedderOptions);
}

describe("toOpenAIEmbeddings — wire shape", () => {
  test("produces the OpenAI embeddings response contract", () => {
    const res = toOpenAIEmbeddings("m1", [[0.1, 0.2], [0.3, 0.4]], 12);
    expect(res.object).toBe("list");
    expect(res.model).toBe("m1");
    expect(res.usage).toEqual({ prompt_tokens: 12, total_tokens: 12 });
    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toEqual({ object: "embedding", embedding: [0.1, 0.2], index: 0 });
    expect(res.data[1]?.index).toBe(1);
  });

  test("empty vector input yields an empty data list (not an error)", () => {
    const res = toOpenAIEmbeddings("m1", [], 0);
    expect(res.data).toEqual([]);
  });
});

describe("estimatePromptTokens — proxy for upstream token counts", () => {
  test("counts ~4 characters per token per input", () => {
    expect(estimatePromptTokens(["abcdefgh"])).toBe(2); // 8 chars → 2 tokens
    expect(estimatePromptTokens(["a"])).toBe(1); // minimum 1
    expect(estimatePromptTokens(["abcd", "efgh"])).toBe(2);
    expect(estimatePromptTokens([])).toBe(0);
  });
});

describe("makeLlamaEmbedder — HTTP behavior", () => {
  test("posts {model, input} to {baseUrl}/v1/embeddings and normalizes the reply", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const embedder = makeEmbedder(async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        data: [
          { embedding: [1.0, 2.0], index: 0 },
          { embedding: [3.0, 4.0], index: 1 },
        ],
      });
    });
    const res = await embedder.embed(["hello", "world"]);
    expect(seenUrl).toBe("http://127.0.0.1:8080/v1/embeddings");
    expect(seenBody).toEqual({ model: "local-embed", input: ["hello", "world"] });
    expect(res.object).toBe("list");
    expect(res.data[0]?.object).toBe("embedding");
    expect(res.data[0]?.embedding).toEqual([1.0, 2.0]);
    expect(res.data[1]?.embedding).toEqual([3.0, 4.0]);
  });

  test("accepts a single string by wrapping it in an array", async () => {
    let seenBody: Record<string, unknown> = {};
    const embedder = makeEmbedder(async (_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: [{ embedding: [0.5], index: 0 }] });
    });
    const res = await embedder.embed("solo");
    expect(seenBody.input).toEqual(["solo"]);
    expect(res.data).toHaveLength(1);
  });

  test("upstream error status propagates on the thrown Error", async () => {
    const embedder = makeEmbedder(async () => new Response("nope", { status: 429 }));
    try {
      await embedder.embed("x");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(429);
      expect((err as Error).message).toContain("429");
    }
  });

  test("trailing slash on baseUrl does not double the path", async () => {
    let seenUrl = "";
    const embedder = makeLlamaEmbedder({
      baseUrl: () => "http://127.0.0.1:8080/",
      model: "local-embed",
      fetcher: fakeFetcher(async (url) => {
        seenUrl = url;
        return Response.json({ data: [] });
      }),
    });
    await embedder.embed("x");
    expect(seenUrl).toBe("http://127.0.0.1:8080/v1/embeddings");
  });
});