/**
 * Hybrid selector (Slice B — task 2.5).
 *
 * Decides, by shape, which runtime executes a pipeline (pipeline-orchestration
 * modified "Sequential step execution"):
 *   - a LINEAR-compatible graph (single path, no condition/branch/loop/
 *     composition) is served as a `ParsedChain` to the existing `runChain`
 *     linear engine;
 *   - any COMPLEX graph (conditionals + branches, fan/join, loops, composition)
 *     is dispatched to the `graph-engine`.
 *
 * Pure + dependency-injected: the runtime dispatch (`createHybridSelector`)
 * takes `getChain`/`getGraph` lookups so it is trivially testable without a
 * live registry, and returns a discriminated decision the caller executes.
 */
import type { ParsedChain } from "./parser.js";
import type { GraphPipeline, GraphNode } from "./graph.js";
import { isLinearCompatible } from "./graph.js";

/**
 * The engine selected for a graph by its shape.
 *   - "linear": execute via `runChain` (graph converted to a ParsedChain).
 *   - "graph": execute via `runGraphEngine`.
 */
export type EngineChoice = "linear" | "graph";

/**
 * Select the runtime for a pipeline graph by shape (admission decision).
 */
export function selectEngine(graph: GraphPipeline): EngineChoice {
  return isLinearCompatible(graph) ? "linear" : "graph";
}

/** Options controlling graph → chain conversion. */
export interface ToChainOpts {
  /** Fallback provider when neither node nor graph supplies one. */
  defaultProvider?: string;
}

const FALLBACK_PROVIDER = "llama-server";

/**
 * Convert a LINEAR-compatible graph into a `ParsedChain` for the linear
 * engine. Returns `null` when the graph is not linear-compatible (it must go
 * to the graph engine instead).
 *
 * The converter walks the single start→…→end path and emits one `generate`
 * step per `llm_call`, preserving node order. Each step's `provider` comes
 * from the node, else the provided default, else the standard fallback.
 */
export function graphToParsedChain(
  graph: GraphPipeline,
  opts: ToChainOpts = {},
): ParsedChain | null {
  if (!isLinearCompatible(graph)) return null;

  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  const nextOf = new Map<string, string>();
  for (const e of graph.edges) nextOf.set(e.from, e.to);

  // Walk the single path collecting llm_call nodes in execution order.
  const steps: ParsedChain["steps"] = [];
  let cur: string | undefined = graph.nodes.find((n) => n.type === "start")?.id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (!n) break;
    if (n.type === "llm_call") {
      steps.push({
        type: "generate",
        model: n.model ?? "unknown",
        provider: n.provider ?? opts.defaultProvider ?? FALLBACK_PROVIDER,
      });
    }
    if (n.type === "end") break;
    cur = nextOf.get(cur);
  }

  return {
    name: graph.name ?? graph.id,
    displayName: graph.name,
    defaultProvider: opts.defaultProvider ?? FALLBACK_PROVIDER,
    steps,
  };
}

/** Dependency lookups for runtime pipeline resolution. */
export interface HybridSelectorDeps {
  /** Resolve a pipeline name to a linear ParsedChain (for `runChain`). */
  getChain: (name: string) => ParsedChain | undefined;
  /** Resolve a pipeline name to a graph (for the graph engine). */
  getGraph: (name: string) => GraphPipeline | undefined;
}

/** Discriminated dispatch decision. */
export type HybridDispatch =
  | { kind: "linear"; chain: ParsedChain }
  | { kind: "graph"; graph: GraphPipeline };

/** A hybrid selector: resolve a pipeline name to an engine decision. */
export interface HybridSelector {
  /**
   * Resolve `name` to a dispatch: `linear` (run a ParsedChain via runChain)
   * or `graph` (run the graph engine). Returns `undefined` when no pipeline
   * is registered under `name`.
   */
  resolve(name: string): HybridDispatch | undefined;
}

/**
 * Create a hybrid selector backed by chain/graph lookups.
 *
 * Resolution rule:
 *   - a name registered as a chain → linear.
 *   - a name registered as a graph that is linear-compatible → converted and
 *     served as linear (per the admission contract, linear graphs are served
 *     as ParsedChains).
 *   - a name registered as a complex graph → graph engine.
 */
export function createHybridSelector(deps: HybridSelectorDeps): HybridSelector {
  return {
    resolve(name) {
      const chain = deps.getChain(name);
      if (chain) return { kind: "linear", chain };

      const graph = deps.getGraph(name);
      if (!graph) return undefined;

      if (selectEngine(graph) === "linear") {
        const converted = graphToParsedChain(graph);
        if (converted) return { kind: "linear", chain: converted };
      }
      return { kind: "graph", graph };
    },
  };
}
