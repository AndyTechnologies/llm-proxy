import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import { WorkflowStore } from "./store.js";
import { makeRuntimeServices, makeWorkflowRunner } from "./runner.js";
import { serializeWorkflowGraph } from "./workflow-yaml.js";
import type { GraphPipeline, GraphNode } from "./graph.js";
import type { EngineServices } from "./engine.js";

const graph: GraphPipeline = {
  id: "demo",
  name: "Demo",
  nodes: [
    { id: "start", type: "start" },
    { id: "a", type: "llm_call", model: "gemma" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "a" },
    { from: "a", to: "end" },
  ],
};

function storeWith(docs: Array<[string, GraphPipeline]> = [["demo", graph]]): WorkflowStore {
  const db = new Database(":memory:");
  applySchema(db);
  const store = new WorkflowStore(db);
  for (const [name, g] of docs) store.save(name, g, 1);
  return store;
}

function fakeServices(): EngineServices {
  return {
    call: async (_n: GraphNode, _m: unknown, _s: AbortSignal) => ({ status: 200, content: "hello" }),
    runCode: async () => ({ ok: true, stdout: "ran" }),
    embed: async () => new Float32Array([0.1]),
    retrieve: async () => [{ doc: "d", text: "t", score: 1 }],
    loadMemory: async () => [],
    storeMemory: async () => {},
    graphMap: () => new Map(),
  };
}

describe("makeWorkflowRunner (6.6)", () => {
  test("ids() lists stored workflows", () => {
    const runner = makeWorkflowRunner({ store: storeWith([["demo", graph], ["other", graph]]), services: fakeServices() });
    expect(runner.ids()).toContain("demo");
    expect(runner.ids()).toContain("other");
  });

  test("run resolves an ok OpenAI-shaped completion and logs it", async () => {
    const store = storeWith();
    const runner = makeWorkflowRunner({ store, services: fakeServices() });
    const result = await runner.run("demo", { messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.model).toBe("gateway/demo");
      expect(result.output.object).toBe("chat.completion");
      expect(result.output.choices[0].message.content).toBe("hello");
    }
    const logs = store.logs("demo");
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("ok");
  });

  test("run on an unknown workflow resolves 404 without touching the log", async () => {
    const store = storeWith();
    const runner = makeWorkflowRunner({ store, services: fakeServices() });
    const result = await runner.run("ghost", { messages: [] });
    expect(result).toEqual({ ok: false, status: 404, error: "model_not_found" });
    expect(store.logs("ghost")).toEqual([]);
  });

  test("run maps engine failure to 502 and logs the error", async () => {
    const store = storeWith();
    const services = fakeServices();
    services.call = async () => {
      throw new Error("upstream exploded");
    };
    const runner = makeWorkflowRunner({ store, services });
    const result = await runner.run("demo", { messages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toContain("upstream exploded");
    }
    expect(store.logs("demo")[0].status).toBe("error");
  });

  test("run surfaces a corrupted stored doc as 502", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const store = new WorkflowStore(db);
    store.save("demo", graph, 1);
    db.query("UPDATE workflows SET yaml_graph = 'nodes: nope'").run();
    const runner = makeWorkflowRunner({ store, services: fakeServices() });
    const result = await runner.run("demo", { messages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});

describe("makeRuntimeServices (6.6)", () => {
  function localProvider() {
    return { chat: async () => ({ choices: [{ message: { content: "local-answer" } }] }) };
  }

  test("call routes a known local model to the local provider", async () => {
    const services = makeRuntimeServices({
      registry: { adapters: new Map(), get: () => null } as never,
      localProvider: () => localProvider() as never,
      localModels: () => ["gemma"],
      store: storeWith(),
      sandbox: async () => ({ ok: true, stdout: "ran", error: null }),
      embedder: () => null,
      chunks: () => null,
      memory: () => null,
    });
    const outcome = await services.call(
      { id: "a", type: "llm_call", model: "gemma" },
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
    );
    expect(outcome.status).toBe(200);
    expect(outcome.content).toBe("local-answer");
  });

  test("call routes an external model through the adapter registry", async () => {
    const external = {
      kind: "openai",
      models: ["gpt-4o"],
      fallbackId: null,
      chat: async () => ({ choices: [{ message: { content: "external-answer" } }] }),
      chatStream: async () => {},
    };
    const services = makeRuntimeServices({
      registry: {
        adapters: new Map([["openai", external]]),
        get: (k: string) => (k === "openai" ? external : null),
      } as never,
      localProvider: () => null,
      localModels: () => [],
      store: storeWith(),
      sandbox: async () => ({ ok: true, stdout: "", error: null }),
      embedder: () => null,
      chunks: () => null,
      memory: () => null,
    });
    const outcome = await services.call(
      { id: "a", type: "llm_call", model: "gpt-4o" },
      [],
      new AbortController().signal,
    );
    expect(outcome.content).toBe("external-answer");
  });

  test("runCode routes through the injected sandbox seam", async () => {
    let received: { code: string; input: unknown } = { code: "", input: null };
    const services = makeRuntimeServices({
      registry: { adapters: new Map(), get: () => null } as never,
      localProvider: () => null,
      localModels: () => [],
      store: storeWith(),
      sandbox: async (code, input, _opts) => {
        received = { code, input };
        return { ok: true, stdout: "crafted", error: null };
      },
      embedder: () => null,
      chunks: () => null,
      memory: () => null,
    });
    const out = await services.runCode(
      "console.log(1)",
      { n: 2 },
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({ ok: true, stdout: "crafted", error: undefined });
    expect(received).toEqual({ code: "console.log(1)", input: { n: 2 } });
  });

  test("call on an unknown model throws", async () => {
    const services = makeRuntimeServices({
      registry: { adapters: new Map(), get: () => null } as never,
      localProvider: () => null,
      localModels: () => [],
      store: storeWith(),
      sandbox: async () => ({ ok: true, stdout: "", error: null }),
      embedder: () => null,
      chunks: () => null,
      memory: () => null,
    });
    await expect(
      services.call({ id: "a", type: "llm_call", model: "nope" }, [], new AbortController().signal),
    ).rejects.toThrow(/unknown model "nope"/);
  });

  test("graphMap exposes stored workflows as executable pipelines", () => {
    const store = storeWith([
      ["demo", graph],
      ["sub", { id: "sub", nodes: [{ id: "s", type: "start" }, { id: "e", type: "end" }], edges: [{ from: "s", to: "e" }] }],
    ]);
    const services = makeRuntimeServices({
      registry: { adapters: new Map(), get: () => null } as never,
      localProvider: () => null,
      localModels: () => [],
      store,
      sandbox: async () => ({ ok: true, stdout: "", error: null }),
      embedder: () => null,
      chunks: () => null,
      memory: () => null,
    });
    const map = services.graphMap();
    expect(map.has("demo")).toBe(true);
    expect(map.has("sub")).toBe(true);
    expect(map.get("sub")?.nodes.map((n) => n.id)).toEqual(["s", "e"]);
  });

  test("serialize round trip keeps the stored yaml identical to workflow-yaml output", () => {
    const store = storeWith();
    const yaml = store.get("demo")!.yaml;
    expect(yaml).toBe(serializeWorkflowGraph(graph));
  });
});