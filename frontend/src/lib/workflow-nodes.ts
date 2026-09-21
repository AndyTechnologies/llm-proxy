/**
 * Editor node palette + pure graph helpers (Task 6.7, workflow-editor spec).
 *
 * Pure functions only — no DOM, no stores — so the Svelte canvas stays thin
 * and the palette/cycle/validation logic is unit-tested with `bun test`
 * (relative imports, no Vite alias, so the same file runs in both runners).
 */
import type { GraphEdge, GraphNode, GraphPipeline, NodeType } from "../../../src/orchestrator/graph.js";
import { NODE_TYPES, validateGraph } from "../../../src/orchestrator/graph.js";
import { parseWorkflowGraph, serializeWorkflowGraph } from "../../../src/orchestrator/workflow-yaml.js";

/** A node on the canvas: the engine node + canvas position + display label. */
export interface EditorNode extends GraphNode {
  position: { x: number; y: number };
  data: { label: string };
}

/** An edge on the canvas (xyflow shape), carrying the engine `guard`. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  guard?: "true" | "false";
}

/** Canvas node with the engine's edge shape (for cycle/validation checks). */
export interface EditorGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PaletteEntry {
  type: NodeType;
  label: string;
  description: string;
  defaults: Omit<GraphNode, "id" | "type">;
}

/** The full node taxonomy as a palette (≥ 10 types, per the spec). */
export const PALETTE: readonly PaletteEntry[] = [
  {
    type: "start",
    label: "Start",
    description: "Graph entry — exactly one per workflow",
    defaults: {},
  },
  {
    type: "end",
    label: "End",
    description: "Graph exit — the last response becomes the completion",
    defaults: {},
  },
  {
    type: "llm_call",
    label: "LLM call",
    description: "Generate with a model (mode: generate/refine/passthrough)",
    defaults: { model: "llama", mode: "generate" },
  },
  {
    type: "condition",
    label: "Condition",
    description: "Guard expression selecting true/false branches",
    defaults: { condition: { op: "exists", field: "lastResponse.content" } },
  },
  {
    type: "loop",
    label: "Loop",
    description: "Repeat a body of nodes",
    defaults: { body: [], iterations: 1 },
  },
  {
    type: "fan",
    label: "Fan",
    description: "Fan out branches in parallel",
    defaults: { parallel: true },
  },
  {
    type: "join",
    label: "Join",
    description: "Merge branch results before continuing",
    defaults: {},
  },
  {
    type: "pipeline",
    label: "Pipeline",
    description: "Compose another stored workflow",
    defaults: { pipeline: "" },
  },
  {
    type: "rag_local",
    label: "RAG (local)",
    description: "Local retrieval over chunked documents",
    defaults: { k: 4 },
  },
  {
    type: "data.code",
    label: "Data (code)",
    description: "Sandboxed script step",
    defaults: { code: "// sandboxed step\n" },
  },
  {
    type: "memory",
    label: "Memory",
    description: "Conversation memory scope",
    defaults: {},
  },
  {
    type: "embeddings",
    label: "Embeddings",
    description: "Embed the last response (or an explicit text)",
    defaults: {},
  },
  {
    type: "router",
    label: "Router",
    description: "Route by a comparison (e.g. status or content)",
    defaults: {
      condition: { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
    },
  },
  {
    type: "output",
    label: "Output",
    description: "Emit an explicit output from the graph",
    defaults: {},
  },
];

/** The palette covers the taxonomy exactly (palette completeness gate). */
export function paletteCoversTaxonomy(): boolean {
  return (
    PALETTE.length >= 10 &&
    PALETTE.every((entry) => NODE_TYPES.includes(entry.type)) &&
    NODE_TYPES.every((type) => PALETTE.some((entry) => entry.type === type))
  );
}

export function paletteFor(type: NodeType): PaletteEntry {
  const entry = PALETTE.find((e) => e.type === type);
  if (entry === undefined) throw new Error(`no palette entry for node type "${type}"`);
  return entry;
}

/** Build one canvas node from the palette; ids increment per type. */
export function makeEditorNode(
  type: NodeType,
  counter: Map<string, number>,
  position: { x: number; y: number },
): EditorNode {
  const entry = paletteFor(type);
  const n = (counter.get(type) ?? 0) + 1;
  counter.set(type, n);
  const base = entry.defaults as GraphNode;
  return {
    id: `${type}-${n}`,
    type,
    ...base,
    position,
    data: { label: entry.label },
  };
}

export function flowEdgeFrom(edge: GraphEdge): FlowEdge {
  return {
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    ...(edge.guard !== undefined ? { guard: edge.guard } : {}),
  };
}

export function graphEdgeFrom(edge: FlowEdge): GraphEdge {
  return {
    from: edge.source,
    to: edge.target,
    ...(edge.guard !== undefined ? { guard: edge.guard } : {}),
  };
}

/** True when adding the edge `from → to` would close a cycle. */
export function wouldCreateCycle(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = out.get(edge.from) ?? [];
    list.push(edge.to);
    out.set(edge.from, list);
  }
  // BFS from the target; reaching the source means the new edge closes a loop.
  const seen = new Set<string>([to]);
  const queue = [to];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of out.get(current) ?? []) {
      if (next === from) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Engine validation over the current canvas (missing fields, structure). */
export function validateEditorGraph(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const graph: GraphPipeline = { id: "workflow", nodes, edges };
  return validateGraph(graph, {}).errors;
}

/** Export the canvas to the workflow YAML doc (positions/labels stripped). */
export function editorToYaml(
  nodes: EditorNode[],
  edges: FlowEdge[],
  name: string,
): string {
  const cleanNodes = nodes.map(({ position: _position, data: _data, ...rest }) => rest as GraphNode);
  return serializeWorkflowGraph(
    {
      id: "workflow",
      name,
      nodes: cleanNodes,
      edges: edges.map(graphEdgeFrom),
    },
    null,
  );
}

export type YAMLImportResult =
  | { ok: true; name: string; nodes: EditorNode[]; edges: FlowEdge[] }
  | { ok: false; error: string };

/** Import a workflow YAML doc onto the canvas (flow-down layout). */
export function yamlToEditor(source: string): YAMLImportResult {
  let doc: ReturnType<typeof parseWorkflowGraph>;
  try {
    doc = parseWorkflowGraph(source);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const graph = doc.graph;
  const nodes: EditorNode[] = graph.nodes.map((node, index) => ({
    ...node,
    position: { x: 40 + index * 240, y: 120 },
    data: { label: paletteFor(node.type).label },
  }));
  return {
    ok: true,
    name: graph.name ?? graph.id,
    nodes,
    edges: graph.edges.map(flowEdgeFrom),
  };
}