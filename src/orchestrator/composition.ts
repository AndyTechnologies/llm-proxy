/**
 * Pipeline composition (Slice B — task 2.3).
 *
 * Enables a pipeline to invoke another pre-defined pipeline by name as a step,
 * with bounded depth and input parameters (pipeline-composition spec):
 *
 * Req 1 "Pipeline invocation as a step": the invoked pipeline's final output
 *   becomes the invoker's `lastResponse` (handled by the caller threading
 *   `CompositionOutput` back into its state).
 * Req 2 "Bounded composition depth": depth is bounded by
 *   `MAX_COMPOSITION_DEPTH` (5). A nesting that would enter depth 6 throws
 *   `CompositionDepthError` — never unbounded recursion.
 * Req 3 "Input parameters to the invoked pipeline": runtime params (plus any
 *   static params on the invoking `pipeline` node) propagate in.
 * Req 4 "Depth validation at admission": `resolveCompositionDepth` walks the
 *   composition references WITHOUT executing and flags an over-deep chain so
 *   it can be rejected before it ever runs.
 *
 * Design: the runtime is a pure, dependency-injected object. `invoke` tracks
 * the current in-flight depth; `executeBody` (injected) performs the actual
 * pipeline body work and receives the same `invoke` so nested compositions
 * recurse with the depth bookkeeping intact.
 */
import type { GraphPipeline } from "./graph.js";

/** Default maximum composition depth. */
export const MAX_COMPOSITION_DEPTH = 5;

/** The output a composed pipeline produces (threaded as `lastResponse`). */
export interface CompositionOutput {
  lastResponse: unknown;
  lastContent: string;
  lastStatus: number;
  error: string | null;
}

/** Thrown when composition exceeds the maximum depth. */
export class CompositionDepthError extends Error {
  readonly invoked: string;
  readonly depth: number;
  readonly max: number;
  constructor(invoked: string, depth: number, max: number) {
    super(
      `[composition] max composition depth ${max} exceeded invoking pipeline "${invoked}" (depth ${depth})`,
    );
    this.name = "CompositionDepthError";
    this.invoked = invoked;
    this.depth = depth;
    this.max = max;
  }
}

/** Injected dependencies for the composition runtime. */
export interface CompositionRuntimeDeps {
  /** Resolve a pre-defined pipeline by name (undefined if unknown). */
  getPipeline: (name: string) => GraphPipeline | undefined;
  /**
   * Execute the body of a resolved pipeline given merged params and the
   * in-flight depth. `invoke` is bound back to the runtime so the body can
   * recurse into nested compositions with depth enforced.
   */
  executeBody: (
    pipe: GraphPipeline,
    params: Record<string, unknown>,
    inFlightDepth: number,
    invoke: CompositionInvoke,
  ) => Promise<CompositionOutput>;
}

/** The depth-aware composition invocation signature. */
export type CompositionInvoke = (
  name: string,
  params: Record<string, unknown>,
  depth: number,
) => Promise<CompositionOutput>;

/**
 * Create a depth-bounded composition runtime.
 *
 * `invoke(name, params, depth)` runs `name`'s pipeline at `depth+1`. A call
 * that would enter depth `MAX_COMPOSITION_DEPTH + 1` throws
 * `CompositionDepthError`. For the top-level request, call `invoke(..., 0)`.
 */
export function createCompositionRuntime(
  deps: CompositionRuntimeDeps,
): { invoke: CompositionInvoke; maxDepth: number } {
  const invoke: CompositionInvoke = async (name, params, depth) => {
    const inFlight = depth + 1;
    if (inFlight > MAX_COMPOSITION_DEPTH) {
      throw new CompositionDepthError(name, inFlight, MAX_COMPOSITION_DEPTH);
    }
    const pipe = deps.getPipeline(name);
    if (!pipe) {
      throw new Error(`[composition] pipeline "${name}" not found`);
    }
    return deps.executeBody(pipe, params, inFlight, invoke);
  };
  return { invoke, maxDepth: MAX_COMPOSITION_DEPTH };
}

/**
 * Merge static params declared on a `pipeline` node with runtime params.
 * Runtime params take precedence over statics.
 */
export function mergeParams(
  statics: Record<string, string> | undefined,
  runtime: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(statics ?? {}), ...runtime };
}

// ── Admission-time depth validation (Req 4) ───────────────────────────────

export interface CompositionDepthResult {
  ok: boolean;
  depth: number;
  errors: string[];
}

/**
 * Resolve the composition depth of a pipeline by walking its composition
 * references WITHOUT executing anything (used at graph/pipeline admission to
 * reject an over-deep composition before it can run). Follows a cycle-safe
 * DFS: if a cycle is detected the chain is flagged as invalid (an unbounded
 * composition cycle would recurse forever at runtime).
 */
export function resolveCompositionDepth(
  rootName: string,
  getPipeline: (name: string) => GraphPipeline | undefined,
  maxDepth: number = MAX_COMPOSITION_DEPTH,
): CompositionDepthResult {
  const errors: string[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();

  const deepest = { value: 0 };
  visit(rootName, 1, visited, onStack, deepest, errors, maxDepth, getPipeline);

  return {
    ok: errors.length === 0,
    depth: deepest.value,
    errors,
  };
}

function visit(
  name: string,
  depth: number,
  visited: Set<string>,
  onStack: Set<string>,
  deepest: { value: number },
  errors: string[],
  maxDepth: number,
  getPipeline: (name: string) => GraphPipeline | undefined,
): void {
  if (depth > deepest.value) deepest.value = depth;
  if (depth > maxDepth) {
    errors.push(`[composition] pipeline "${name}" exceeds max composition depth ${maxDepth}`);
    return;
  }
  if (onStack.has(name)) {
    errors.push(`[composition] composition cycle detected involving "${name}"`);
    return;
  }
  if (visited.has(name)) return;

  visited.add(name);
  onStack.add(name);

  const pipe = getPipeline(name);
  if (pipe) {
    for (const n of pipe.nodes) {
      if (n.type === "pipeline" && n.pipeline) {
        visit(n.pipeline, depth + 1, visited, onStack, deepest, errors, maxDepth, getPipeline);
      }
    }
  }

  onStack.delete(name);
}
