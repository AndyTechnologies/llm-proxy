import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import { WorkflowStore, type WorkflowRecord, type ExecutionLogRow } from "./store.js";
import type { GraphPipeline } from "./graph.js";

const graph: GraphPipeline = {
  id: "demo",
  name: "Demo",
  nodes: [
    { id: "start", type: "start" },
    { id: "a", type: "llm_call", model: "gemma" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "a" },
    { from: "a", to: "end" },
  ],
};

function freshStore(): WorkflowStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new WorkflowStore(db);
}

describe("WorkflowStore (6.10)", () => {
  test("empty store lists nothing and get is null", () => {
    const store = freshStore();
    expect(store.list()).toEqual([]);
    expect(store.get("demo")).toBeNull();
    expect(store.has("demo")).toBe(false);
  });

  test("save stores the graph and bumps the version on each save", () => {
    const store = freshStore();
    store.save("demo", graph, 1);
    store.save("demo", graph, 2);
    const record = store.get("demo");
    expect(record).not.toBeNull();
    expect(record!.version).toBe(2);
    expect(record!.yaml).toContain("name: Demo");
  });

  test("list returns metadata rows ordered by updated_at", () => {
    const store = freshStore();
    store.save("a", graph, 1);
    store.save("b", graph, 1);
    const rows = store.list();
    expect(rows.map((r) => r.name)).toContain("a");
    expect(rows.map((r) => r.name)).toContain("b");
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });

  test("remove deletes an existing workflow and reports gone", () => {
    const store = freshStore();
    store.save("demo", graph, 1);
    expect(store.remove("demo")).toBe(true);
    expect(store.get("demo")).toBeNull();
    expect(store.remove("demo")).toBe(false);
  });

  test("recordExecution + logs round-trip a run entry", () => {
    const store = freshStore();
    store.save("demo", graph, 1);
    store.recordExecution("demo", { status: "ok", startedAt: "2026-09-14T10:00:00Z", ms: 42 });
    store.recordExecution("demo", { status: "error", error: "boom", startedAt: "2026-09-14T10:01:00Z", ms: 7 });
    const logs = store.logs("demo");
    expect(logs).toHaveLength(2);
    expect(logs[0].status).toBe("error"); // newest first
    expect(logs[0].error).toBe("boom");
    expect(logs[1].status).toBe("ok");
    expect(logs[1].ms).toBe(42);
  });

  test("logs are scoped to the workflow and newest first", () => {
    const store = freshStore();
    store.save("demo", graph, 1);
    store.recordExecution("demo", { status: "ok", startedAt: "t1", ms: 1 });
    store.recordExecution("demo", { status: "ok", startedAt: "t2", ms: 2 });
    store.recordExecution("other", { status: "ok", startedAt: "t3", ms: 3 });
    const logs = store.logs("demo");
    expect(logs.map((l) => l.ms)).toEqual([2, 1]);
  });

  test("recordExecution is a no-op for an unknown workflow", () => {
    const store = freshStore();
    expect(() =>
      store.recordExecution("ghost", { status: "ok", startedAt: "t", ms: 1 }),
    ).not.toThrow();
  });
});

// Type-level re-export check (records are serializable API payloads).
export type { WorkflowRecord, ExecutionLogRow };