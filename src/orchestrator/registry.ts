/**
 * Mutable chain registry (Slice A — pipeline-orchestration Req "Runtime-reloadable
 * chain registry").
 *
 * Replaces the frozen `Map<string, ParsedChain>` produced by `parseChains` at
 * boot with a mutable registry that:
 *   - keeps a `Map<string, ParsedChain>`-compatible surface (`asMap`), so
 *     existing route consumers can keep working,
 *   - exposes a minimal `getGraph(id)` seam for graph pipelines (full graph
 *     model + validation land in Slice B),
 *   - reloads atomically: build + validate ALL chains, then swap the active
 *     reference only when every chain validates. On any failure it throws and
 *     leaves the previous registry fully intact (no partial mixture).
 *
 * Pure function + injected dependencies: `createPipelineRegistry(initial)`
 * returns a plain object; validation is a standalone pure function so it is
 * trivially testable without a runtime harness.
 */
import type { ParsedChain } from "./parser.js";
import type { GraphPipeline } from "./graph.js";

// The full graph model lives in `graph.ts` (nodes/edges/conditions + SAFE AST).
// `GraphPipeline` is re-exported so registry consumers get the engine's graph
// shape directly — the registry stores and serves complete pipelines.
export type { GraphPipeline } from "./graph.js";

/**
 * The mutable registry contract.
 *
 * `reload(graphs, chains)` builds + validates all entries and swaps the active
 * reference only when every chain validates successfully (atomic swap, no
 * restart). If any entry is invalid it throws and the previous state remains
 * active and served.
 */
export interface PipelineRegistry {
  /** Snapshot of the active chains — routes read their chains here. */
  asMap(): Map<string, ParsedChain>;
  /** Look up a graph pipeline by id (Slice B populates graph entries). */
  getGraph(id: string): GraphPipeline | undefined;
  /** Atomically replace the registered chains (and graphs) on full success. */
  reload(graphs: GraphPipeline[], chains: ParsedChain[]): Promise<void>;
}

/** Error prefix for registry validation failures (asserted by tests). */
export const ERR_INVALID_CHAIN = "[registry] invalid chain";

/**
 * Validate that a single parsed chain is well-formed.
 *
 * Mirrors the invariants `parseChains` enforces at boot so a runtime reload
 * can never publish a broken chain: non-empty steps, and any on_429 /
 * tool_calls_route reference must point at a step that actually exists.
 * Returns an error message, or `null` when the chain is valid.
 */
export function validateParsedChain(chain: ParsedChain): string | null {
  if (!chain.steps || chain.steps.length === 0) {
    return `chain "${chain.name}" has no steps`;
  }

  const stepNames = new Set(chain.steps.map((s, i) => s.name ?? `step-${i}`));
  for (const step of chain.steps) {
    if (step.on_429 && !stepNames.has(step.on_429)) {
      return `chain "${chain.name}" step "${step.name ?? "(unnamed)"}" references on_429 "${step.on_429}" which does not exist in the chain`;
    }
    if (step.tool_calls_route && !stepNames.has(step.tool_calls_route)) {
      return `chain "${chain.name}" step "${step.name ?? "(unnamed)"}" references tool_calls_route "${step.tool_calls_route}" which does not exist in the chain`;
    }
  }

  return null;
}

/**
 * Build all chain maps + validate every entry. Pure: never mutates the
 * registry. Throws if any chain is invalid, so the caller can refuse to swap.
 */
function buildValidated(
  graphs: GraphPipeline[],
  chains: ParsedChain[],
): { graphMap: Map<string, GraphPipeline>; chainMap: Map<string, ParsedChain> } {
  const graphMap = new Map<string, GraphPipeline>();
  for (const graph of graphs) {
    graphMap.set(graph.id, graph);
  }

  const chainMap = new Map<string, ParsedChain>();
  for (const chain of chains) {
    const problem = validateParsedChain(chain);
    if (problem) {
      throw new Error(`${ERR_INVALID_CHAIN}: ${problem}`);
    }
    chainMap.set(chain.name, chain);
  }

  return { graphMap, chainMap };
}

/** Initial state passed to `createPipelineRegistry`. */
export interface RegistryInitial {
  graphs?: GraphPipeline[];
  chains?: ParsedChain[];
}

/** Create a mutable registry seeded with an initial validated chain set. */
export function createPipelineRegistry(initial: RegistryInitial = {}): PipelineRegistry {
  // Seed with the boot-time chains (from parseChains). Seeding re-validates so
  // construction surfaces invalid boot-time chains just like parseChains does.
  const seeded = buildValidated(initial.graphs ?? [], initial.chains ?? []);

  let graphMap = seeded.graphMap;
  let chainMap = seeded.chainMap;

  return {
    asMap() {
      return new Map(chainMap);
    },
    getGraph(id) {
      return graphMap.get(id);
    },
    async reload(graphs: GraphPipeline[], chains: ParsedChain[]) {
      // Build + validate ALL entries first (pure). Only on full success do we
      // swap both internal references — so a failed reload never leaves a
      // partial or mixed registry.
      const next = buildValidated(graphs, chains);
      graphMap = next.graphMap;
      chainMap = next.chainMap;
    },
  };
}
