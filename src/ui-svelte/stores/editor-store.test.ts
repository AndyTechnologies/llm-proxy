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
    expect(s.canUndo).toBe(false);
  });
});

describe("editor store undo/redo (task 3.5)", () => {
  it("starts with empty stacks and no undo/redo available", () => {
    const store = createEditorStore(deps());
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().canRedo).toBe(false);
  });

  it("records mutations and undoes/redoes them in reverse order", () => {
    const store = createEditorStore(deps());
    store.actions.addNode("llm_call");
    const firstId = store.getSnapshot().nodes[0]!.id;
    store.actions.addNode("end");

    store.actions.undo();
    expect(store.getSnapshot().nodes.map((n) => n.id)).toEqual([firstId]);
    expect(store.getSnapshot().canRedo).toBe(true);

    store.actions.redo();
    expect(store.getSnapshot().nodes.map((n) => n.id)).toEqual([firstId, store.getSnapshot().nodes[1]!.id]);
    expect(store.getSnapshot().nodes[1]!.type).toBe("end");
    expect(store.getSnapshot().canUndo).toBe(true);
  });

  it("spec: undo restores a deleted node and its edges; redo reapplies the deletion", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.deleteNode("n2");
    expect(store.getSnapshot().edges).toEqual([]);

    store.actions.undo();
    const restored = store.getSnapshot();
    expect(restored.nodes.some((n) => n.id === "n2")).toBe(true);
    expect(restored.nodes).toHaveLength(3);
    expect(restored.edges).toEqual(pipeline.edges);

    store.actions.redo();
    const reapplied = store.getSnapshot();
    expect(reapplied.nodes.some((n) => n.id === "n2")).toBe(false);
    expect(reapplied.nodes).toHaveLength(2);
    expect(reapplied.edges).toEqual([]);
  });

  it("undo of a move restores the previous position (one entry per drag)", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.moveNode("n1", 400, 300);
    store.actions.undo();
    const n1 = store.getSnapshot().nodes.find((n) => n.id === "n1");
    expect(n1?.pos).toBeUndefined();
  });

  it("selection changes are NOT recorded in history", async () => {
    const store = createEditorStore(deps());
    await store.actions.loadPipeline("demo");
    store.actions.select(["n2"]);
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().selection).toEqual(["n2"]);
  });

  it("loadPipeline and reset clear the history", async () => {
    const store = createEditorStore(deps());
    store.actions.addNode("condition");
    expect(store.getSnapshot().canUndo).toBe(true);

    await store.actions.loadPipeline("demo");
    expect(store.getSnapshot().canUndo).toBe(false);

    store.actions.addNode("start");
    expect(store.getSnapshot().canUndo).toBe(true);
    store.actions.reset();
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().nodes).toEqual([]);
  });
});

