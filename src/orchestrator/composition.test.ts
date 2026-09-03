/**
 * Pipeline composition tests (strict TDD — Slice B, task 2.3).
 *
 * pipeline-composition Req 2 "Bounded composition depth":
 *   - a nesting of invocations at depth 3 runs (default max 5)
 *   - a nesting at depth 6 fails with a clear depth-exceeded error
 * Req 3 "Input parameters to the invoked pipeline": params propagate in.
 * Req 1/4: invoked pipeline's output flows back; admission-time depth check.
 */
import { describe, expect, test } from "bun:test";
import type { GraphNode, GraphPipeline } from "./graph.js";
import {
  MAX_COMPOSITION_DEPTH,
  CompositionDepthError,
  createCompositionRuntime,
  mergeParams,
  resolveCompositionDepth,
  type CompositionOutput,
} from "./composition.js";

/** A pipeline whose body contains a single composition node (or none). */
function pipe(
  name: string,
  invokes?: string,
  params: Record<string, string> = {},
): GraphPipeline {
  const nodes: GraphNode[] = invokes
    ? [{ id: "comp", type: "pipeline", pipeline: invokes, params }]
    : [{ id: "leaf", type: "end" }];
  return { id: name, name, nodes, edges: [] };
}

describe("createCompositionRuntime — bounded depth", () => {
  test("depth-3 composition chain runs successfully (depth 3 <= max 5)", async () => {
    const store = new Map([
      ["P1", pipe("P1", "P2")],
      ["P2", pipe("P2", "P3")],
      ["P3", pipe("P3")], // leaf — no further composition
    ]);
    const calls: Array<{ name: string; depth: number }> = [];

    const runtime = createCompositionRuntime({
      getPipeline: (n) => store.get(n),
      executeBody: async (p, _params, depth, invoke) => {
        calls.push({ name: p.name ?? p.id, depth });
        const comp = p.nodes.find((n) => n.type === "pipeline");
        if (comp?.pipeline) return invoke(comp.pipeline, {}, depth);
        return leafOutput(p);
      },
    });

    const out = await runtime.invoke("P1", {}, 0);
    expect(calls.map((c) => c.name)).toEqual(["P1", "P2", "P3"]);
    expect(calls.map((c) => c.depth)).toEqual([1, 2, 3]);
    // The leaf output (P3) flows back up as the invoker's result.
    expect(out.lastResponse).toEqual({ content: "output-P3" });
    expect(out.lastStatus).toBe(200);
  });

  test("depth-6 composition chain fails with a clear depth-exceeded error (RED: depth-6 fails)", async () => {
    const store = new Map([
      ["P1", pipe("P1", "P2")],
      ["P2", pipe("P2", "P3")],
      ["P3", pipe("P3", "P4")],
      ["P4", pipe("P4", "P5")],
      ["P5", pipe("P5", "P6")],
      ["P6", pipe("P6")],
    ]);

    const runtime = createCompositionRuntime({
      getPipeline: (n) => store.get(n),
      executeBody: async (p, _params, depth, invoke) => {
        const comp = p.nodes.find((n) => n.type === "pipeline");
        if (comp?.pipeline) return invoke(comp.pipeline, {}, depth);
        return leafOutput(p);
      },
    });

    await expect(runtime.invoke("P1", {}, 0)).rejects.toBeInstanceOf(
      CompositionDepthError,
    );
    await expect(runtime.invoke("P1", {}, 0)).rejects.toThrow(/max depth|depth/i);
  });

  test("invoking an unknown pipeline fails clearly", async () => {
    const runtime = createCompositionRuntime({
      getPipeline: () => undefined,
      executeBody: async (p, _params, depth, invoke) => invoke(p.id, {}, depth) as never,
    });
    await expect(runtime.invoke("ghost", {}, 0)).rejects.toThrow(/not found/i);
  });

  test("runtime input params propagate into the invoked pipeline body", async () => {
    const store = new Map([
      ["P1", pipe("P1", "P2")],
      ["P2", pipe("P2")],
    ]);
    let seenParams: Record<string, unknown> | null = null;

    const runtime = createCompositionRuntime({
      getPipeline: (n) => store.get(n),
      executeBody: async (_p, params) => {
        seenParams = params;
        return leafOutput(_p);
      },
    });

    await runtime.invoke("P1", { topic: "x" }, 0);
    // P2's body receives the propagated runtime params.
    expect(seenParams!).toEqual({ topic: "x" });
  });

  test("static pipeline params are merged with runtime params", async () => {
    const store = new Map([
      ["P1", pipe("P1", "P2", { static: "s" })],
      ["P2", pipe("P2")],
    ]);
    let seen: Record<string, unknown> | null = null;

    const runtime = createCompositionRuntime({
      getPipeline: (n) => store.get(n),
      executeBody: async (p, params, _depth, invoke) => {
        const comp = p.nodes.find((n) => n.type === "pipeline");
        if (comp?.pipeline) return invoke(comp.pipeline, mergeParams(comp.params, params), _depth);
        seen = params;
        return leafOutput(p);
      },
    });

    await runtime.invoke("P1", { runtime: "r" }, 0);
    expect(seen!).toEqual({ static: "s", runtime: "r" });
  });
});

describe("resolveCompositionDepth — admission-time depth validation", () => {
  test("returns the composition depth for a resolvable chain", () => {
    const store = new Map([
      ["P1", pipe("P1", "P2")],
      ["P2", pipe("P2", "P3")],
      ["P3", pipe("P3")],
    ]);
    const result = resolveCompositionDepth("P1", (n) => store.get(n));
    expect(result.ok).toBe(true);
    expect(result.depth).toBe(3);
  });

  test("flags a chain that exceeds the max depth at admission (over-deep rejected)", () => {
    const store = new Map([
      ["P1", pipe("P1", "P2")],
      ["P2", pipe("P2", "P3")],
      ["P3", pipe("P3", "P4")],
      ["P4", pipe("P4", "P5")],
      ["P5", pipe("P5", "P6")],
      ["P6", pipe("P6")],
    ]);
    const result = resolveCompositionDepth("P1", (n) => store.get(n));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /depth/i.test(e))).toBe(true);
  });
});

/** Build a fixed leaf output for a pipeline. */
function leafOutput(p: GraphPipeline): CompositionOutput {
  return {
    lastResponse: { content: `output-${p.name ?? p.id}` },
    lastContent: `output-${p.name ?? p.id}`,
    lastStatus: 200,
    error: null,
  };
}

// Silence unused-import warnings for MAX_COMPOSITION_DEPTH reference in tests.
void MAX_COMPOSITION_DEPTH;
