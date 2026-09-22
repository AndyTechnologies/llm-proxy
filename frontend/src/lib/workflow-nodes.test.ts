import { describe, expect, test } from "bun:test";
import {
  NODE_TYPES,
  WORKFLOW_NODE_TYPES,
  hasSourceHandle,
  hasTargetHandle,
  makeNodeId,
  nodeCategory,
  nodeLabel,
  nodeTypeDef,
  nodeTypeExists,
  sanitizeNodeFields,
} from "./workflow-nodes.js";
import type { FieldKind, NodeFieldValues } from "./workflow-nodes.js";

/** Runtime mirror of GraphNode fields (kept in sync with src/orchestrator/graph.ts). */
const GRAPH_NODE_KEYS = new Set([
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
]);

describe("WORKFLOW_NODE_TYPES taxonomy", () => {
  test("covers every engine node type exactly once", () => {
    const ids = WORKFLOW_NODE_TYPES.map((entry) => entry.id);
    expect(ids).toEqual(NODE_TYPES);
    expect(new Set(ids).size).toBe(NODE_TYPES.length);
  });

  test("palette order matches the contract (start → … → output)", () => {
    const ids = WORKFLOW_NODE_TYPES.map((entry) => entry.id);
    expect(ids).toEqual([
      "start",
      "end",
      "llm_call",
      "condition",
      "loop",
      "fan",
      "join",
      "pipeline",
      "rag_local",
      "data.code",
      "memory",
      "embeddings",
      "router",
      "output",
    ]);
  });

  test("every entry carries label, category, color and description", () => {
    for (const entry of WORKFLOW_NODE_TYPES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(["flow", "llm", "data", "integration", "output"]).toContain(entry.category);
      expect(["accent", "secondary", "success"]).toContain(entry.color);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test("field definitions bind only real GraphNode keys", () => {
    for (const entry of WORKFLOW_NODE_TYPES) {
      expect(Array.isArray(entry.fields), `${entry.id} fields is an array`).toBe(true);
      for (const field of entry.fields) {
        expect(GRAPH_NODE_KEYS.has(field.key), `${entry.id}.${field.key} is a GraphNode key`).toBe(true);
        expect(field.label.length).toBeGreaterThan(0);
      }
    }
  });

  test("llm_call exposes the engine's llm semantics only", () => {
    const llm = nodeTypeDef("llm_call");
    const keys = llm.fields.map((field) => field.key);
    expect(keys).toEqual([
      "model",
      "mode",
      "provider",
      "ctx",
      "system",
      "assistant",
      "user",
      "on_429",
      "tool_calls_route",
    ]);
    const modeField = llm.fields.find((field) => field.key === "mode");
    expect(modeField?.kind).toBe("select");
    expect(modeField?.options).toEqual(["generate", "refine", "passthrough"]);
    expect(llm.defaults).toEqual({ mode: "generate" });
  });

  test("rag_local/embeddings do NOT invent a model field", () => {
    // GraphNode has no `model` on these types — the runtime default applies.
    expect(nodeTypeDef("rag_local").fields.map((f) => f.key)).toEqual(["k"]);
    expect(nodeTypeDef("embeddings").fields.map((f) => f.key)).toEqual(["text"]);
  });

  test("condition/router default to valid SAFE AST shapes", () => {
    expect(nodeTypeDef("condition").defaults).toEqual({
      condition: { op: "exists", field: "lastResponse.content" },
    });
    expect(nodeTypeDef("router").defaults).toEqual({
      condition: { op: "compare", field: "lastResponse.status", op2: "==", value: 200 },
    });
  });

  test("loop/fan defaults are engine-valid", () => {
    expect(nodeTypeDef("loop").defaults).toEqual({ body: [], iterations: 1 });
    expect(nodeTypeDef("fan").defaults).toEqual({ parallel: true });
  });
});

describe("nodeTypeExists / nodeTypeDef / nodeLabel / nodeCategory", () => {
  test("accepts only real engine types", () => {
    for (const id of NODE_TYPES) expect(nodeTypeExists(id)).toBe(true);
    expect(nodeTypeExists("llm")).toBe(false);
    expect(nodeTypeExists("")).toBe(false);
  });

  test("nodeTypeDef throws on unknown ids (invariant helper)", () => {
    expect(() => nodeTypeDef("nope" as never)).toThrow(/unknown node type/);
  });

  test("labels and categories resolve", () => {
    expect(nodeLabel("llm_call")).toBe("LLM call");
    expect(nodeLabel("data.code")).toBe("Data (code)");
    expect(nodeCategory("start")).toBe("flow");
    expect(nodeCategory("pipeline")).toBe("integration");
    expect(nodeCategory("output")).toBe("output");
  });
});

describe("canvas handle semantics", () => {
  test("start has no target; end has no source; everything else has both", () => {
    for (const id of NODE_TYPES) {
      expect(hasTargetHandle(id), `${id} target`).toBe(id !== "start");
      expect(hasSourceHandle(id), `${id} source`).toBe(id !== "end");
    }
  });
});

describe("makeNodeId", () => {
  test("kebab base forms", () => {
    expect(makeNodeId("start", new Set())).toBe("start");
    expect(makeNodeId("llm_call", new Set())).toBe("llm-call");
    expect(makeNodeId("data.code", new Set())).toBe("data-code");
  });

  test("dedupes against taken ids with numeric suffixes", () => {
    expect(makeNodeId("llm_call", new Set(["llm-call"]))).toBe("llm-call-2");
    expect(makeNodeId("llm_call", new Set(["llm-call", "llm-call-2"]))).toBe("llm-call-3");
  });

  test("deterministic for the same input set", () => {
    const taken = new Set(["start", "llm-call"]);
    expect(makeNodeId("llm_call", taken)).toBe("llm-call-2");
    expect(makeNodeId("llm_call", taken)).toBe("llm-call-2");
  });
});

describe("sanitizeNodeFields", () => {
  test("keeps only whitelisted keys and drops unknowns", () => {
    const out = sanitizeNodeFields("llm_call", {
      model: "SmolLM3",
      mode: "generate",
      bogus: "nope",
    });
    expect(out).toEqual({ model: "SmolLM3", mode: "generate" });
    expect("bogus" in out).toBe(false);
  });

  test("admits the universal parallel flag on every type", () => {
    expect(sanitizeNodeFields("start", { parallel: true })).toEqual({ parallel: true });
    expect(sanitizeNodeFields("llm_call", { parallel: true, model: "m" })).toEqual({
      parallel: true,
      model: "m",
    });
  });

  test("rejects invalid values per kind", () => {
    expect(sanitizeNodeFields("llm_call", { mode: "not-a-mode" })).toEqual({});
    expect(sanitizeNodeFields("llm_call", { ctx: 4096 })).toEqual({ ctx: 4096 });
    // ctx is number | string in GraphNode — the engine accepts percentage
    // strings, so only empty strings are dropped.
    expect(sanitizeNodeFields("llm_call", { ctx: "50%" })).toEqual({ ctx: "50%" });
    expect(sanitizeNodeFields("llm_call", { ctx: "" })).toEqual({});
    expect(sanitizeNodeFields("rag_local", { k: "four" })).toEqual({});
    expect(sanitizeNodeFields("rag_local", { k: 4 })).toEqual({ k: 4 });
    expect(sanitizeNodeFields("fan", { parallel: "yes" })).toEqual({});
  });

  test("body is the only textarea-shaped string[] field", () => {
    expect(sanitizeNodeFields("loop", { body: ["a", "b"], iterations: 2 })).toEqual({
      body: ["a", "b"],
      iterations: 2,
    });
    expect(sanitizeNodeFields("llm_call", { system: ["should-not-survive"] })).toEqual({});
  });

  test("condition key is opaque and never admitted into primitives", () => {
    const out = sanitizeNodeFields("condition", {
      condition: { op: "exists", field: "lastResponse.content" },
    } as NodeFieldValues);
    expect(out).toEqual({});
  });
});

describe("field kind sanity (compile-time surface)", () => {
  test("every field kind used by the taxonomy is real", () => {
    const kinds: FieldKind[] = ["text", "select", "number", "textarea", "code", "tokens", "toggle"];
    for (const entry of WORKFLOW_NODE_TYPES) {
      for (const field of entry.fields) {
        expect(kinds).toContain(field.kind);
      }
    }
  });
});