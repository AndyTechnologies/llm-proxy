/**
 * Graph ⇄ canvas conversion + workflow YAML helpers (U05).
 *
 * The canvas (SvelteFlow) and the engine (`GraphPipeline`) are two shapes of
 * the same graph:
 *
 *   - `graphToFlow` converts engine → canvas, synthesizing deterministic
 *     positions (layers from `start` nodes, BFS over edges, cycle-safe) so
 *     any stored workflow has a stable, readable layout with no geometry of
 *     its own to store.
 *   - `flowToGraph` converts canvas → engine, admitting ONLY taxonomy-whitelist
 *     fields (via `sanitizeNodeFields`) plus the universal `parallel` flag and
 *     the opaque `condition` / `params` slots — the editor can never emit a
 *     field the engine would drop.
 *
 * YAML goes through the backend parser/serializer rather than a second
 * implementation: `parse(serialize(graph))` deep-equals `graph` round-trip is
 * guaranteed there, so this module only wraps it in a friendly result type.
 *
 * Pure functions — no DOM, no Svelte, no stores — so everything here runs
 * under `bun test` and in the Astro build.
 */
import {
  serializeWorkflowGraph,
  parseWorkflowGraph,
} from "../../../src/orchestrator/workflow-yaml.js";
import {
  nodeTypeDef,
  sanitizeNodeFields,
  type FieldKind,
  type NodeFieldValues,
  type NodeType,
} from "./workflow-nodes.js";
import type {
  AstExpr,
  GraphEdge,
  GraphNode,
  GraphPipeline,
} from "./workflow-nodes.js";

// ── Canvas shapes ────────────────────────────────────────────────────────────

/** SvelteFlow node type keys — one custom node component per group. */
export type NodeGroup =
  | "wf-start-end"
  | "wf-llm"
  | "wf-branch"
  | "wf-data"
  | "wf-pipeline"
  | "wf-output";

export const NODE_GROUPS: readonly NodeGroup[] = [
  "wf-start-end",
  "wf-llm",
  "wf-branch",
  "wf-data",
  "wf-pipeline",
  "wf-output",
];

/** Map each engine node type to its custom-node group. */
export function nodeGroupOf(type: NodeType): NodeGroup {
  switch (type) {
    case "start":
    case "end":
      return "wf-start-end";
    case "llm_call":
      return "wf-llm";
    case "condition":
    case "loop":
    case "fan":
    case "join":
    case "router":
      return "wf-branch";
    case "rag_local":
    case "data.code":
    case "memory":
    case "embeddings":
      return "wf-data";
    case "pipeline":
      return "wf-pipeline";
    case "output":
      return "wf-output";
  }
}

/** Per-node data the canvas carries; positions live on the node object. */
export interface FlowNodeData {
  /** The engine node type this canvas node represents (group discriminator). */
  wNodeType: NodeType;
  /** Display label (taxonomy label at creation; edited in U06). */
  label: string;
  /** Primitive GraphNode fields present on this node (whitelisted). */
  values: NodeFieldValues;
  /** SAFE AST for condition/router nodes — opaque slot (round-trip fidelity). */
  condition?: AstExpr;
  /** Input parameters for pipeline composition nodes — opaque slot. */
  params?: Record<string, string>;
}

export interface FlowNode {
  id: string;
  /** Custom-node group key (one SvelteFlow node type per group). */
  type: NodeGroup;
  position: FlowPosition;
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** Engine guard ("true"/"false") preserved for U06 — not rendered yet. */
  guard?: "true" | "false";
}

/** A point on the canvas in flow coordinates. */
export type FlowPosition = { x: number; y: number };

/**
 * Minimal seam over the SvelteFlow instance the island needs (U05). The real
 * instance exists only inside the SvelteFlow provider context, so a child
 * component exposes exactly these two capabilities to the island: fit the
 * viewport, and translate a client (screen) point into flow coordinates —
 * used for click-to-add at the canvas center.
 */
export interface CanvasApi {
  fitView: (options?: { padding?: number }) => void;
  screenToFlowPosition: (position: FlowPosition, snapToGrid?: boolean) => FlowPosition;
}

// ── Layout ───────────────────────────────────────────────────────────────────

const LAYER_GAP_X = 280;
const ROW_GAP_Y = 150;
const MARGIN = 40;

/**
 * Deterministic layered layout: BFS from `start` nodes over edges assigns a
 * layer (column), nodes are stacked by array order within their layer, and
 * any node unreached from a start (no start, disconnected islands) is appended
 * after the BFS layers in array order. Pure function of the graph — the same
 * input always yields the same positions, so round-trips are stable.
 */
