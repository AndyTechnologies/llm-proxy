/**
 * Mutable graph registry (Phase 6 — graph-only registry).
 *
 * The registry stores and serves canonical `GraphPipeline` objects. The legacy
 * `ParsedChain` / `chainMap` / `asMap()` surface is removed; all dispatch
 * routes through `getGraph()` or `listGraphs()`.
 *
 * Reloads atomically: build + validate ALL graphs, then swap the active
 * reference only when every graph validates. On failure the previous state
 * remains intact (no partial mixture).
 *
 * Pure function + injected dependencies: `createPipelineRegistry(initial)`
 * returns a plain object; validation is a standalone pure function so it is
 * trivially testable without a runtime harness.
 */
import type { GraphPipeline } from "./graph.js";

// The full graph model lives in `graph.ts` (nodes/edges/conditions + SAFE AST).
// `GraphPipeline` is re-exported so registry consumers get the engine's graph
// shape directly — the registry stores and serves complete pipelines.
export type { GraphPipeline } from "./graph.js";

/**
 * The mutable registry contract.
 *
 * `reload(graphs)` builds + validates all entries and swaps the active
 * reference only when every graph validates successfully (atomic swap, no
 * restart). If any entry is invalid it throws and the previous state remains
 * active and served.
 */
export interface PipelineRegistry {
  /** Look up a graph pipeline by id. */
  getGraph(id: string): GraphPipeline | undefined;
  /** Return all registered graph pipelines. */
  listGraphs(): GraphPipeline[];
  /** Atomically replace the registered graphs on full success. */
  reload(graphs: GraphPipeline[]): Promise<void>;
}

/** Error prefix for registry validation failures (asserted by tests). */
export const ERR_INVALID_GRAPH = "[registry] invalid graph";

/**
 * Build all graph maps + validate every entry. Pure: never mutates the
 * registry. Throws if any graph is invalid, so the caller can refuse to swap.
 */
function buildValidated(
  graphs: GraphPipeline[],
): { graphMap: Map<string, GraphPipeline> } {
  const graphMap = new Map<string, GraphPipeline>();
  for (const graph of graphs) {
    if (!graph.id) {
      throw new Error(`${ERR_INVALID_GRAPH}: graph is missing an "id" field`);
    }
    if (graphMap.has(graph.id)) {
      throw new Error(`${ERR_INVALID_GRAPH}: duplicate graph id "${graph.id}"`);
    }
    graphMap.set(graph.id, graph);
  }
  return { graphMap };
}

/** Initial state passed to `createPipelineRegistry`. */
export interface RegistryInitial {
  graphs?: GraphPipeline[];
}

/** Create a mutable registry seeded with an initial graph set. */
export function createPipelineRegistry(initial: RegistryInitial = {}): PipelineRegistry {
  const seeded = buildValidated(initial.graphs ?? []);

  let graphMap = seeded.graphMap;

  return {
    getGraph(id) {
      return graphMap.get(id);
    },
    listGraphs() {
      return [...graphMap.values()];
    },
    async reload(graphs: GraphPipeline[]) {
      // Build + validate ALL entries first (pure). Only on full success do we
      // swap the internal reference — so a failed reload never leaves a
      // partial or mixed registry.
      const next = buildValidated(graphs);
      graphMap = next.graphMap;
    },
  };
}
