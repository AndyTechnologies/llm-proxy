/**
 * Editor store factory (svelte-ui task 3.1, MINOR-B; history in 3.5).
 *
 * Created via an **injectable factory** — never a module singleton — so every
 * test and every view instance gets a fresh store with no hidden cross-state.
 * All mutations delegate to the pure `graph-model.ts` port; geometry and
 * connection guards never live in this module.
 *
 * History (task 3.5): every graph mutation (add/move/delete/connect) flows
 * through the bounded `createHistory` buffer — the store state and the
 * history present are updated together, so undo/redo restore exact
 * pre/post-mutation snapshots. Selection changes and load/reset never record
 * history entries (load/reset clear the stacks).
 */
import { writable, get } from "svelte/store";
import {
  createNode,
  moveNode as modelMoveNode,
  connectNodes,
  deleteNode as modelDeleteNode,
  addLoopMemberNode,
  removeLoopMemberNode as modelRemoveLoopMember,
  buildPayload,
  type GraphNode,
  type GraphEdge,
  type GraphState,
  type NodeType,
  type Point,
} from "../lib/graph-model.js";
import { reorderLoopMember as modelReorderMember, bucketDroppedNode } from "../lib/editor-geometry.js";
import { createHistory } from "../lib/history.js";

/** Backend access the editor store needs (injected, faked in tests). */
export interface EditorApi {
  getPipeline(id: string): Promise<{ id: string; name: string | null; nodes: GraphNode[]; edges: GraphEdge[] }>;
  validate(
    payload: { nodes: GraphNode[]; edges: GraphEdge[] },
    pipelineId?: string,
  ): Promise<{
    valid: boolean;
    errors?: string[];
  }>;
  apply(config?: unknown): Promise<unknown>;
}

export interface EditorValidation {
  valid: boolean;
  errors?: string[];
}

