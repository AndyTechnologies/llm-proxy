/**
 * rag_local node tests (embeddings-rag spec).
 *
 * RED-first: embed → retrieve → prompt → answer, with an explicit
 * no-context notice when the store has nothing relevant.
 */
import { describe, expect, test } from "bun:test";
import { buildRagPrompt, runRagLocal, type RagChunkRef, type RagDeps } from "./rag.js";

const chunk = (doc: string, text: string, score: number): RagChunkRef => ({ doc, text, score });

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe("buildRagPrompt — context assembly", () => {
  test("no retrieved chunks → explicit no-context notice, query preserved", () => {
    const p = buildRagPrompt("what is the sky?", []);
    expect(p.noContext).toBe(true);
    expect(p.user).toBe("what is the sky?");
    expect(p.system.toLowerCase()).toContain("no relevant context");
  });

  test("retrieved chunks are numbered with their source doc", () => {
    const p = buildRagPrompt("hello", [
      chunk("guide-a", "the sky is blue", 0.9),
      chunk("guide-b", "birds fly", 0.7),
    ]);
    expect(p.noContext).toBe(false);
    expect(p.system).toContain("[1]");
    expect(p.system).toContain("(guide-a)");
    expect(p.system).toContain("the sky is blue");
    expect(p.system).toContain("(guide-b)");
    expect(p.system).toContain("birds fly");
  });
});

describe("runRagLocal — embed → retrieve → prompt → answer", () => {
  function makeDeps(overrides: Partial<RagDeps> = {}): {
    deps: RagDeps;
    calls: { messages: Array<{ role: string; content: string }> }[];
  } {
    const calls: { messages: Array<{ role: string; content: string }> }[] = [];
    const deps: RagDeps = {
      embed: async (text: string) => vec(text.length, 0),
      retrieve: async () => [chunk("doc", "context text", 0.8)],
      generate: async (messages) => {
        calls.push({ messages });
        return "answer-text";
      },
      ...overrides,
    };
    return { deps, calls };
  }

  test("full flow: retrieved context lands in the system prompt, answer returned", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await runRagLocal("my query", deps);
    expect(outcome.answer).toBe("answer-text");
    expect(outcome.noContext).toBe(false);
    expect(outcome.sources).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages[0]?.role).toBe("system");
    expect(calls[0]?.messages[0]?.content).toContain("context text");
    expect(calls[0]?.messages[1]).toEqual({ role: "user", content: "my query" });
  });

  test("empty retrieval → no-context notice + answer still produced", async () => {
    const { deps, calls } = makeDeps({ retrieve: async () => [] });
    const outcome = await runRagLocal("orphan query", deps);
    expect(outcome.noContext).toBe(true);
    expect(outcome.sources).toEqual([]);
    expect(outcome.answer).toBe("answer-text");
    expect(calls[0]?.messages[0]?.content.toLowerCase()).toContain("no relevant context");
  });

  test("retrieve receives the query embedding and the configured k", async () => {
    let seen: { vector: Float32Array; k: number } | null = null;
    const { deps } = makeDeps({
      k: 2,
      retrieve: async (vector, k) => {
        seen = { vector, k };
        return [];
      },
    });
    await runRagLocal("test", deps);
    // widen past TS's closure-narrowing of `seen` back to the declared union
    const captured = seen as { vector: Float32Array; k: number } | null;
    expect(captured?.k).toBe(2);
    expect(Array.from(captured?.vector ?? new Float32Array())).toEqual([4, 0]);
  });
});