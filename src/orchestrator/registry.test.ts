/**
 * PipelineRegistry tests (strict TDD — Slice A).
 *
 * Verifies the mutable registry's atomic `reload` invariant from the
 * pipeline-orchestration spec:
 *   - "Apply swaps the active registry without restart": reload with valid
 *     chains swaps the active map (swap).
 *   - "Failed reload keeps the previous registry": reload with any invalid
 *     chain keeps the previous map and does NOT serve the invalid one
 *     (no-swap).
 *
 * The swap/no-swap guarantee is the core contract: the registry must only
 * publish a fully-validated chain set, never a partial mixture.
 */
import { describe, expect, test } from "bun:test";
import type { ParsedChain } from "./parser.js";
import { createPipelineRegistry, type GraphPipeline } from "./registry.js";

/** A minimal valid parsed chain with resolved steps. */
function chain(
  name: string,
  steps: Array<{ name?: string; model: string; on_429?: string; tool_calls_route?: string }> = [{ model: "M" }],
): ParsedChain {
  return {
    name,
    displayName: name,
    steps: steps.map((s) => ({
      name: s.name,
      type: "generate",
      provider: "llama-server",
      model: s.model,
      on_429: s.on_429,
      tool_calls_route: s.tool_calls_route,
    })),
  } as unknown as ParsedChain;
}

/** A minimal graph entry. */
function graph(id: string): GraphPipeline {
  return { id } as GraphPipeline;
}

describe("PipelineRegistry.asMap", () => {
  test("returns the active chains map (source of truth for routes)", () => {
    const reg = createPipelineRegistry({ chains: [chain("a"), chain("b")] });
    const map = reg.asMap();
    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
    expect(map.get("a")?.name).toBe("a");
  });

  test("returns an independent snapshot (mutating the returned map does not corrupt the registry)", () => {
    const reg = createPipelineRegistry({ chains: [chain("a")] });
    const map = reg.asMap();
    map.set("injected", chain("injected"));
    expect(reg.asMap().has("injected")).toBe(false);
  });
});

describe("PipelineRegistry.reload — swap on full success", () => {
  test("valid reload swaps the active chains map (apply swaps without restart)", async () => {
    const reg = createPipelineRegistry({ chains: [chain("a")] });
    await reg.reload([], [chain("a"), chain("b"), chain("c")]);
    const map = reg.asMap();
    expect(map.size).toBe(3);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
  });
});

describe("PipelineRegistry.reload — no-swap on any invalid chain", () => {
  test("an invalid chain (zero steps) keeps the previous registry intact", async () => {
    const reg = createPipelineRegistry({ chains: [chain("a")] });
    const invalid = {
      name: "b",
      steps: [],
    } as unknown as ParsedChain;

    await expect(reg.reload([], [chain("a"), invalid])).rejects.toThrow();

    // Previous registry stays active; the invalid chain is NOT served.
    const map = reg.asMap();
    expect(map.size).toBe(1);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
  });

  test("a chain whose on_429 references a missing step keeps the previous registry intact", async () => {
    const reg = createPipelineRegistry({ chains: [chain("a")] });
    const bad = chain("b", [
      { name: "s1", model: "M", on_429: "does-not-exist" },
    ]);

    await expect(reg.reload([], [bad])).rejects.toThrow();

    expect(reg.asMap().has("a")).toBe(true);
    expect(reg.asMap().has("b")).toBe(false);
  });

  test("failed reload does not replace graphs either", async () => {
    const reg = createPipelineRegistry({ graphs: [graph("g1")], chains: [chain("a")] });
    const invalid = { name: "z", steps: [] } as unknown as ParsedChain;

    await expect(reg.reload([], [invalid])).rejects.toThrow();
    expect(reg.getGraph("g1")).toBeDefined();
  });
});

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
