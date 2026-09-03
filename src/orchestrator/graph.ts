/**
 * Graph pipeline validation + SAFE AST interpreter (Slice B).
 *
 * Task 2.1 — node/edge validation (dashboard-api validate scenarios):
 *   - acyclic except `loop` boundaries (a back edge is legal only when it
 *     stays inside a loop node's `body`)
 *   - exactly one `start` and ≥1 `end`
 *   - model existence for `llm_call` nodes
 *   - required fields (edges reference real nodes; per-type required fields)
 *
 * Task 2.2 — SAFE AST (graph-engine Req "Safe AST condition evaluation"):
 *   - typed walker over `compare`/`logical`/`not`/`exists` reading
 *     `lastResponse.status`, `lastResponse.content`, `error`, `variables`
 *   - `sanitizeAst` rejects `eval`/`new Function` and any URL/file/network
 *     reference so unsafe conditions never reach the interpreter
 *
 * Design note: validation and the AST interpreter are pure functions — no
 * side effects, no global state — so they are trivially unit-testable and
 * safe to call at admission (registry.reload) and at runtime.
 */

/** Supported node types. */
export type NodeType =
  | "start"
  | "end"
  | "llm_call"
  | "condition"
  | "loop"
  | "fan"
  | "join"
  | "pipeline";

/** A node in a pipeline graph. */
export interface GraphNode {
  id: string;
  type: NodeType;
  /** Opt-in parallel execution for this node's outgoing branches. */
  parallel?: boolean;
  /** Required for `llm_call`. */
  model?: string;
  /** Optional provider override (defaults to the runtime default). */
  provider?: string;
  /** Required for `condition` — the guarded expression. */
  condition?: AstExpr;
  /** Required for `loop` — the node ids forming the loop body. */
  body?: string[];
  /** Required for `pipeline` — the name of the invoked pipeline. */
  pipeline?: string;
  /** Optional input parameters for a `pipeline` composition node. */
  params?: Record<string, string>;
}

/** A directed edge between nodes, with an optional condition guard. */
export interface GraphEdge {
  from: string;
  to: string;
  /** Used by `condition` nodes to select the true/false branch. */
  guard?: "true" | "false";
}

/** A complete pipeline graph. */
export interface GraphPipeline {
  id: string;
  name?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Result of graph validation. */
export interface GraphValidation {
  ok: boolean;
  errors: string[];
}

/**
 * SAFE AST — the only shapes the interpreter will ever evaluate. There is no
 * generic "code" escape hatch: every expression is one of the four typed
 * operators over a closed set of context fields.
 */
export type CtxField =
  | "lastResponse.status"
  | "lastResponse.content"
  | "error"
  | string; // variables (dotted variable name)

/** Comparison operators supported by the SAFE AST `compare` node. */
export type CompareOp2 = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type AstExpr =
  | { op: "exists"; field: CtxField }
  | { op: "not"; child: AstExpr }
  | { op: "logical"; and: boolean; args: AstExpr[] }
  | { op: "compare"; field: CtxField; op2: CompareOp2; value: unknown };

/** Runtime context the AST reads from. */
export interface AstContext {
  lastResponse: { status: number; content: string } | null;
  error: string | null;
  variables: Record<string, unknown>;
}

// ── Task 2.1: graph validation ────────────────────────────────────────────

/**
 * Validate a pipeline graph. Returns `{ ok, errors }` (never throws).
 *
 * Structural invariants:
 *   - exactly one `start`, at least one `end`
 *   - every edge references real nodes
 *   - acyclic except back edges that stay inside a loop node's `body`
 *   - required per-type fields present
 *   - when `knownModels` is provided, every `llm_call` model must exist
 */
export function validateGraph(
  graph: GraphPipeline,
  opts: { knownModels?: string[] } = {},
): GraphValidation {
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
      errors.push(`edge from "${edge.from}" references a nonexistent node`);
    }
    if (!byId.has(edge.to)) {
      errors.push(`edge to "${edge.to}" references a nonexistent node`);
    }
  }

  // Required per-type fields.
  for (const n of graph.nodes) {
    if (n.type === "llm_call" && !n.model) {
      errors.push(`llm_call node "${n.id}" is missing required field "model"`);
    }
    if (n.type === "condition" && !n.condition) {
      errors.push(`condition node "${n.id}" is missing required field "condition"`);
    }
    if (n.type === "loop" && (!n.body || n.body.length === 0)) {
      errors.push(`loop node "${n.id}" is missing required field "body"`);
    }
    if (n.type === "pipeline" && !n.pipeline) {
      errors.push(`pipeline node "${n.id}" is missing required field "pipeline"`);
    }
  }

  // Model existence (only when a known-model set is provided).
  if (opts.knownModels && opts.knownModels.length >= 0) {
    for (const n of graph.nodes) {
      if (n.type === "llm_call" && n.model && !known.has(n.model)) {
        errors.push(`llm_call node "${n.id}" references unknown model "${n.model}"`);
      }
    }
  }

  // Acyclicity except loop boundaries.
  collectCycleErrors(graph, byId, errors);

  return { ok: errors.length === 0, errors };
}