describe("editor store interactions (task 3.4)", () => {
  it("addNode with a position places the node there in one history entry", () => {
    const store = createEditorStore(deps());
    store.actions.addNode("llm_call", { x: 320, y: 180 });
    const s = store.getSnapshot();
    expect(s.nodes[0]!.pos).toEqual({ x: 320, y: 180 });
    expect(s.dirty).toBe(true);
    store.actions.undo();
    expect(store.getSnapshot().nodes).toEqual([]);
  });

  it("a drag transaction (beginMove…endMove) records ONE history entry", () => {
    const store = createEditorStore(deps());
    store.actions.addNode("llm_call");
    const id = store.getSnapshot().nodes[0]!.id;
    // simulate a pointer drag: begin, then many per-frame moves, then end
    store.actions.beginMove();
    store.actions.moveNode(id, 10, 10);
    store.actions.moveNode(id, 20, 20);
    store.actions.moveNode(id, 30, 30);
    store.actions.endMove();
    const moved = store.getSnapshot().nodes[0]!;
    expect(moved.pos).toEqual({ x: 30, y: 30 });
    expect(store.getSnapshot().canUndo).toBe(true);

    // ONE undo → back before the drag started (no intermediate frames)
    store.actions.undo();
    expect(store.getSnapshot().nodes[0]!.pos).toBeUndefined();
    expect(store.getSnapshot().canRedo).toBe(true);

    // ONE redo → the final drag position, not a mid-drag frame
    store.actions.redo();
    expect(store.getSnapshot().nodes[0]!.pos).toEqual({ x: 30, y: 30 });
  });

  it("ending a drag without moves records nothing", () => {
    const store = createEditorStore(deps());
    store.actions.addNode("llm_call");
    store.actions.beginMove();
    store.actions.endMove();
    expect(store.getSnapshot().canUndo).toBe(true); // only the addNode entry
    store.actions.undo();
    expect(store.getSnapshot().nodes).toEqual([]);
  });

  it("reorderLoopMember moves a member up/down and is undoable", async () => {
    // load a graph whose loop already has an ordered body
    const loopPipeline = {
      id: "demo",
      name: "Demo",
      nodes: [
        { id: "loop", type: "loop" as const, body: ["m1", "m2", "m3"] },
        { id: "m1", type: "llm_call" as const, model: "a", prompt: "" },
        { id: "m2", type: "llm_call" as const, model: "b", prompt: "" },
        { id: "m3", type: "llm_call" as const, model: "c", prompt: "" },
      ],
      edges: [],
    };
    const store2 = createEditorStore(deps({ api: { ...deps().api, getPipeline: async () => loopPipeline } }));
    await store2.actions.loadPipeline("demo");
    store2.actions.reorderLoopMember("loop", "m2", -1);
    expect(store2.getSnapshot().nodes.find((n) => n.id === "loop")!.body).toEqual(["m2", "m1", "m3"]);
    expect(store2.getSnapshot().dirty).toBe(true);

    store2.actions.undo();
    expect(store2.getSnapshot().nodes.find((n) => n.id === "loop")!.body).toEqual(["m1", "m2", "m3"]);
  });

  /** A loop at (0,0) with an empty body: its container covers
   *  x∈[−18,98], y∈[0,110], so a node added/moved to (40,40) — center
   *  (80,68) — lands inside and must be bucketed into the body. */
  const loopPipeline = {
    id: "demo",
    name: "Demo",
    nodes: [{ id: "loop", type: "loop" as const, pos: { x: 0, y: 0 }, body: [] }],
    edges: [],
  };

  it("buckets a positioned addNode that lands inside a loop container", async () => {
    const store = createEditorStore(deps({ api: { ...deps().api, getPipeline: async () => loopPipeline } }));
    await store.actions.loadPipeline("demo");
    store.actions.addNode("llm_call", { x: 40, y: 40 });
    const s = store.getSnapshot();
    const added = s.nodes.find((n) => n.type === "llm_call")!;
    expect(s.nodes.find((n) => n.id === "loop")!.body).toEqual([added.id]);

    // one undo removes the node and the membership together
    store.actions.undo();
    expect(store.getSnapshot().nodes).toHaveLength(1);
    expect(store.getSnapshot().nodes[0]!.id).toBe("loop");
  });

  it("buckets a drag that ends inside a loop container as ONE history entry", async () => {
    const withCall = {
      ...loopPipeline,
      nodes: [
        { id: "loop", type: "loop" as const, pos: { x: 0, y: 0 }, body: [] },
        { id: "n1", type: "llm_call" as const, pos: { x: 400, y: 400 } },
      ],
    };
    const store = createEditorStore(deps({ api: { ...deps().api, getPipeline: async () => withCall } }));
    await store.actions.loadPipeline("demo");
    store.actions.beginMove();
    store.actions.moveNode("n1", 40, 40); // center (80,68) inside the loop
    store.actions.endMove();
    const s = store.getSnapshot();
    expect(s.nodes.find((n) => n.id === "loop")!.body).toEqual(["n1"]);
    expect(s.canUndo).toBe(true);

    store.actions.undo();
    const after = store.getSnapshot();
    expect(after.nodes.find((n) => n.id === "loop")!.body).toEqual([]);
    expect(after.nodes.find((n) => n.id === "n1")!.pos).toEqual({ x: 400, y: 400 });
  });

  it("keeps a member in its loop body when dragged far away (no re-bucket)", async () => {
    const withMember = {
      ...loopPipeline,
      nodes: [
        { id: "loop", type: "loop" as const, pos: { x: 0, y: 0 }, body: ["n1"] },
        { id: "n1", type: "llm_call" as const, pos: { x: 40, y: 40 } },
      ],
    };
    const store = createEditorStore(deps({ api: { ...deps().api, getPipeline: async () => withMember } }));
    await store.actions.loadPipeline("demo");
    store.actions.beginMove();
    store.actions.moveNode("n1", 2000, 2000); // far outside any other container
    store.actions.endMove();
    expect(store.getSnapshot().nodes.find((n) => n.id === "loop")!.body).toEqual(["n1"]);

    // the move itself must still be undoable as a single entry
    store.actions.undo();
    expect(store.getSnapshot().nodes.find((n) => n.id === "n1")!.pos).toEqual({ x: 40, y: 40 });
  });

  it("reorderLoopMember ignores unknown loops/members and boundary moves", async () => {
    const loopPipeline = {
      id: "demo",
      name: "Demo",
      nodes: [
        { id: "loop", type: "loop" as const, body: ["m1", "m2"] },
        { id: "m1", type: "llm_call" as const, model: "a", prompt: "" },
        { id: "m2", type: "llm_call" as const, model: "b", prompt: "" },
      ],
      edges: [],
    };
    const store = createEditorStore(deps({ api: { ...deps().api, getPipeline: async () => loopPipeline } }));
    await store.actions.loadPipeline("demo");
    expect(store.getSnapshot().canUndo).toBe(false);
    store.actions.reorderLoopMember("ghost", "m1", -1);
    store.actions.reorderLoopMember("loop", "ghost", -1);
    store.actions.reorderLoopMember("loop", "m1", -1); // first member: no-op up
    store.actions.reorderLoopMember("loop", "m2", 1); // last member: no-op down
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().nodes.find((n) => n.id === "loop")!.body).toEqual(["m1", "m2"]);
  });
});