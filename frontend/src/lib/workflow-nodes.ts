/**
 * Single frontend node taxonomy (U05) — the mirror of `src/orchestrator/graph.ts`.
 *
 * `graph.ts` is the authoritative contract: this module re-exports its
 * `NodeType` union and `NODE_TYPES` registry (one source of truth) and adds
 * the UI-facing surface the visual editor needs:
 *
 *   - `WORKFLOW_NODE_TYPES` — 14 palette entries (ordered for the palette)
 *     with label, category, description, a token-key color and the per-type
 *     field definitions. Fields ONLY come from `GraphNode` semantics — no
 *     invented node fields.
 *   - value sanitization (`sanitizeNodeFields`) — enforces the "unknown
 *     fields are dropped" rule the backend parser applies, so the editor can
 *     never serialize a field the engine would drop.
 *   - id / handle helpers used by the canvas and the palette.
 *
 * Pure functions only — no DOM, no Svelte, no stores — so the same module
 * runs under `bun test` and in the Astro build.
 */
import {
  NODE_TYPES,
  type GraphNode,
  type NodeType,
} from "../../../src/orchestrator/graph.js";

// The taxonomy IDs ARE the engine registry — re-export verbatim instead of
// duplicating a list that could drift.
export { NODE_TYPES } from "../../../src/orchestrator/graph.js";
export type {
  AstExpr,
  GraphEdge,
  GraphNode,
  GraphPipeline,
  NodeType,
} from "../../../src/orchestrator/graph.js";

/** Palette category grouping (palette order: flow → llm → data → integration → output). */
export type NodeCategory = "flow" | "llm" | "data" | "integration" | "output";

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  flow: "Flow",
  llm: "LLM",
  data: "Data",
  integration: "Integration",
  output: "Output",
};

/** Palette group order (flow → llm → data → integration → output). */
export const CATEGORY_ORDER: readonly NodeCategory[] = [
  "flow",
  "llm",
  "data",
  "integration",
  "output",
];

/** Field input kinds the inspector forms (U06) will render. */
export type FieldKind =
  | "text"
  | "select"
  | "number"
  | "textarea"
  | "code"
  | "tokens"
  | "toggle";

/** Token-key color for a node type chip — resolved to `var(--<key>)` in CSS. */
export type ColorTokenKey = "accent" | "secondary" | "success";

/** One editable field of a node type, bound to a `GraphNode` field key. */
export interface NodeFieldDef {
  /** The GraphNode field key this input reads/writes. */
  key: string;
  label: string;
  kind: FieldKind;
  /** Valid selections when kind === "select". */
  options?: readonly string[];
  placeholder?: string;
}

/** Full taxonomy entry for one node type. */
export interface WorkflowNodeTypeDef {
  id: NodeType;
  label: string;
  category: NodeCategory;
  description: string;
  /** Token key for the node color chip (CSS `var(--<token>)`). */
  color: ColorTokenKey;
  /** UI field surface — a subset of GraphNode semantics for this type. */
  fields: readonly NodeFieldDef[];
  /** Canvas defaults for click-to-add (GraphNode fields only). */
  defaults: Partial<GraphNode>;
}

/**
 * Per-type UI field definitions. `condition` and `params` are GraphNode
 * fields of non-primitive shape (SAFE AST / param map); they travel in the
 * opaque `FlowNodeData.condition` / `.params` slots rather than in
 * `NodeFieldValues`, and their `kind` here ("code") only documents that U06
 * renders them as structured editors. `rag_local`/`embeddings` expose no
 * `model` — GraphNode defines no such field (the runtime default applies),
 * so adding one would invent a field the backend parser drops.
 */
