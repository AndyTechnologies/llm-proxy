import { describe, expect, test } from "bun:test";
import type { GatewayConfig } from "../config/schema.js";
import { configSchema } from "../config/schema.js";
import { parseChains } from "./parser.js";

/**
 * Graph-based chain config parser tests (refactor-graph-canonical — Phase 5).
 *
 * The config now stores chains as `nodes`/`edges` graphs (the `steps` shape is
 * gone). `parseChains` reads that graph directly and materializes the linear
 * `ParsedChain` the linear engine still consumes, preserving per-node routing
 * (`on_429`/`tool_calls_route`) and message scaffolding (`mode`, `ctx`,
 * `system`, `assistant`, `user`).
 */

/** Build a schema-valid graph-shaped GatewayConfig with a single chain. */
function configWithChain(
  name: string,
  chain: {
    provider?: string;
    defaultProvider?: string;
    displayName?: string;
    nodes: Array<Record<string, unknown>>;
    edges: Array<{ from: string; to: string }>;
  },
): GatewayConfig {
  return configSchema.parse({
    chains: {
      [name]: {
        ...(chain.provider ? { provider: chain.provider } : {}),
        ...(chain.defaultProvider ? { defaultProvider: chain.defaultProvider } : {}),
        ...(chain.displayName ? { displayName: chain.displayName } : {}),
        nodes: chain.nodes,
        edges: chain.edges,
      },
    },
  });
}

describe("parseChains — reads a graph-based chain config", () => {
  test("materializes llm_call nodes in order as steps", () => {
    const cfg = configWithChain("linear", {
      provider: "llama-server",
      displayName: "Linear",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "llm_call", model: "M1", mode: "generate" },
        { id: "b", type: "llm_call", model: "M2", mode: "refine" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "end" },
      ],
    });

    const chains = parseChains(cfg);
    const chain = chains.get("linear");
    expect(chain).toBeDefined();
    expect(chain!.steps.map((s) => s.model)).toEqual(["M1", "M2"]);
    // mode maps to the linear step type.
    expect(chain!.steps[0].type).toBe("generate");
    expect(chain!.steps[1].type).toBe("refine");
    // provider is normalized from the chain default.
    expect(chain!.steps[0].provider).toBe("llama-server");
    expect(chain!.name).toBe("linear");
    expect(chain!.displayName).toBe("Linear");
  });

  test("carries on_429 / tool_calls_route / message scaffolding from nodes", () => {
    const cfg = configWithChain("routed", {
      nodes: [
        { id: "start", type: "start" },
        {
          id: "primary",
          type: "llm_call",
          model: "P",
          mode: "generate",
          on_429: "fallback",
          tool_calls_route: "exec",
          ctx: 4096,
          system: "sys",
        },
        { id: "fallback", type: "llm_call", model: "F" },
        { id: "exec", type: "llm_call", model: "E", mode: "refine" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "primary" },
        { from: "primary", to: "fallback" },
        { from: "primary", to: "exec" },
        { from: "fallback", to: "end" },
        { from: "exec", to: "end" },
      ],
    });

    const chain = parseChains(cfg).get("routed")!;
    expect(chain.steps[0].on_429).toBe("fallback");
    expect(chain.steps[0].tool_calls_route).toBe("exec");
    expect(chain.steps[0].ctx).toBe(4096);
    expect(chain.steps[0].system).toBe("sys");
  });

  test("throws when a chain has no llm_call nodes", () => {
    const cfg = configWithChain("empty", {
      nodes: [
        { id: "start", type: "start" },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "start", to: "end" }],
    });

    expect(() => parseChains(cfg)).toThrow(/no llm_call nodes/i);
  });

  test("throws when on_429 references an unknown node id", () => {
    const cfg = configWithChain("bad", {
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "llm_call", model: "M", on_429: "missing" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    });

    expect(() => parseChains(cfg)).toThrow(/on_429.*missing/i);
  });

  test("falls back to the standard default provider and maps passthrough mode", () => {
    const cfg = configWithChain("unset", {
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "llm_call", model: "M", mode: "passthrough" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
      ],
    });

    const chain = parseChains(cfg).get("unset")!;
    // No chain-level provider → resolveStep falls back to the standard one.
    expect(chain.steps[0].provider).toBe("llama-server");
    expect(chain.steps[0].type).toBe("passthrough");
  });
});