/**
 * Detect cycles outside loop boundaries.
 *
 * A `loop` node names its `body` node ids. A back edge (an edge to an
 * ancestor in the DFS tree) is legal ONLY when both endpoints are inside the
 * same loop body and the back edge points at the loop body's entry. Any other
 * back edge is a real cycle and is rejected.
 */
function collectCycleErrors(
  graph: GraphPipeline,
  byId: Map<string, GraphNode>,
  errors: string[],
): void {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  // DFS from every node so disconnected subgraphs are also checked.
  for (const start of graph.nodes) {
    if (state.get(start.id) === "done") continue;
    dfs(start.id);
  }

  function dfs(id: string): void {
    const n = byId.get(id);
    if (!n) return;
    state.set(id, "visiting");
    stack.push(id);

    for (const edge of graph.edges) {
      if (edge.from !== id) continue;
      const to = edge.to;
      if (!byId.has(to)) continue;
      const st = state.get(to);
      if (st === "done") continue;
      if (st === "visiting") {
        // A back edge — legal only if it stays inside one loop body.
        const legal = isInsideSingleLoopBody(id, to, byId);
        if (!legal) {
          errors.push(
            `graph "${graph.id}" contains a cycle (edge ${id} -> ${to}) outside a valid loop boundary`,
          );
        }
        continue;
      }
      dfs(to);
    }

    state.set(id, "done");
    stack.pop();
  }
}

/**
 * Whether a back edge is a valid loop boundary. A back edge is legal when it
 * connects a `loop` node to a node in that loop's body (in either direction) —
 * i.e. `loop -> body[...]` forward edges plus the closing `body[...] -> loop`
 * back edge — and both endpoints belong to the SAME loop. Any other back edge
 * is a real cycle.
 */
function isInsideSingleLoopBody(
  from: string,
  to: string,
  byId: Map<string, GraphNode>,
): boolean {
  for (const n of byId.values()) {
    if (n.type !== "loop" || !n.body) continue;
    const fromInBody = n.body.includes(from);
    const toInBody = n.body.includes(to);
    // Edge connects the loop node to a body node (or vice versa).
    if ((n.id === from && toInBody) || (n.id === to && fromInBody)) return true;
    // Edge stays entirely inside one body.
    if (fromInBody && toInBody) return true;
  }
  return false;
}

// ── Hybrid compatibility (2.5) ────────────────────────────────────────────

/**
 * Whether a graph is linear-compatible — i.e. reduces to a single sequential
 * path with no conditionals, branches, loops, joins, parallel subgraphs, or
 * pipeline composition. Linear-compatible graphs run on the existing
 * `runChain` linear engine; everything else goes to the graph engine.
 */
export function isLinearCompatible(graph: GraphPipeline): boolean {
  for (const n of graph.nodes) {
    if (
      n.type === "condition" ||
      n.type === "loop" ||
      n.type === "join" ||
      n.type === "pipeline" ||
      n.parallel
    ) {
      return false;
    }
  }
  // No edge may carry a guard (a guarded edge implies a branch).
  for (const e of graph.edges) {
    if (e.guard) return false;
  }
  return true;
}

// ── Task 2.2: SAFE AST ────────────────────────────────────────────────────

// Field / operator whitelists for sanitization.
const ALLOWED_OPS = new Set(["exists", "not", "logical", "compare"]);
const ALLOWED_OP2 = new Set(["==", "!=", "<", "<=", ">", ">="]);
const SAFE_TOP_FIELDS = new Set(["lastResponse.status", "lastResponse.content", "error"]);

/**
 * Sanitize raw (untrusted) AST input into a validated `AstExpr`, or `null` if
 * it is unsafe. Rejects:
 *   - any op other than the four allowed (so `eval`/`new Function`-style
 *     input cannot pass),
 *   - opaque "code" fields,
 *   - field names that reference a URL, file, or network target.
 * No `eval`/`new Function` is ever reached — the interpreter only walks the
 * typed discriminated union that this function admits.
 */
