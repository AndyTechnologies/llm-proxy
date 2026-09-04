/**
 * Chain config parser.
 *
 * Takes the validated `GatewayConfig.chains` (already zod-parsed) and
 * resolves each chain's graph into a linear `ResolvedStep[]` — guaranteeing
 * every step has a non-optional `provider` field. The config now stores chains
 * as `nodes`/`edges` graphs (the graph is canonical; the legacy `steps` shape
 * is gone), so `parseChains` reads that graph directly and materializes the
 * ordered `ParsedChain` the linear engine still consumes.
 *
 * Invalid chain references (missing llm_call nodes, dangling on_429 /
 * tool_calls_route) are caught at startup so they never surface as runtime
 * 500s.
 *
 * WHY parse at startup: a chain misconfiguration is a deployment error,
 * not a per-request error. Failing fast at boot prevents serving broken
 * chains to clients.
 */
import type { ChainConfig, GatewayConfig } from "../config/schema.js";
import type { Chain, Step, ResolvedStep } from "../types/chain.js";
import type { GraphPipeline, GraphNode } from "./graph.js";

/** A fully resolved chain ready for the engine to execute. */
export interface ParsedChain extends Chain {
  steps: ResolvedStep[];
}

const DEFAULT_PROVIDER = "llama-server";

/** Map a graph node's `mode` to the linear step's `type`. */
function modeToType(mode: GraphNode["mode"]): Step["type"] {
  return mode ?? "generate";
}

/**
 * Convert a single graph chain config into a linear `ParsedChain` by walking
 * the `start → … → end` path and emitting one `Step` per `llm_call` node, in
 * order. Preserves the node's message scaffolding (`mode`, `ctx`, `system`,
 * `assistant`, `user`) and conditional routing (`on_429`, `tool_calls_route`).
 */
function graphChainConfigToParsed(
  name: string,
  cfg: ChainConfig,
  defaultProvider: string,
): ParsedChain {
  const byId = new Map<string, GraphNode>();
  for (const node of cfg.nodes) byId.set(node.id, node);

  // Walk the single linear path collecting llm_call nodes in execution order.
  const nextOf = new Map<string, string>();
  for (const edge of cfg.edges) nextOf.set(edge.from, edge.to);

  const steps: ResolvedStep[] = [];
  let cur: string | undefined = cfg.nodes.find((n) => n.type === "start")?.id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    if (node.type === "llm_call") {
      steps.push({
        // Name the step after its graph node id. `on_429`/`tool_calls_route`
        // target node ids, and the linear engine (and registry validation)
        // resolve those targets by step name — so the step name must equal the
        // node id for routing references to line up.
        name: node.id,
        type: modeToType(node.mode),
        model: node.model ?? "unknown",
        provider: node.provider ?? defaultProvider,
        ...(node.ctx !== undefined ? { ctx: node.ctx } : {}),
        ...(node.system !== undefined ? { system: node.system } : {}),
        ...(node.assistant !== undefined ? { assistant: node.assistant } : {}),
        ...(node.user !== undefined ? { user: node.user } : {}),
        ...(node.on_429 !== undefined ? { on_429: node.on_429 } : {}),
        ...(node.tool_calls_route !== undefined
          ? { tool_calls_route: node.tool_calls_route }
          : {}),
      });
    }
    if (node.type === "end") break;
    cur = nextOf.get(cur);
  }

  return {
    name,
    displayName: cfg.displayName,
    defaultProvider,
    provider: cfg.provider,
    steps,
  };
}

/**
 * Parse all chains from the config into executable ParsedChain objects.
 * Throws on any invalid chain so the server refuses to start.
 */
export function parseChains(config: GatewayConfig): Map<string, ParsedChain> {
  const chains = new Map<string, ParsedChain>();

  for (const [name, chainCfg] of Object.entries(config.chains)) {
    const defaultProvider =
      chainCfg.provider ?? chainCfg.defaultProvider ?? DEFAULT_PROVIDER;

    const chain = graphChainConfigToParsed(name, chainCfg, defaultProvider);

    // Refuse chains with zero llm_call nodes — this is a config authoring error.
    if (chain.steps.length === 0) {
      throw new Error(
        `[parser] chain "${name}" has no llm_call nodes — refusing to register`,
      );
    }

    // Validate on_429 references point to a node that actually exists in this chain.
    const nodeIds = new Set(chainCfg.nodes.map((n) => n.id));
    for (const step of chain.steps) {
      if (step.on_429 && !nodeIds.has(step.on_429)) {
        throw new Error(
          `[parser] chain "${name}" step references on_429 "${step.on_429}" which does not exist in the chain`,
        );
      }
      if (step.tool_calls_route && !nodeIds.has(step.tool_calls_route)) {
        throw new Error(
          `[parser] chain "${name}" step references tool_calls_route "${step.tool_calls_route}" which does not exist in the chain`,
        );
      }
    }

    chains.set(name, chain);

    console.log(
      `[parser] registered chain "${name}" (${chainCfg.displayName ?? name}): ${chain.steps.length} steps`,
    );
  }

  return chains;
}

/**
 * Convert a graph-shaped `ChainConfig` into a `GraphPipeline` for the registry
 * and dashboard. The config graph is canonical, so this is a thin structural
 * mapping — it does not translate any linear shape (the way the removed
 * `chainToGraph` did). Node ids, edges, and routing fields pass straight
 * through.
 */
export function configChainToGraph(
  name: string,
  cfg: ChainConfig,
): GraphPipeline {
  return {
    id: cfg.name ?? name,
    name: cfg.displayName ?? cfg.name ?? name,
    nodes: cfg.nodes,
    // The config edge is structurally identical to the graph edge; the schema
    // admits any string `guard` while `GraphEdge` narrows it to a branch
    // selector ("true"/"false"). Branches are the only guards the engine
    // evaluates, so this cast is the boundary narrowing.
    edges: cfg.edges as GraphPipeline["edges"],
  };
}