export const WORKFLOW_NODE_TYPES: readonly WorkflowNodeTypeDef[] = [
  {
    id: "start",
    label: "Start",
    category: "flow",
    description: "Graph entry — exactly one per workflow",
    color: "success",
    fields: [],
    defaults: {},
  },
  {
    id: "end",
    label: "End",
    category: "flow",
    description: "Graph exit — the last response becomes the completion",
    color: "secondary",
    fields: [],
    defaults: {},
  },
  {
    id: "llm_call",
    label: "LLM call",
    category: "llm",
    description: "Generate with a model (mode: generate/refine/passthrough)",
    color: "accent",
    fields: [
      { key: "model", label: "Model", kind: "text", placeholder: "Model id" },
      { key: "mode", label: "Mode", kind: "select", options: ["generate", "refine", "passthrough"] },
      { key: "provider", label: "Provider", kind: "text", placeholder: "Optional override" },
      { key: "ctx", label: "Context", kind: "tokens", placeholder: "Token limit" },
      { key: "system", label: "System", kind: "textarea", placeholder: "System scaffold" },
      { key: "assistant", label: "Assistant", kind: "textarea", placeholder: "Assistant scaffold" },
      { key: "user", label: "User", kind: "textarea", placeholder: "Reserved — user scaffold" },
      { key: "on_429", label: "On 429", kind: "text", placeholder: "Target node id" },
      { key: "tool_calls_route", label: "Tool-calls route", kind: "text", placeholder: "Target node id" },
    ],
    defaults: { mode: "generate" },
  },
  {
    id: "condition",
    label: "Condition",
    category: "flow",
    description: "Guard expression selecting true/false branches",
    color: "accent",
    fields: [{ key: "condition", label: "Condition", kind: "code", placeholder: "Safe AST expression" }],
    defaults: { condition: { op: "exists", field: "lastResponse.content" } },
  },
  {
    id: "loop",
    label: "Loop",
    category: "flow",
    description: "Repeat a body of nodes",
    color: "accent",
    fields: [
      { key: "body", label: "Body", kind: "textarea", placeholder: "Body node ids, one per line" },
      { key: "iterations", label: "Iterations", kind: "number" },
    ],
    defaults: { body: [], iterations: 1 },
  },
  {
    id: "fan",
    label: "Fan",
    category: "flow",
    description: "Fan out branches in parallel",
    color: "accent",
    fields: [],
    defaults: { parallel: true },
  },
  {
    id: "join",
    label: "Join",
    category: "flow",
    description: "Merge branch results before continuing",
    color: "accent",
    fields: [],
    defaults: {},
  },
  {
    id: "pipeline",
    label: "Pipeline",
    category: "integration",
    description: "Compose another stored workflow",
    color: "accent",
    fields: [{ key: "pipeline", label: "Pipeline", kind: "text", placeholder: "Stored workflow name" }],
    defaults: { pipeline: "" },
  },
  {
    id: "rag_local",
    label: "RAG (local)",
    category: "data",
    description: "Local retrieval over chunked documents",
    color: "secondary",
    fields: [{ key: "k", label: "Top-k", kind: "number", placeholder: "4" }],
    defaults: { k: 4 },
  },
  {
    id: "data.code",
    label: "Data (code)",
    category: "data",
    description: "Sandboxed script step",
    color: "secondary",
    fields: [{ key: "code", label: "Code", kind: "code", placeholder: "Sandboxed script" }],
    defaults: { code: "" },
  },
  {
    id: "memory",
    label: "Memory",
    category: "data",
    description: "Conversation memory scope",
    color: "secondary",
    fields: [{ key: "convId", label: "Conversation id", kind: "text", placeholder: "Optional scope id" }],
    defaults: {},
  },
  {
    id: "embeddings",
    label: "Embeddings",
    category: "data",
    description: "Embed the last response (or an explicit text)",
    color: "secondary",
    fields: [{ key: "text", label: "Text", kind: "textarea", placeholder: "Defaults to last response" }],
    defaults: {},
  },
  {
    id: "router",
    label: "Router",
    category: "flow",
    description: "Route by a comparison (e.g. status or content)",
    color: "accent",
    fields: [{ key: "condition", label: "Condition", kind: "code", placeholder: "Safe AST expression" }],
    defaults: { condition: { op: "compare", field: "lastResponse.status", op2: "==", value: 200 } },
  },
  {
    id: "output",
    label: "Output",
    category: "output",
    description: "Emit an explicit output from the graph",
    color: "secondary",
    fields: [],
    defaults: {},
  },
];

/** Guard: is this string a real engine node type? */
export function nodeTypeExists(id: string): id is NodeType {
  return (NODE_TYPES as readonly string[]).includes(id);
}

