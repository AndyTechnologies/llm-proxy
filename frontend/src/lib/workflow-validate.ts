/**
 * Client-side structural pre-validation for the workflow editor (U06).
 *
 * The backend is the authority (`validateGraph`, src/orchestrator/graph.ts):
 * the editor runs this mirror BEFORE sending a save so obvious problems stop
 * the round-trip early, but the same graph still hits the real validator on
 * PUT. This module mirrors the STRUCTURAL subset of `validateGraph` with
 * verbatim error wording:
 *
 *   - exactly one start / at least one end
 *   - edges (and on_429 / tool_calls_route targets) reference real nodes
 *   - required per-type fields (llm_call.model, condition.condition,
 *     loop.body, pipeline.pipeline, data.code.code, router.condition)
 *   - loop body members exist — the engine RUNNER enforces this at runtime
 *     ("loop body references unknown node"), graph.ts does not; the task
 *     requires the client to flag it, so this is a documented superset
 *   - model existence when a known-model set is provided (same as the backend
 *     `{ knownModels }` option — empty set means "skip")
 *
 * NOT mirrored (backend-only, deliberate): cycle legality, connectivity /
 * reachability, and stale loop-body edges — those need the engine's effective
 * edge-set synthesis and are decided by the real validator on save.
 *
 * Pure functions — no DOM, no Svelte, no stores — runnable under `bun test`.
 */
import type { GraphNode, GraphPipeline } from "./workflow-nodes.js";

export interface WorkflowValidation {
  /** True when no errors were found (mirror of `GraphValidation.ok`). */
  valid: boolean;
  /** Error messages mirroring `validateGraph` wording verbatim. */
  errors: string[];
}

/**
 * Human-readable node label matching graph.ts's `nodeLabel`: `LLM_CALL model
 * SmolLM3 (n3)` when an llm_call carries a model, else `CONDITION (c2)`.
 */
function nodeLabel(n: GraphNode, includeModel = true): string {
  const type = n.type.toUpperCase();
  if (includeModel && n.type === "llm_call" && n.model) {
    return `LLM_CALL model ${n.model} (${n.id})`;
  }
  return `${type} (${n.id})`;
}

/**
 * Structural mirror of `validateGraph` (see header for the exact subset).
 *
 * @param graph  engine graph — pass `flowToGraph(nodes, edges)` output
 * @param opts   `knownModels` — only when non-empty (backend parity)
 */
export function validateWorkflow(
  graph: GraphPipeline,
  opts: { knownModels?: string[] } = {},
): WorkflowValidation {
  const errors: string[] = [];
  const known = new Set(opts.knownModels ?? []);

  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.id, n);

  // Exactly one start.
  const starts = graph.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    errors.push(`graph "${graph.id}" must have exactly one start node (found ${starts.length})`);
  }

  // At least one end.
  const ends = graph.nodes.filter((n) => n.type === "end");
  if (ends.length < 1) {
    errors.push(`graph "${graph.id}" must have at least one end node`);
  }

  // Edges reference real nodes.
  for (const edge of graph.edges) {
    if (!byId.has(edge.from)) {
      errors.push(`edge from "${edge.from}" references an unknown node`);
    }
    if (!byId.has(edge.to)) {
      errors.push(`edge to "${edge.to}" references an unknown node`);
    }
  }

  // Required per-type fields.
  for (const n of graph.nodes) {
    if (n.type === "llm_call" && !n.model) {
      errors.push(`node ${nodeLabel(n)} is missing its required "model" field`);
    }
    if (n.type === "condition" && !n.condition) {
      errors.push(`node ${nodeLabel(n)} is missing its required "condition" field`);
    }
    if (n.type === "loop" && (!n.body || n.body.length === 0)) {
      errors.push(`node ${nodeLabel(n)} is missing its required "body" field`);
    }
    if (n.type === "pipeline" && !n.pipeline) {
      errors.push(`node ${nodeLabel(n)} is missing its required "pipeline" field`);
    }
    if (n.type === "data.code" && (!n.code || n.code.trim() === "")) {
      errors.push(`node ${nodeLabel(n)} is missing its required "code" field`);
    }
    if (n.type === "router" && !n.condition) {
      errors.push(`node ${nodeLabel(n)} is missing its required "condition" field`);
    }
  }

  // Loop body members exist — engine-runner admission (super-set, see header).
  for (const n of graph.nodes) {
    if (n.type !== "loop" || !Array.isArray(n.body)) continue;
    for (const memberId of n.body) {
      if (!byId.has(memberId)) {
        errors.push(`node ${nodeLabel(n)} body references an unknown node "${memberId}"`);
      }
    }
  }

  // Broken fallback/tool-calls routes (graph.ts wording).
  for (const n of graph.nodes) {
    if (n.on_429 && !byId.has(n.on_429)) {
      errors.push(`node ${nodeLabel(n)} references an unknown on_429 target ("${n.on_429}")`);
    }
    if (n.tool_calls_route && !byId.has(n.tool_calls_route)) {
      errors.push(
        `node ${nodeLabel(n)} references an unknown tool_calls_route target ("${n.tool_calls_route}")`,
      );
    }
  }

  // Model existence (only when a known-model set is provided).
  if (opts.knownModels && opts.knownModels.length > 0) {
    for (const n of graph.nodes) {
      if (n.type === "llm_call" && n.model && !known.has(n.model)) {
        errors.push(`node ${nodeLabel(n, false)} references an unknown model "${n.model}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}