/**
 * Embeddings bindings (embeddings-rag spec).
 *
 * `makeLlamaEmbedder` exposes the managed llama-server's OpenAI-compatible
 * `/v1/embeddings` endpoint behind a narrow `Embedder` seam — the same shape
 * remote OpenAI-compatible servers speak, so a remote embedder can swap in
 * later without touching the RAG layer.
 */
import type { HttpFetcher } from "./http-core.js";

export interface OpenAIEmbeddingObject {
  object: "embedding";
  embedding: number[];
  index: number;
}

export interface OpenAIEmbeddingResponse {
  object: "list";
  data: OpenAIEmbeddingObject[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/** Embedding seam: one model, one call shape. */
export interface Embedder {
  readonly model: string;
  embed(input: string | string[]): Promise<OpenAIEmbeddingResponse>;
}

export interface LlamaEmbedderOptions {
  /** Resolved lazily (the managed backend's base URL moves across restarts). */
  baseUrl: () => string;
  /** Model id the backend serves embeddings with. */
  model: string;
  /** INJECTED fetcher for tests (default: global fetch). */
  fetcher?: HttpFetcher;
}

/** Estimate prompt tokens as ~4 chars/token; used when usage is absent. */
export function estimatePromptTokens(texts: string[]): number {
  return texts.reduce((acc, t) => acc + Math.max(1, Math.ceil(t.length / 4)), 0);
}

/** Pure shaping: raw vectors → the OpenAI embeddings response contract. */
export function toOpenAIEmbeddings(
  model: string,
  vectors: number[][],
  promptTokens: number,
): OpenAIEmbeddingResponse {
  return {
    object: "list",
    data: vectors.map((embedding, index) => ({ object: "embedding", embedding, index })),
    model,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

function toInputArray(input: string | string[]): string[] {
  return Array.isArray(input) ? input : [input];
}

/** Embedder over the managed llama-server's /v1/embeddings endpoint. */
export function makeLlamaEmbedder(opts: LlamaEmbedderOptions): Embedder {
  const base = () => opts.baseUrl().replace(/\/$/, "");
  const fetcher = opts.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init));

  return {
    model: opts.model,

    async embed(input: string | string[]): Promise<OpenAIEmbeddingResponse> {
      const texts = toInputArray(input);
      const res = await fetcher(`${base()}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`embedding error ${res.status}: ${text.slice(0, 300)}`) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }
      let parsed: { data?: Array<{ embedding?: number[] }> };
      try {
        parsed = JSON.parse(text) as { data?: Array<{ embedding?: number[] }> };
      } catch {
        throw new Error(`embeddings returned invalid JSON: ${text.slice(0, 200)}`);
      }
      const vectors = (parsed.data ?? []).map((d) => d.embedding ?? []);
      return toOpenAIEmbeddings(opts.model, vectors, estimatePromptTokens(texts));
    },
  };
}