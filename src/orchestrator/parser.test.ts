import { describe, expect, test } from "bun:test";
import type { ParsedChain } from "./parser.js";
import { chainToGraph } from "./parser.js";

function chain(name: string, steps: { name?: string; type: string; model: string }[]): ParsedChain {
  return {
    name,
    displayName: name,
    steps: steps.map((s) => ({
      ...s,
      // ResolvedStep always carries a provider.
      provider: "llama-server",
    })),
  } as ParsedChain;
}

describe("chainToGraph", () => {
  test("materializes a linear chain as start -> steps -> end", () => {
    const g = chainToGraph(
      chain("linear", [
        { name: "s1", type: "generate", model: "m1" },
        { name: "s2", type: "refine", model: "m2" },
      ]),
    );

    expect(g.id).toBe("linear");
    expect(g.nodes.map((n) => n.id)).toEqual(["start", "s1", "s2", "end"]);
    expect(g.nodes[1]).toEqual({ id: "s1", type: "llm_call", model: "m1" });
    expect(g.nodes[2]).toEqual({ id: "s2", type: "llm_call", model: "m2" });
    expect(g.edges).toEqual([
      { from: "start", to: "s1" },
      { from: "s1", to: "s2" },
      { from: "s2", to: "end" },
    ]);
  });

  test("falls back to step-N ids when a step has no name", () => {
    const g = chainToGraph(
      chain("anon", [
        { type: "generate", model: "mx" },
        { type: "passthrough", model: "my" },
      ]),
    );

    expect(g.nodes.map((n) => n.id)).toEqual(["start", "step-0", "step-1", "end"]);
    // passthrough keeps its model and is materialized as an llm_call node.
    expect(g.nodes[2]).toEqual({ id: "step-1", type: "llm_call", model: "my" });
    expect(g.edges).toEqual([
      { from: "start", to: "step-0" },
      { from: "step-0", to: "step-1" },
      { from: "step-1", to: "end" },
    ]);
  });

  test("a chain with no steps yields start -> end with no step nodes", () => {
    const g = chainToGraph(chain("empty", []));
    expect(g.nodes.map((n) => n.id)).toEqual(["start", "end"]);
    expect(g.edges).toEqual([{ from: "start", to: "end" }]);
  });
});
