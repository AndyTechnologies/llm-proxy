/**
 * Config graph schema tests (strict TDD — task 1.1/8.6).
 *
 * Verifies the graph-migrated chain zod schema:
 *   - a `chain` accepts `nodes`/`edges` and rejects the legacy `steps` shape,
 *   - `graphNodeSchema` validates the full field set including `pos`, `mode`,
 *     `pipeline`, `condition`, `on_429`, `tool_calls_route`,
 *   - `graphEdgeSchema` requires `from`/`to` and optional `guard`,
 *   - `astExprSchema` recurses (`op: not`/`logical`) and caps nesting at 12,
 *   - the `pipeline` node type is accepted.
 */
import { describe, expect, test } from "bun:test";
import { chainConfigSchema, configSchema } from "./schema.js";
import { astDepth } from "./schema.js";

describe("chainConfigSchema — graph nodes/edges (task 1.1)", () => {
  test("accepts a chain with nodes/edges", () => {
    const parsed = chainConfigSchema.parse({
      displayName: "Demo",
      provider: "llama-server",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "llm_call", model: "M", mode: "generate", pos: { x: 1, y: 2 } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    });

    expect(parsed.displayName).toBe("Demo");
    expect(parsed.nodes).toHaveLength(3);
    // pos is preserved through the schema (config-load round-trip).
    expect(parsed.nodes[1].pos).toEqual({ x: 1, y: 2 });
    // mode defaults to generate when omitted on an llm_call node.
    expect(parsed.nodes[1].mode).toBe("generate");
    expect(parsed.edges).toHaveLength(2);
  });

  test("rejects the legacy steps shape (migration is complete)", () => {
    expect(() =>
      chainConfigSchema.parse({
        nodes: [{ id: "start", type: "start" }],
        steps: [{ type: "generate", model: "M" }],
      }),
    ).toThrow();
  });

  test("edges accept an optional guard and reject unknown keys (strict)", () => {
    const parsed = chainConfigSchema.parse({
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "llm_call", model: "M" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", guard: "true" },
      ],
    });
    expect(parsed.edges[1].guard).toBe("true");

    // strict() objects reject unknown top-level keys.
    expect(() => chainConfigSchema.parse({ bogus: true })).toThrow();
  });

  test("accepts the pipeline node type", () => {
    const parsed = chainConfigSchema.parse({
      nodes: [
        { id: "start", type: "start" },
        { id: "compose", type: "pipeline", pipeline: "other", params: { topic: "x" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "compose" },
        { from: "compose", to: "end" },
      ],
    });
    expect(parsed.nodes[1].type).toBe("pipeline");
    expect(parsed.nodes[1].pipeline).toBe("other");
  });

  test("accepts condition/on_429/tool_calls_route fields on nodes", () => {
    const parsed = chainConfigSchema.parse({
      nodes: [
        { id: "start", type: "start" },
        {
          id: "a",
          type: "llm_call",
          model: "M",
          on_429: "fallback",
          tool_calls_route: "tool",
        },
        { id: "fallback", type: "llm_call", model: "F" },
        { id: "tool", type: "llm_call", model: "T" },
        {
          id: "cond",
          type: "condition",
          condition: { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
        },
        { id: "end", type: "end" },
      ],
      edges: [],
    });
    expect(parsed.nodes[1].on_429).toBe("fallback");
    expect(parsed.nodes[1].tool_calls_route).toBe("tool");
    expect(parsed.nodes[4].condition).toMatchObject({ op: "compare" });
  });
});

describe("astExprSchema — recursion + depth cap (task 1.1)", () => {
  test("a nested logical condition parses within the depth limit", () => {
    const cond = {
      op: "logical",
      and: true,
      args: [
        { op: "not", child: { op: "exists", field: "error" } },
        { op: "compare", field: "lastResponse.status", op2: ">=", value: 200 },
      ],
    } as const;
    const parsed = chainConfigSchema.parse({
      nodes: [
        { id: "start", type: "start" },
        { id: "cond", type: "condition", condition: cond },
        { id: "end", type: "end" },
      ],
      edges: [],
    });
    expect(parsed.nodes[1].condition).toMatchObject({ op: "logical" });
  });

  test("rejects a condition nested deeper than 12 levels", () => {
    // Build a 13-deep `not` chain: 13 nested `not` nodes.
    let cond: unknown = { op: "exists", field: "error" };
    for (let i = 0; i < 13; i++) {
      cond = { op: "not", child: cond };
    }
    expect(() =>
      chainConfigSchema.parse({
        nodes: [
          { id: "start", type: "start" },
          { id: "cond", type: "condition", condition: cond },
          { id: "end", type: "end" },
        ],
        edges: [],
      }),
    ).toThrow();
  });

  test("astDepth measures nesting depth", () => {
    expect(astDepth({ op: "exists", field: "error" })).toBe(1);
    const two = { op: "not", child: { op: "exists", field: "error" } } as const;
    expect(astDepth(two)).toBe(2);
  });
});

describe("configSchema — top-level chains accept graphs (task 1.1)", () => {
  test("parses a full config with graph chains", () => {
    const parsed = configSchema.parse({
      server: { host: "127.0.0.1", port: 8090 },
      llama: {},
      defaultChain: "orch",
      chains: {
        orch: {
          nodes: [
            { id: "start", type: "start" },
            { id: "a", type: "llm_call", model: "M" },
            { id: "end", type: "end" },
          ],
          edges: [{ from: "start", to: "a" }, { from: "a", to: "end" }],
        },
      },
    });
    expect(parsed.chains["orch"].nodes).toHaveLength(3);
    expect(parsed.chains["orch"].edges).toHaveLength(2);
  });
});
