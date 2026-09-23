/**
 * U06 — structural pre-validation mirror tests.
 *
 * Mirrors the `validateGraph` cases the task mandates structurally: zero
 * start, zero end, ghost edges, missing per-type fields, missing loop body
 * member (engine-runner admission — a documented superset), and the
 * on_429 / tool_calls_route target checks.
 */
import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphNode, GraphPipeline } from "../../../src/orchestrator/graph.js";
import { validateWorkflow } from "./workflow-validate.js";

function graph(overrides: { nodes?: GraphNode[]; edges?: GraphEdge[]; id?: string } = {}): GraphPipeline {
  return {
    id: overrides.id ?? "test",
    nodes:
      overrides.nodes ??
      [
        { id: "start", type: "start" },
        { id: "end", type: "end" },
      ],
    edges: overrides.edges ?? [],
  };
}

const valid = graph();

describe("validateWorkflow — structure", () => {
  test("accepts a minimal valid graph (start + end)", () => {
    const result = validateWorkflow(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("zero start nodes", () => {
    const result = validateWorkflow(
      graph({
        nodes: [
          { id: "llm", type: "llm_call", model: "smol" },
          { id: "end", type: "end" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('graph "test" must have exactly one start node (found 0)');
  });

  test("multiple start nodes", () => {
    const result = validateWorkflow(
      graph({
        nodes: [
          { id: "s1", type: "start" },
          { id: "s2", type: "start" },
          { id: "end", type: "end" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toBe('graph "test" must have exactly one start node (found 2)');
  });

  test("zero end nodes", () => {
    const result = validateWorkflow(
      graph({
        nodes: [
          { id: "start", type: "start" },
          { id: "llm", type: "llm_call", model: "smol" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('graph "test" must have at least one end node');
  });

  test("ghost edge from side", () => {
    const result = validateWorkflow(
      graph({ edges: [{ from: "nope", to: "end" }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('edge from "nope" references an unknown node');
  });

  test("ghost edge to side", () => {
    const result = validateWorkflow(
      graph({ edges: [{ from: "start", to: "nope" }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('edge to "nope" references an unknown node');
  });

  test("missing llm_call model", () => {
    const result = validateWorkflow(
      graph({
        nodes: [
          { id: "start", type: "start" },
          { id: "llm", type: "llm_call" },
          { id: "end", type: "end" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('node LLM_CALL (llm) is missing its required "model" field');
  });

  test("missing required per-type fields", () => {
    const result = validateWorkflow(
      graph({
        nodes: [
          { id: "start", type: "start" },
          { id: "cond", type: "condition" },
          { id: "loop", type: "loop" },
          { id: "pipe", type: "pipeline" },
          { id: "code", type: "data.code", code: "   " },
          { id: "router", type: "router" },
          { id: "end", type: "end" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'node CONDITION (cond) is missing its required "condition" field',
      'node LOOP (loop) is missing its required "body" field',
      'node PIPELINE (pipe) is missing its required "pipeline" field',
      'node DATA.CODE (code) is missing its required "code" field',
      'node ROUTER (router) is missing its required "condition" field',
    ]);
  });

  test("missing loop body member (engine-runtime admission)", () => {
    const result = validateWorkflow(
      graph({
        nodes: [
          { id: "start", type: "start" },
          { id: "loop", type: "loop", body: ["ghost"] },
          { id: "end", type: "end" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('node LOOP (loop) body references an unknown node "ghost"');
  });

  test("on_429 and tool_calls_route targets must exist", () => {
    const result = validateWorkflow(
      graph({
        nodes: [
          { id: "start", type: "start" },
          { id: "llm", type: "llm_call", model: "smol", on_429: "ghost", tool_calls_route: "void" },
          { id: "end", type: "end" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('node LLM_CALL model smol (llm) references an unknown on_429 target ("ghost")');
    expect(result.errors).toContain(
      'node LLM_CALL model smol (llm) references an unknown tool_calls_route target ("void")',
    );
  });

  test("known model existence is checked only when a set is provided", () => {
    const nodes: GraphNode[] = [
      { id: "start", type: "start" },
      { id: "llm", type: "llm_call", model: "nope" },
      { id: "end", type: "end" },
    ];
    expect(validateWorkflow(graph({ nodes })).valid).toBe(true);
    const withModels = validateWorkflow(graph({ nodes }), { knownModels: ["smol"] });
    expect(withModels.valid).toBe(false);
    expect(withModels.errors).toContain('node LLM_CALL (llm) references an unknown model "nope"');
    // Empty set behaves like absent (backend parity: no model check).
    expect(validateWorkflow(graph({ nodes }), { knownModels: [] }).valid).toBe(true);
  });
});