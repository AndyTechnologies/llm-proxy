/**
 * RED→GREEN tests for the editor store factory (svelte-ui task 3.1, MINOR-B).
 *
 * The editor store is created through an **injectable factory**: two calls
 * yield two independent stores, so tests always start from a clean state and
 * no module-level singleton leaks between cases. All mutations delegate to
 * the pure `graph-model.ts` port (geometry/guards never live here).
 */
import { describe, it, expect } from "bun:test";
import { createEditorStore } from "./editor-store.js";
import type { EditorDeps } from "./editor-store.js";
import type { GraphState } from "../lib/graph-model.js";

const pipeline = {
  id: "demo",
  name: "Demo",
  // Positions are client-side only (the backend never sends them): layout
  // fills `pos` at render, the store leaves it undefined until a move.
  nodes: [
    { id: "n1", type: "start" as const },
    { id: "n2", type: "llm_call" as const, model: "qwen:7b", prompt: "" },
    { id: "n3", type: "end" as const },
  ],
  edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
};

function deps(overrides: Partial<EditorDeps> = {}): EditorDeps {
  return {
    api: {
      getPipeline: async () => pipeline,
      validate: async () => ({ valid: true }),
      apply: async () => ({}),
    },
    ...overrides,
  };
}

function snapshot(s: GraphState): void {
  void s;
}

describe("editor store (injectable factory)", () => {
  it("returns fresh, isolated stores per factory call", () => {
    const a = createEditorStore(deps());
    const b = createEditorStore(deps());
    expect(a).not.toBe(b);

    a.subscribe((s) => expect(s.nodes).toHaveLength(0))();
    b.subscribe((s) => expect(s.nodes).toHaveLength(0))();

    a.actions.addNode("llm_call");
    const aNodes = a.getSnapshot().nodes;
    expect(aNodes).toHaveLength(1);
    expect(b.getSnapshot().nodes).toHaveLength(0);
    snapshot(aNodes[0] as never);
  });

  it("starts empty with no selection, not dirty, unvalidated", () => {
    const s = createEditorStore(deps()).getSnapshot();
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
    expect(s.selection).toEqual([]);
    expect(s.dirty).toBe(false);
    expect(s.validation).toBeNull();
    expect(s.pipelineId).toBeNull();
  });

  it("loadPipeline populates the graph and clears selection", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    const s = store.getSnapshot();
    expect(s.pipelineId).toBe("demo");
    expect(s.name).toBe("Demo");
    expect(s.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(s.edges).toHaveLength(2);
    expect(s.selection).toEqual([]);
    expect(s.dirty).toBe(false);
  });

  it("addNode appends a fresh node of the given type through the model", () => {
    const store = createEditorStore(deps());
    store.actions.addNode("condition");
    const s = store.getSnapshot();
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]!.type).toBe("condition");
    expect(s.nodes[0]!.id).toMatch(/^node-/);
    expect(s.dirty).toBe(true);
  });

  it("moveNode updates only the target node's position", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.moveNode("n1", 120, 200);
    const s = store.getSnapshot();
    const n1 = s.nodes.find((n) => n.id === "n1")!;
    expect(n1.pos).toEqual({ x: 120, y: 200 });
    // untouched node keeps no position (load never assigns one)
    const n2 = s.nodes.find((n) => n.id === "n2")!;
    expect(n2.pos).toBeUndefined();
  });

  it("deleteNode removes the node and its incident edges", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.deleteNode("n2");
    const s = store.getSnapshot();
    expect(s.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(s.edges).toEqual([]);
    expect(s.selection).toEqual([]);
    expect(s.dirty).toBe(true);
  });

  it("connect adds an edge between two nodes", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.deleteNode("n3");
    store.actions.connect("n2", "n1");
    const s = store.getSnapshot();
    expect(s.edges).toContainEqual({ from: "n2", to: "n1" });
  });

  it("rejects a self-edge (graph-model guard preserved)", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    const before = store.getSnapshot().edges.length;
    store.actions.connect("n1", "n1");
    expect(store.getSnapshot().edges).toHaveLength(before);
  });

  it("select replaces the selection set", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.select(["n1", "n2"]);
    expect(store.getSnapshot().selection).toEqual(["n1", "n2"]);
    store.actions.select(["n9"]);
    expect(store.getSnapshot().selection).toEqual(["n9"]);
    store.actions.select([]);
    expect(store.getSnapshot().selection).toEqual([]);
  });

  it("validate posts the built payload and records the verdict", async () => {
    let posted: unknown = null;
    const store = createEditorStore(
      deps({
        api: {
          ...deps().api,
          validate: async (payload: unknown) => {
            posted = payload;
            return { valid: false, errors: ["Node n2 is incomplete"] };
          },
        },
      }),
    );
    await store.actions.loadPipeline("demo");
    await store.actions.validate();
    expect(posted).not.toBeNull();
    expect(store.getSnapshot().validation).toEqual({
      valid: false,
      errors: ["Node n2 is incomplete"],
    });
  });

  it("apply calls the apply endpoint and surfaces failures", async () => {
    let applied = false;
    const ok = createEditorStore(
      deps({
        api: { ...deps().api, apply: async () => ((applied = true), {}) },
      }),
    );
    await ok.actions.apply();
    expect(applied).toBe(true);
    expect(ok.getSnapshot().applyError).toBeNull();

    const failing = createEditorStore(
      deps({
        api: {
          ...deps().api,
          apply: async () => {
            throw new Error("apply exploded");
          },
        },
      }),
    );
    await failing.actions.apply();
    expect(failing.getSnapshot().applyError).toMatch(/apply exploded/);
  });

  it("reset returns to the pristine initial state", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.addNode("loop");
    store.actions.connect("n1", "n3");
    store.actions.reset();
    const s = store.getSnapshot();
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
    expect(s.selection).toEqual([]);
    expect(s.pipelineId).toBeNull();
    expect(s.dirty).toBe(false);
  });
});