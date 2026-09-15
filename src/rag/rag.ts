/**
 * rag_local node (embeddings-rag spec).
 *
 * Composes the RAG pipeline for one query: embed the query → retrieve top-k
 * chunks → assemble a context prompt → answer. When retrieval comes back
 * empty the system prompt carries an explicit no-context notice instead of
 * silently hallucinating grounded answers.
 */
import type { ChunkRecord } from "./chunks.js";

export interface RagChunkRef {
  doc: string;
  text: string;
  score: number;
}

export interface RagMessage {
  role: string;
  content: string;
}

export interface RagDeps {
  /** Embed the query text. */
  embed: (text: string) => Promise<Float32Array>;
  /** Top-k retrieval over the chunk store. */
  retrieve: (vector: Float32Array, k: number) => Promise<RagChunkRef[]>;
  /** LLM call (already wired to the chain's provider/model). */
  generate: (messages: RagMessage[], signal?: AbortSignal) => Promise<string>;
  /** Context window size (default 4). */
  k?: number;
}

export interface RagPrompt {
  system: string;
  user: string;
  noContext: boolean;
}

export interface RagOutcome {
  answer: string;
  sources: RagChunkRef[];
  noContext: boolean;
  /** The system prompt used (traceability for verify + debugging). */
  prompt: string;
}

const NO_CONTEXT_NOTICE =
  "No relevant context was found for this query. State that clearly, then answer " +
  "from general knowledge — never invent citations.";

/** Assemble the system/user prompt pair; empty context is an explicit case. */
export function buildRagPrompt(query: string, chunks: RagChunkRef[]): RagPrompt {
  if (chunks.length === 0) {
    return { system: NO_CONTEXT_NOTICE, user: query, noContext: true };
  }
  const sources = chunks
    .map((c, i) => `[${i + 1}] (${c.doc}) ${c.text}`)
    .join("\n");
  const system =
    `Answer the user's question using ONLY the retrieved context below. ` +
    `Cite the source of each claim as [n].\n\nContext:\n${sources}`;
  return { system, user: query, noContext: false };
}

/** Run one rag_local query end-to-end. */
export async function runRagLocal(query: string, deps: RagDeps): Promise<RagOutcome> {
  const k = deps.k ?? 4;
  const vector = await deps.embed(query);
  const chunks = await deps.retrieve(vector, k);
  const { system, user, noContext } = buildRagPrompt(query, chunks);
  const messages: RagMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const answer = await deps.generate(messages);
  return { answer, sources: chunks, noContext, prompt: system };
}

export type { ChunkRecord };