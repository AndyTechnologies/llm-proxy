/**
 * Workflow YAML interchange (Task 6.8).
 *
 * The editor's export shape is the doc: `name` (graph id), optional
 * `version` (workflow revision, owned by the workflow store), `nodes`
 * (array of node objects with the engine's field names) and `edges`
 * (from/to with an optional `guard`).
 *
 * `parse` is structural admission: only syntax that would corrupt the graph
 * fails here, and every failure NAMES the offending node/edge slot. Semantic
 * rules (models exist, connectivity, loop-boundary cycles, …) stay in
 * `validateGraph`, which the API + editor run after a successful parse.
 * Unknown fields are tolerated for forward compatibility and dropped.
 *
 * Round-trip guarantee: `parse(serialize(graph, v)).graph` deep-equals
 * `graph` for any graph the store accepts.
 */

import { parse, stringify } from "yaml";
import { NODE_TYPES } from "./graph.js";
import type { AstExpr, GraphEdge, GraphNode, GraphPipeline, NodeType } from "./graph.js";

/** A parsed YAML workflow document. */
export interface WorkflowYamlDoc {
  /** Workflow revision from the doc, or null when the doc omits it. */
  version: number | null;
  graph: GraphPipeline;
}

/** Stable serialization order for a node (human diffable exports). */
const NODE_FIELDS: (keyof GraphNode)[] = [
  "id",
  "type",
  "parallel",
  "model",
  "provider",
  "condition",
  "body",
  "pipeline",
  "params",
  "mode",
  "ctx",
  "system",
  "assistant",
  "user",
  "on_429",
  "tool_calls_route",
  "code",
  "k",
  "text",
  "convId",
  "iterations",
];

/** Export a graph (and optional revision) as the YAML doc. */
export function serializeWorkflowGraph(graph: GraphPipeline, version?: number | null): string {
  const nodes = graph.nodes.map((n) => {
    const out: Record<string, unknown> = {};
    for (const key of NODE_FIELDS) {
      const value = n[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  });
  const edges = graph.edges.map((e) => {
    const out: Record<string, unknown> = { from: e.from, to: e.to };
    if (e.guard !== undefined) out.guard = e.guard;
    return out;
  });
  // `name` is the display label (store identity when no explicit `id`).
  // Emit an explicit `id` when it differs so the round-trip preserves both.
  const display = graph.name ?? graph.id;
  return stringify({
    name: display,
    ...(graph.id !== display ? { id: graph.id } : {}),
    ...(version !== undefined && version !== null ? { version } : {}),
    nodes,
    edges,
  });
}

/** Structural parse of the YAML doc into a graph. Throws on malformed input. */
export function parseWorkflowGraph(source: string): WorkflowYamlDoc {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (cause) {
    throw new Error(`workflow YAML is not valid: ${String(cause)}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("workflow document must be a YAML object");
  }
  const record = doc as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name : "workflow";
  const id =
    typeof record.id === "string" && record.id.trim() !== "" ? record.id.trim() : name;
  const version = record.version === undefined || record.version === null ? null : record.version;
  if (version !== null && typeof version !== "number") {
    throw new Error(`workflow "${name}": "version" must be a number`);
  }

  const nodes = parseNodes(record.nodes, name);
  const edges = parseEdges(record.edges, name, nodes);

  return {
    version,
    graph: { id, name, nodes, edges },
  };
}

function parseNodes(raw: unknown, name: string): GraphNode[] {
  if (!Array.isArray(raw)) throw new Error(`workflow "${name}": "nodes" must be an array`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`node at index ${index} must be an object`);
    }
    const node = entry as Record<string, unknown>;
    if (typeof node.id !== "string" || node.id.trim() === "") {
      throw new Error(`node at index ${index} is missing its "id"`);
    }
    const id = node.id.trim();
    if (seen.has(id)) throw new Error(`duplicate id "${id}"`);
    seen.add(id);
    if (typeof node.type !== "string" || !(NODE_TYPES as readonly string[]).includes(node.type)) {
      throw new Error(`node "${id}": unsupported node type "${String(node.type)}"`);
    }
    if (
      node.mode !== undefined &&
      node.mode !== "generate" &&
      node.mode !== "refine" &&
      node.mode !== "passthrough"
    ) {
      throw new Error(`node "${id}": invalid mode "${String(node.mode)}"`);
    }
    const picked: GraphNode = { id, type: node.type as NodeType };
    if (node.parallel !== undefined) picked.parallel = Boolean(node.parallel);
    if (node.model !== undefined && typeof node.model === "string") picked.model = node.model;
    if (node.provider !== undefined && typeof node.provider === "string") picked.provider = node.provider;
    if (node.condition !== undefined && typeof node.condition === "object") {
      picked.condition = node.condition as AstExpr;
    }
    if (Array.isArray(node.body)) picked.body = node.body.filter((m): m is string => typeof m === "string");
    if (node.pipeline !== undefined && typeof node.pipeline === "string") picked.pipeline = node.pipeline;
    if (node.params !== undefined && typeof node.params === "object") {
      picked.params = node.params as Record<string, string>;
    }
    if (node.mode !== undefined) picked.mode = node.mode as GraphNode["mode"];
    if (node.ctx !== undefined) picked.ctx = node.ctx as number | string;
    if (node.system !== undefined && typeof node.system === "string") picked.system = node.system;
    if (node.assistant !== undefined && typeof node.assistant === "string") picked.assistant = node.assistant;
    if (node.user !== undefined && typeof node.user === "string") picked.user = node.user;
    if (node.on_429 !== undefined && typeof node.on_429 === "string") picked.on_429 = node.on_429;
    if (node.tool_calls_route !== undefined && typeof node.tool_calls_route === "string") {
      picked.tool_calls_route = node.tool_calls_route;
    }
    if (node.code !== undefined && typeof node.code === "string") picked.code = node.code;
    if (node.k !== undefined && typeof node.k === "number") picked.k = node.k;
    if (node.text !== undefined && typeof node.text === "string") picked.text = node.text;
    if (node.convId !== undefined && typeof node.convId === "string") picked.convId = node.convId;
    if (node.iterations !== undefined && typeof node.iterations === "number") {
      picked.iterations = node.iterations;
    }
    return picked;
  });
}

function parseEdges(
  raw: unknown,
  name: string,
  nodes: GraphNode[],
): GraphEdge[] {
  if (!Array.isArray(raw)) throw new Error(`workflow "${name}": "edges" must be an array`);
  const ids = new Set(nodes.map((n) => n.id));
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`edge at index ${index} must be an object`);
    }
    const edge = entry as Record<string, unknown>;
    if (typeof edge.from !== "string" || edge.from.trim() === "") {
      throw new Error(`edge at index ${index} is missing its "from"`);
    }
    if (typeof edge.to !== "string" || edge.to.trim() === "") {
      throw new Error(`edge at index ${index} is missing its "to"`);
    }
    const from = edge.from.trim();
    const to = edge.to.trim();
    if (!ids.has(from)) throw new Error(`edge "${from}"→"${to}": unknown node "${from}"`);
    if (!ids.has(to)) throw new Error(`edge "${from}"→"${to}": unknown node "${to}"`);
    const guard = edge.guard;
    if (guard !== undefined && guard !== "true" && guard !== "false") {
      throw new Error(`edge "${from}"→"${to}": guard must be "true" or "false"`);
    }
    const out: GraphEdge = { from, to };
    if (guard !== undefined) out.guard = guard;
    return out;
  });
}