function layoutFor(graph: GraphPipeline): Map<string, FlowPosition> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const targets = out.get(edge.from) ?? [];
    targets.push(edge.to);
    out.set(edge.from, targets);
  }

  const layerOf = new Map<string, number>();
  const queue: string[] = [];
  for (const node of graph.nodes) {
    if (node.type === "start") {
      layerOf.set(node.id, 0);
      queue.push(node.id);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const id = queue[head];
    head += 1;
    const layer = layerOf.get(id) ?? 0;
    for (const next of out.get(id) ?? []) {
      if (layerOf.has(next)) continue; // cycle-safe: first visit wins
      layerOf.set(next, layer + 1);
      queue.push(next);
    }
  }

  let fallback = 0;
  for (const layer of layerOf.values()) fallback = Math.max(fallback, layer);
  for (const node of graph.nodes) {
    if (!layerOf.has(node.id)) {
      fallback += 1;
      layerOf.set(node.id, fallback);
    }
  }

  const rowIn = new Map<number, number>();
  const positions = new Map<string, FlowPosition>();
  for (const node of graph.nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    const row = rowIn.get(layer) ?? 0;
    rowIn.set(layer, row + 1);
    positions.set(node.id, { x: MARGIN + layer * LAYER_GAP_X, y: MARGIN + row * ROW_GAP_Y });
  }
  return positions;
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * Unique edge id for a connection — the canonical form is `${from}->${to}`
 * with a `#n` suffix when a parallel edge already used it (the engine allows
 * duplicate edges; the canvas needs unique ids). Deterministic for a given
 * ordered set.
 */
export function uniqueEdgeId(
  from: string,
  to: string,
  existing: ReadonlySet<string>,
): string {
  let id = `${from}->${to}`;
  let suffix = 2;
  while (existing.has(id)) {
    id = `${from}->${to}#${suffix}`;
    suffix += 1;
  }
  return id;
}

function edgeFromGraph(edge: GraphEdge, taken: Set<string>): FlowEdge {
  const id = uniqueEdgeId(edge.from, edge.to, taken);
  taken.add(id);
  const out: FlowEdge = { id, source: edge.from, target: edge.to };
  if (edge.guard !== undefined) out.guard = edge.guard;
  return out;
}

/** Engine graph → canvas nodes/edges with synthesized layered positions. */
export function graphToFlow(graph: GraphPipeline): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const positions = layoutFor(graph);
  const nodes: FlowNode[] = graph.nodes.map((node) => {
    const def = nodeTypeDef(node.type);
    const data: FlowNodeData = {
      wNodeType: node.type,
      label: def.label,
      values: pickNodeFieldValues(node),
    };
    if (node.condition !== undefined && (node.type === "condition" || node.type === "router")) {
      data.condition = node.condition;
    }
    if (node.params !== undefined && node.type === "pipeline") {
      data.params = node.params;
    }
    return {
      id: node.id,
      type: nodeGroupOf(node.type),
      position: positions.get(node.id) ?? { x: MARGIN, y: MARGIN },
      data,
    };
  });

  const taken = new Set<string>();
  const edges: FlowEdge[] = graph.edges.map((edge) => edgeFromGraph(edge, taken));
  return { nodes, edges };
}

/** Pick the primitive, whitelisted fields a node carries onto the canvas. */
function pickNodeFieldValues(node: GraphNode): NodeFieldValues {
  const out: NodeFieldValues = {};
  if (node.parallel !== undefined) out.parallel = node.parallel;
  const def = nodeTypeDef(node.type);
  for (const field of def.fields) {
    if (field.key === "condition") continue; // opaque AST slot
    const raw = (node as unknown as Record<string, unknown>)[field.key];
    if (raw === undefined) continue;
    const cleaned = sanitizeFieldValueFor(field.kind, field.key, raw);
    if (cleaned !== undefined) out[field.key] = cleaned;
  }
  return out;
}

function sanitizeFieldValueFor(
  kind: FieldKind,
  key: string,
  raw: unknown,
): string | number | string[] | boolean | undefined {
  switch (kind) {
    case "toggle":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "tokens":
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
    case "select":
      return typeof raw === "string" ? raw : undefined;
    case "textarea":
      if (Array.isArray(raw)) {
        return key === "body"
          ? raw.filter((item): item is string => typeof item === "string")
          : undefined;
      }
      return typeof raw === "string" ? raw : undefined;
    case "text":
    case "code":
      return typeof raw === "string" ? raw : undefined;
  }
}