/** Taxonomy entry for a type (throws on unknown ids — invariant helper). */
export function nodeTypeDef(type: NodeType): WorkflowNodeTypeDef {
  const entry = WORKFLOW_NODE_TYPES.find((e) => e.id === type);
  if (entry === undefined) throw new Error(`unknown node type "${type}"`);
  return entry;
}

/** Palette category of a node type. */
export function nodeCategory(type: NodeType): NodeCategory {
  return nodeTypeDef(type).category;
}

/** Human label of a node type. */
export function nodeLabel(type: NodeType): string {
  return nodeTypeDef(type).label;
}

/** Canvas defaults of a node type (click-to-add seeds from here). */
export function nodeDefaults(type: NodeType): Partial<GraphNode> {
  return nodeTypeDef(type).defaults;
}

/**
 * Canvas handle semantics, matching the backend edge model: an edge flows
 * node → node, so `start` has no incoming (target) handle and `end` has no
 * outgoing (source) handle; every other type gets both.
 */
export function hasTargetHandle(type: NodeType): boolean {
  return type !== "start";
}

export function hasSourceHandle(type: NodeType): boolean {
  return type !== "end";
}

/**
 * Sparse per-node field values on the canvas — primitives only, keyed by
 * GraphNode field names. `condition`/`params` live in the opaque
 * `FlowNodeData` slots instead (see workflow-flow.ts).
 */
export type NodeFieldValues = Record<
  string,
  string | number | string[] | boolean | undefined
>;

/** Keep only the primitive part of a field value that fits its kind. */
function sanitizeFieldValue(
  field: NodeFieldDef,
  raw: unknown,
): string | number | string[] | boolean | undefined {
  switch (field.kind) {
    case "toggle":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "tokens":
      // GraphNode.ctx is number | string (the engine passes it through).
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
    case "select":
      return typeof raw === "string" && field.options?.includes(raw) ? raw : undefined;
    case "textarea":
      // `body` is the one textarea-shaped field whose value IS a string[].
      if (Array.isArray(raw)) {
        return field.key === "body"
          ? raw.filter((item): item is string => typeof item === "string")
          : undefined;
      }
      return typeof raw === "string" ? raw : undefined;
    case "text":
    case "code":
      return typeof raw === "string" ? raw : undefined;
  }
}

/**
 * Whitelist a raw field-values record against the taxonomy + the universal
 * `parallel` flag (a real GraphNode field the backend keeps on every node),
 * dropping unknown keys and type-invalid values — the same "unknown fields
 * are dropped, known fields type-checked" admission the backend parser runs.
 * Input is deliberately `Record<string, unknown>` (admission boundary);
 * the OUTPUT is always a clean `NodeFieldValues`.
 */
export function sanitizeNodeFields(
  type: NodeType,
  values: Record<string, unknown>,
): NodeFieldValues {
  const def = nodeTypeDef(type);
  const out: NodeFieldValues = {};
  if (values.parallel !== undefined) {
    if (typeof values.parallel === "boolean") out.parallel = values.parallel;
  }
  for (const field of def.fields) {
    if (field.key === "condition") continue; // opaque AST slot, not a primitive
    const raw = values[field.key];
    if (raw === undefined) continue;
    const cleaned = sanitizeFieldValue(field, raw);
    if (cleaned !== undefined) out[field.key] = cleaned;
  }
  return out;
}

/**
 * Fresh canvas id for a type: kebab form of the type id plus a numeric
 * suffix when the base is taken (deduped against `taken`). Stable for a
 * given input set — no randomness.
 */
export function makeNodeId(type: NodeType, taken: ReadonlySet<string>): string {
  const base = type.replace("_", "-").replace(".", "-");
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Render a primitive field value for display (never throws on odd shapes). */
export function formatValue(
  kind: FieldKind,
  value: unknown,
): string {
  if (value === undefined || value === null || value === "") return "—";
  if (kind === "number" || kind === "tokens") {
    return typeof value === "number" ? String(value) : String(value);
  }
  if (kind === "toggle") return value === true ? "on" : "off";
  if (Array.isArray(value)) {
    return value.length === 0 ? "—" : value.join(", ");
  }
  if (typeof value === "string") return value;
  return String(value);
}