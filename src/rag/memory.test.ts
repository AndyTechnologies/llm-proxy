/**
 * Memory store tests (embeddings-rag spec).
 *
 * RED-first: the `memory` workflow node reads prior conversation turns from
 * the `kv_memory` table and injects them into the next LLM call.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import { buildMemoryMessages, MemoryStore, type MemoryTurn } from "./memory.js";

function makeStore(): MemoryStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new MemoryStore(db);
}

describe("MemoryStore — kv_memory persistence", () => {
  test("empty conversation has no turns", () => {
    const store = makeStore();
    expect(store.recent("c1")).toEqual([]);
    expect(store.count("c1")).toBe(0);
  });

  test("recorded turns come back chronologically (oldest first)", () => {
    const store = makeStore();
    store.record("c1", "user", "first");
    store.record("c1", "assistant", "second");
    const turns = store.recent("c1");
    expect(turns.map((t) => t.content)).toEqual(["first", "second"]);
    expect(turns[0]).toMatchObject({ role: "user", content: "first" });
    expect(typeof turns[0]?.ts).toBe("string");
  });

  test("recent(limit) returns only the last `limit` turns, still chronological", () => {
    const store = makeStore();
    for (let i = 1; i <= 15; i++) store.record("c1", "user", `m${i}`);
    const turns = store.recent("c1", 5);
    expect(turns).toHaveLength(5);
    expect(turns.map((t) => t.content)).toEqual(["m11", "m12", "m13", "m14", "m15"]);
  });

  test("conversations are isolated by conv_id", () => {
    const store = makeStore();
    store.record("a", "user", "only-a");
    store.record("b", "user", "only-b");
    expect(store.recent("a").map((t) => t.content)).toEqual(["only-a"]);
    expect(store.recent("b").map((t) => t.content)).toEqual(["only-b"]);
    expect(store.count("a")).toBe(1);
  });

  test("clear removes every turn for a conversation", () => {
    const store = makeStore();
    store.record("c1", "user", "x");
    store.record("c1", "assistant", "y");
    store.clear("c1");
    expect(store.recent("c1")).toEqual([]);
    expect(store.count("c1")).toBe(0);
  });
});

describe("buildMemoryMessages — injection into the next call", () => {
  const history: MemoryTurn[] = [
    { role: "user", content: "remember this", ts: "2026-01-01 00:00:00" },
    { role: "assistant", content: "noted", ts: "2026-01-01 00:00:01" },
  ];

  test("prepends memory turns before the current messages", () => {
    const msgs = buildMemoryMessages(history, [{ role: "user", content: "now what?" }]);
    expect(msgs).toEqual([
      { role: "user", content: "remember this" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "now what?" },
    ]);
  });

  test("memory turns lose their timestamp (clean {role, content})", () => {
    const msgs = buildMemoryMessages(history, []);
    expect(msgs[0]).not.toHaveProperty("ts");
  });

  test("empty history leaves the current messages untouched", () => {
    const current = [{ role: "user", content: "hello" }];
    expect(buildMemoryMessages([], current)).toEqual(current);
  });

  test("empty-content memory turns are skipped", () => {
    const msgs = buildMemoryMessages(
      [{ role: "user", content: "", ts: "x" }],
      [{ role: "user", content: "hi" }],
    );
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  });
});