/** Shape guard mirroring the backend's SAFE AST admission (structural only). */
function isAstExpr(value: unknown): value is AstExpr {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.op !== "string") return false;
  return (
    candidate.op === "exists" ||
    candidate.op === "not" ||
    candidate.op === "logical" ||
    candidate.op === "compare"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

/** Canvas nodes/edges → engine graph (whitelist admission, single id/type cast). */
export function flowToGraph(nodes: FlowNode[], edges: FlowEdge[]): GraphPipeline {
  const graphNodes: GraphNode[] = nodes.map((node) => {
    const type = node.data.wNodeType;
    const values = sanitizeNodeFields(type, node.data.values);
    const record: Record<string, unknown> = { id: node.id, type };
    for (const key of Object.keys(values)) record[key] = values[key];
    if ((type === "condition" || type === "router") && isAstExpr(node.data.condition)) {
      record.condition = node.data.condition;
    }
    if (type === "pipeline" && isStringRecord(node.data.params)) {
      record.params = node.data.params;
    }
    return record as GraphNode;
  });

  const graphEdges: GraphEdge[] = edges.map((edge) => {
    const out: GraphEdge = { from: edge.source, to: edge.target };
    if (edge.guard !== undefined) out.guard = edge.guard;
    return out;
  });
  return { id: "workflow", nodes: graphNodes, edges: graphEdges };
}

// ── YAML helpers ─────────────────────────────────────────────────────────────

export type WorkflowYamlResult =
  | { ok: true; graph: GraphPipeline }
  | { ok: false; error: string };

/**
 * Parse workflow YAML through the backend parser, wrapped in a friendly
 * result type (`{ ok: false, error }` on malformed input). The backend names
 * the offending node/edge slot in its error messages, which the editor shows
 * verbatim.
 */
export function parseWorkflowYamlToGraph(yamlText: string): WorkflowYamlResult {
  try {
    const doc = parseWorkflowGraph(yamlText);
    return { ok: true, graph: doc.graph };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid workflow YAML",
    };
  }
}

/** Serialize an engine graph to workflow YAML via the backend serializer. */
export function serializeGraphToYaml(graph: GraphPipeline): string {
  return serializeWorkflowGraph(graph, null);
}

// ── Display helpers (shared by node components and the inspector) ────────────

/** Human-readable one-line rendering of a SAFE AST expression. */
export function astSummary(expr: AstExpr): string {
  switch (expr.op) {
    case "exists":
      return `has ${expr.field}`;
    case "not":
      return `not (${astSummary(expr.child)})`;
    case "logical":
      return `${expr.and ? "all" : "any"}(${expr.args.map(astSummary).join(", ")})`;
    case "compare":
      return `${expr.field} ${expr.op2} ${JSON.stringify(expr.value)}`;
  }
}

/** Compact per-node summary lines for the canvas cards (best effort). */
export function nodeSummaryLines(data: FlowNodeData): { key: string; value: string }[] {
  const lines: { key: string; value: string }[] = [];
  switch (data.wNodeType) {
    case "llm_call": {
      const model = data.values.model;
      const mode = data.values.mode;
      if (typeof model === "string" && model !== "") lines.push({ key: "model", value: model });
      else lines.push({ key: "model", value: "unset" });
      if (typeof mode === "string") lines.push({ key: "mode", value: mode });
      if (typeof data.values.provider === "string" && data.values.provider !== "") {
        lines.push({ key: "provider", value: data.values.provider });
      }
      break;
    }
    case "loop": {
      lines.push({ key: "iterations", value: String(data.values.iterations ?? 1) });
      const count = Array.isArray(data.values.body) ? data.values.body.length : 0;
      lines.push({ key: "body", value: count > 0 ? `${count} ${count === 1 ? "node" : "nodes"}` : "unset" });
      break;
    }
    case "condition":
    case "router": {
      lines.push({
        key: "condition",
        value: data.condition !== undefined ? astSummary(data.condition) : "unset",
      });
      break;
    }
    case "pipeline": {
      const name = typeof data.values.pipeline === "string" ? data.values.pipeline : "";
      lines.push({ key: "pipeline", value: name !== "" ? name : "unset" });
      if (data.params !== undefined && Object.keys(data.params).length > 0) {
        lines.push({ key: "params", value: String(Object.keys(data.params).length) });
      }
      break;
    }
    case "rag_local": {
      if (typeof data.values.k === "number") {
        lines.push({ key: "top-k", value: String(data.values.k) });
      }
      break;
    }
    case "data.code": {
      const code = typeof data.values.code === "string" ? data.values.code : "";
      const count = code === "" ? 0 : code.split("\n").length;
      lines.push({ key: "code", value: count > 0 ? `${count} ${count === 1 ? "line" : "lines"}` : "unset" });
      break;
    }
    case "memory": {
      if (typeof data.values.convId === "string" && data.values.convId !== "") {
        lines.push({ key: "convId", value: data.values.convId });
      }
      break;
    }
    case "embeddings": {
      const text = typeof data.values.text === "string" ? data.values.text : "";
      lines.push({ key: "text", value: text !== "" ? truncate(text, 28) : "unset" });
      break;
    }
    case "fan": {
      if (data.values.parallel === true) lines.push({ key: "parallel", value: "on" });
      break;
    }
    case "start":
    case "end":
    case "join":
    case "output":
      break;
  }
  return lines;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}