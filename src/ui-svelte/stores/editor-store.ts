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
  validate(payload: { nodes: GraphNode[]; edges: GraphEdge[] }): Promise<{
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
  moveNode(id: string, x: number, y: number): void;
  deleteNode(id: string): void;
  connect(from: string, to: string, guard?: string): void;
  reorderLoopMember(loopId: string, memberId: string, dir: -1 | 1): void;
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
      const result = await deps.api.validate(payload);
      patch((prev) => ({ ...prev, validation: result }));
    },

    async apply() {
      try {
        const result = await deps.api.apply();
        patch((s) => ({ ...s, applyError: null }));
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