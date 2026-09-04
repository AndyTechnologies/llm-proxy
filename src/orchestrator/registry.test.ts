/**
 * PipelineRegistry tests (graph-only registry).
 *
 * Verifies the mutable registry's atomic `reload` invariant:
 *   - "Apply swaps the active registry without restart": reload with valid
 *     graphs swaps the active map.
 *   - "Failed reload keeps the previous registry": reload with any invalid
 *     graph keeps the previous map and does NOT serve the invalid one.
 */
import { describe, expect, test } from "bun:test";
import type { GraphPipeline } from "./graph.js";
import { createPipelineRegistry } from "./registry.js";

/** A minimal graph entry. */
function graph(id: string, name?: string): GraphPipeline {
  return { id, name: name ?? id, nodes: [], edges: [] };
}

describe("PipelineRegistry.getGraph", () => {
  test("returns the stored graph for a known id", () => {
    const reg = createPipelineRegistry({ graphs: [graph("g1"), graph("g2")] });
    expect(reg.getGraph("g1")?.id).toBe("g1");
    expect(reg.getGraph("g2")?.id).toBe("g2");
  });

  test("returns undefined for an unknown id", () => {
    const reg = createPipelineRegistry({ graphs: [graph("g1")] });
    expect(reg.getGraph("missing")).toBeUndefined();
  });
});

describe("PipelineRegistry.listGraphs", () => {
  test("returns all registered graphs", () => {
    const reg = createPipelineRegistry({ graphs: [graph("a"), graph("b")] });
    const list = reg.listGraphs();
    expect(list).toHaveLength(2);
    expect(list.map((g) => g.id)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  test("returns an independent snapshot (mutating returned array does not corrupt the registry)", () => {
    const reg = createPipelineRegistry({ graphs: [graph("a")] });
    const list = reg.listGraphs();
    list.push(graph("injected"));
    expect(reg.listGraphs()).toHaveLength(1);
  });
});

describe("PipelineRegistry.reload — swap on full success", () => {
  test("valid reload swaps the active graph map", async () => {
    const reg = createPipelineRegistry({ graphs: [graph("a")] });
    await reg.reload([graph("a"), graph("b"), graph("c")]);
    const list = reg.listGraphs();
    expect(list).toHaveLength(3);
    const ids = list.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });
});

describe("PipelineRegistry.reload — no-swap on any invalid graph", () => {
  test("a graph with no id keeps the previous registry intact", async () => {
    const reg = createPipelineRegistry({ graphs: [graph("a")] });
    const invalid = { id: "", nodes: [], edges: [] } as GraphPipeline;

    await expect(reg.reload([graph("a"), invalid])).rejects.toThrow();

    // Previous registry stays active; the invalid graph is NOT served.
    const list = reg.listGraphs();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("a");
  });

  test("a duplicate graph id keeps the previous registry intact", async () => {
    const reg = createPipelineRegistry({ graphs: [graph("a")] });

    await expect(reg.reload([graph("a"), graph("a")])).rejects.toThrow();

    expect(reg.listGraphs()).toHaveLength(1);
    expect(reg.getGraph("a")).toBeDefined();
  });
});
