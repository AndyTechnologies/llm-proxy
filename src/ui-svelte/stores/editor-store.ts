/**
 * Editor store factory (svelte-ui task 3.1, MINOR-B).
 *
 * Created via an **injectable factory** — never a module singleton — so every
 * test and every view instance gets a fresh store with no hidden cross-state.
 * All mutations delegate to the pure `graph-model.ts` port; geometry and
 * connection guards never live in this module. The history layer (task 3.5)
 * plugs in on top of these same actions.
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
} from "../lib/graph-model.js";

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
}

export interface EditorActions {
  loadPipeline(id: string): Promise<void>;
  addNode(type: NodeType): void;
  moveNode(id: string, x: number, y: number): void;
  deleteNode(id: string): void;
  connect(from: string, to: string, guard?: string): void;
  select(ids: string[]): void;
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
};

/** Monotonic id source for freshly added nodes (per-store counter not needed:
 * ids only need to be unique within one graph session). */
let nodeCounter = 0;

export function createEditorStore(deps: EditorDeps): EditorStore {
  const store = writable<EditorState>({ ...INITIAL });

  const actions: EditorActions = {
    async loadPipeline(id) {
      store.update((s) => ({ ...s, loading: true }));
      try {
        const detail = await deps.api.getPipeline(id);
        store.update((s) => ({
          ...s,
          pipelineId: detail.id,
          name: detail.name ?? null,
          nodes: detail.nodes,
          edges: detail.edges,
          selection: [],
          dirty: false,
          validation: null,
          applyError: null,
        }));
      } finally {
        store.update((s) => ({ ...s, loading: false }));
      }
    },

    addNode(type) {
      const id = `node-${++nodeCounter}`;
      store.update((s) => ({
        ...s,
        nodes: [...s.nodes, createNode(type, id)],
        selection: [id],
        dirty: true,
      }));
    },

    moveNode(id, x, y) {
      store.update((s) => ({
        ...s,
        nodes: modelMoveNode(s.nodes, id, x, y),
        dirty: true,
      }));
    },

    deleteNode(id) {
      store.update((s) => {
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
      store.update((s) => ({
        ...s,
        edges: connectNodes(s.edges, from, to, guard),
        dirty: true,
      }));
    },

    select(ids) {
      store.update((s) => ({ ...s, selection: [...ids] }));
    },

    async validate() {
      const s = get(store);
      const payload = buildPayload({ nodes: s.nodes, edges: s.edges });
      const result = await deps.api.validate(payload);
      store.update((prev) => ({ ...prev, validation: result }));
    },

    async apply() {
      try {
        const result = await deps.api.apply();
        store.update((s) => ({ ...s, applyError: null }));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.update((s) => ({ ...s, applyError: message }));
        return null;
      }
    },

    reset() {
      store.update(() => ({ ...INITIAL }));
    },
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: () => get(store),
    actions,
  };
}