export function sanitizeAst(input: unknown): AstExpr | null {
  if (typeof input !== "object" || input === null) return null;
  const node = input as Record<string, unknown>;

  const op = node.op;
  if (typeof op !== "string" || !ALLOWED_OPS.has(op)) return null;

  // Reject any stray "code"/"source"/"func" execution fields.
  for (const key of ["code", "source", "js", "func", "expr"]) {
    if (key in node) return null;
  }

  switch (op) {
    case "exists": {
      const field = node.field;
      if (typeof field !== "string") return null;
      if (!isSafeField(field)) return null;
      return { op: "exists", field };
    }
    case "not": {
      const child = sanitizeAst(node.child);
      if (child === null) return null;
      return { op: "not", child };
    }
    case "logical": {
      const and = node.and;
      const args = node.args;
      if (typeof and !== "boolean") return null;
      if (!Array.isArray(args)) return null;
      const clean: AstExpr[] = [];
      for (const a of args) {
        const c = sanitizeAst(a);
        if (c === null) return null;
        clean.push(c);
      }
      return { op: "logical", and, args: clean };
    }
    case "compare": {
      const field = node.field;
      const op2 = node.op2;
      if (typeof field !== "string") return null;
      if (typeof op2 !== "string" || !ALLOWED_OP2.has(op2)) return null;
      if (!isSafeField(field)) return null;
      if (!("value" in node)) return null;
      return { op: "compare", field, op2: op2 as CompareOp2, value: node.value };
    }
    default:
      return null;
  }
}

/** Reject fields that smuggle URL/file/network access. */
function isSafeField(field: string): boolean {
  if (SAFE_TOP_FIELDS.has(field)) return true;
  // Variable names: dotted identifiers referencing `variables.<name>`.
  if (field === "variables" || field.startsWith("variables.")) return true;
  // Anything else is a rejected "string" ctx field (no URL/file/network).
  return false;
}

/**
 * Read a field from the AST context.
 * Returns undefined when the field is absent or malformed.
 */
function readField(ctx: AstContext, field: string): unknown {
  if (field === "lastResponse.status") {
    return ctx.lastResponse?.status;
  }
  if (field === "lastResponse.content") {
    return ctx.lastResponse?.content;
  }
  if (field === "error") {
    return ctx.error;
  }
  if (field === "variables") {
    return ctx.variables;
  }
  if (field.startsWith("variables.")) {
    return readDotted(ctx.variables, field.slice("variables.".length));
  }
  // Reject any other field (URL/file/network never resolve here).
  return undefined;
}

function readDotted(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Evaluate a validated SAFE AST against a runtime context. Pure + total: it
 * only walks `AstExpr` (already sanitized), so it can never execute code.
 */
export function evaluateAst(expr: AstExpr, ctx: AstContext): boolean {
  switch (expr.op) {
    case "exists": {
      const v = readField(ctx, expr.field);
      return v !== undefined && v !== null && v !== "";
    }
    case "not":
      return !evaluateAst(expr.child, ctx);
    case "logical": {
      if (expr.and) {
        return expr.args.every((a) => evaluateAst(a, ctx));
      }
      return expr.args.some((a) => evaluateAst(a, ctx));
    }
    case "compare": {
      const actual = readField(ctx, expr.field);
      return compareValues(actual, expr.op2, expr.value);
    }
    default:
      return false;
  }
}

/** Total comparison over primitive values; non-comparable values compare false. */
function compareValues(
  actual: unknown,
  op2: "==" | "!=" | "<" | "<=" | ">" | ">=",
  expected: unknown,
): boolean {
  const a = coerce(actual);
  const b = coerce(expected);

  switch (op2) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return typeof a === "number" && typeof b === "number" ? a < b : false;
    case "<=":
      return typeof a === "number" && typeof b === "number" ? a <= b : false;
    case ">":
      return typeof a === "number" && typeof b === "number" ? a > b : false;
    case ">=":
      return typeof a === "number" && typeof b === "number" ? a >= b : false;
    default:
      return false;
  }
}

/** Normalize numbers stored as strings etc. for comparison. */
function coerce(v: unknown): unknown {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const asNum = Number(v);
    if (v !== "" && !Number.isNaN(asNum)) return asNum;
  }
  return v;
}