export interface EditorState extends GraphState {
  pipelineId: string | null;
  name: string | null;
  selection: string[];
  dirty: boolean;
  loading: boolean;
  validation: EditorValidation | null;
  applyError: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface EditorActions {
  loadPipeline(id: string): Promise<void>;
  addNode(type: NodeType, pos?: Point): void;
  /** Create an llm_call member and add it to the given loop's body directly
   *  (does not depend on positional bucketing — robust even when the loop's
   *  position is only materialized at render time). */
  addLoopMember(loopId: string, pos: Point): void;
  moveNode(id: string, x: number, y: number): void;
  deleteNode(id: string): void;
  connect(from: string, to: string, guard?: string): void;
  reorderLoopMember(loopId: string, memberId: string, dir: -1 | 1): void;
  /** Inspector field edit — merge a partial patch, mark dirty, NO history. */
  updateNode(id: string, patch: Partial<GraphNode>): void;
  /** Drop a member from a loop body (the member NODE stays in the graph). */
  removeLoopMember(loopId: string, memberId: string): void;
  /** Set (or clear, with an empty value) the guard on the outgoing edge. */
  setEdgeGuard(from: string, guard: string | null): void;
  rename(name: string | null): void;
  select(ids: string[]): void;
  beginMove(): void;
  endMove(): void;
  undo(): void;
  redo(): void;
  validate(): Promise<void>;
  apply(): Promise<unknown>;
  reset(): void;
}

export interface EditorDeps {
  api: EditorApi;
}

export interface EditorStore {
  subscribe: (run: (value: EditorState) => void) => () => void;
  getSnapshot(): EditorState;
  actions: EditorActions;
}

const INITIAL: EditorState = {
  pipelineId: null,
  name: null,
  nodes: [],
  edges: [],
  selection: [],
  dirty: false,
  loading: false,
  validation: null,
  applyError: null,
  canUndo: false,
  canRedo: false,
};

/** Monotonic id source for freshly added nodes (per-store counter not needed:
 * ids only need to be unique within one graph session). */
let nodeCounter = 0;

export function createEditorStore(deps: EditorDeps): EditorStore {
  const store = writable<EditorState>({ ...INITIAL });
  const history = createHistory<EditorState>({ ...INITIAL });
  /** Open drag transaction: per-frame moveNode calls patch without recording;
   * endMove commits ONE history entry so a whole drag undoes as a unit. */
  let dragOpen = false;
  let dragMoved = false;
  /** Node being dragged; endMove buckets it into whatever loop container its
   * final position lands in (legacy bucketDroppedNode semantics). */
  let dragId: string | null = null;

  /** Commit `next` through the history buffer so undo/redo can restore it.
   * The store state and the history present always move together. */
  function commit(next: EditorState): void {
    history.push(next);
    store.set({ ...next, canUndo: history.canUndo, canRedo: history.canRedo });
  }

  /** Apply a pure mutation over the current state through the history. The
   * model returns the same array reference for no-ops (unknown ids, boundary
   * moves, self-edges), so those never record a history entry. */
  function mutate(fn: (s: EditorState) => EditorState): void {
    const current = get(store);
    const next = fn(current);
    if (next.nodes === current.nodes && next.edges === current.edges) return;
    commit(next);
  }

  /** Non-recorded state change (selection, validation, load flags). */
  function patch(fn: (s: EditorState) => EditorState): void {
    store.update((s) => ({ ...fn(s), canUndo: history.canUndo, canRedo: history.canRedo }));
  }

  /** Drop keys whose value is `undefined` (mirrors the legacy `delete n[k]`
   * semantics: an undefined patch value clears the field instead of leaving
   * an empty key behind). */
  function dropUndefined<T extends object>(obj: T): T {
    const out = { ...obj } as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) delete out[k];
    }
    return out as T;
  }

  const actions: EditorActions = {
    async loadPipeline(id) {
      store.update((s) => ({ ...s, loading: true }));
      try {
        const detail = await deps.api.getPipeline(id);
        const loaded: EditorState = {
          pipelineId: detail.id,
          name: detail.name ?? null,
          nodes: detail.nodes,
          edges: detail.edges,
          selection: [],
          dirty: false,
          loading: false,
          validation: null,
          applyError: null,
          canUndo: false,
          canRedo: false,
        };
        history.clear(loaded);
        store.set(loaded);
      } finally {
        store.update((s) => ({ ...s, loading: false }));
      }
    },

    addNode(type, pos) {
      const id = `node-${++nodeCounter}`;
      const fresh = createNode(type, id);
      mutate((s) => {
        const withNode = [...s.nodes, pos ? { ...fresh, pos: { ...pos } } : fresh];
        return {
          ...s,
          // a palette drop carries a position; if that position lands inside
          // a loop container the new node joins its body
          nodes: pos ? bucketDroppedNode(withNode, id) : withNode,
          selection: [id],
          dirty: true,
        };
      });
    },

    moveNode(id, x, y) {
      if (dragOpen) {
        dragMoved = true;
        dragId = id;
        patch((s) => ({
          ...s,
          nodes: modelMoveNode(s.nodes, id, x, y),
          dirty: true,
        }));
        return;
      }
      mutate((s) => ({
        ...s,
        nodes: modelMoveNode(s.nodes, id, x, y),
        dirty: true,
      }));
    },

    addLoopMember(loopId, pos) {
      const id = `node-${++nodeCounter}`;
      const fresh = { ...createNode("llm_call", id), pos: { ...pos } };
      mutate((s) => {
        const withNode = [...s.nodes, fresh];
        const withBody = addLoopMemberNode(withNode, loopId, id);
        return {
          ...s,
          nodes: withBody,
          selection: [id],
          dirty: true,
        };
      });
    },

    deleteNode(id) {
      mutate((s) => {
        const { nodes, edges } = modelDeleteNode(s.nodes, s.edges, id);
        return {
          ...s,
          nodes,
          edges,
          selection: s.selection.filter((sel) => sel !== id),
          dirty: true,
        };
      });
    },

    connect(from, to, guard) {
      mutate((s) => ({
        ...s,
        edges: connectNodes(s.edges, from, to, guard),
        dirty: true,
      }));
    },

    reorderLoopMember(loopId, memberId, dir) {
      mutate((s) => ({
        ...s,
        nodes: modelReorderMember(s.nodes, loopId, memberId, dir),
        dirty: true,
      }));
    },

    /** Inspector field edit: merge a partial patch into one node and mark
     * the graph dirty WITHOUT recording a history entry (undo/redo only
     * covers add/move/delete/connect/reorder). Undefined patch values delete
     * the field — the legacy inspector cleared empty inputs the same way. */
    updateNode(id, patchValue) {
      patch((s) => {
        if (!s.nodes.some((n) => n.id === id)) return s;
        const nodes = s.nodes.map((n) =>
          n.id === id ? dropUndefined({ ...n, ...patchValue }) : n,
        );
        return { ...s, nodes, dirty: true };
      });
    },

    /** Drop a member from a loop's body (the member NODE stays in the graph).
     * Records a history entry like reorder — undoing restores the body. */
    removeLoopMember(loopId, memberId) {
      mutate((s) => ({
        ...s,
        nodes: modelRemoveLoopMember(s.nodes, loopId, memberId),
        dirty: true,
      }));
    },

    /** Set (or clear, with an empty value) the guard label on the node's
     * outgoing edge. Inspector field edit: no history entry. */
    setEdgeGuard(from, guard) {
      patch((s) => {
        const idx = s.edges.findIndex((e) => e.from === from);
        if (idx < 0) return s;
        const edge = s.edges[idx]!;
        if ((edge.guard ?? "") === (guard ?? "")) return s;
        const edges = s.edges.map((e, i) => {
          if (i !== idx) return e;
          // empty guard clears the label (legacy `delete edge.guard`)
          return dropUndefined({ ...e, guard: guard || undefined });
        });
        return { ...s, edges, dirty: true };
      });
    },

    /** Rename the pipeline (editor credential, not a graph mutation: naming
     * never records a history entry). */
    rename(name) {
      patch((s) => ({ ...s, name }));
    },

    beginMove() {
      dragOpen = true;
      dragMoved = false;
      dragId = null;
    },

    endMove() {
      if (!dragOpen) return;
      dragOpen = false;
      if (!dragMoved) return;
      const final = get(store);
      // Bucket the dragged node by its final position: if it now lands inside
      // a loop container it joins that body (or sheds any accidental one);
      // a no-op returns the same array reference and is skipped.
      let next = final;
      if (dragId !== null) {
        const bucketed = bucketDroppedNode(final.nodes, dragId);
        if (bucketed !== final.nodes) next = { ...final, nodes: bucketed };
      }
      commit(next);
    },

    select(ids) {
      patch((s) => ({ ...s, selection: [...ids] }));
    },

    undo() {
      const previous = history.undo();
      if (previous !== null) store.set({ ...previous, canUndo: history.canUndo, canRedo: history.canRedo });
    },

    redo() {
      const next = history.redo();
      if (next !== null) store.set({ ...next, canUndo: history.canUndo, canRedo: history.canRedo });
    },

    async validate() {
      const s = get(store);
      const payload = buildPayload({ nodes: s.nodes, edges: s.edges });
      const result = await deps.api.validate(payload, s.pipelineId ?? undefined);
      patch((prev) => ({ ...prev, validation: result }));
    },

    async apply() {
      try {
        const s = get(store);
        // The editor applies its working graph as a (new or updated) chain —
        // same raw config the static UI sent: { chains: {...} } (the transport
        // wraps it as { config: { chains } } for POST /api/ui/apply).
        const id = s.pipelineId ?? "nuevo-pipeline";
        const payload = buildPayload({ nodes: s.nodes, edges: s.edges });
        const result = await deps.api.apply({
          chains: {
            [id]: {
              displayName: id,
              provider: "llama-server",
              nodes: payload.nodes,
              edges: payload.edges,
            },
          },
        });
        patch((s) => ({ ...s, applyError: null, dirty: false }));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch((s) => ({ ...s, applyError: message }));
        return null;
      }
    },

    reset() {
      history.clear();
      store.update(() => ({ ...INITIAL, canUndo: false, canRedo: false }));
    },
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: () => get(store),
    actions,
  };
}