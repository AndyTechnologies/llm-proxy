import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import { WorkflowStore } from "../orchestrator/store.js";
import { serializeWorkflowGraph } from "../orchestrator/workflow-yaml.js";
import { makeApiHandler } from "./api.js";
import type { RunResult, WorkflowRunner } from "../orchestrator/runner.js";
import type { GraphPipeline } from "../orchestrator/graph.js";

const goodGraph: GraphPipeline = {
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

const BAD_YAML = `name: broken\nnodes:\n  - {id: start, type: start}\n  - {id: x2, type: wat}\nedges: []\n`;
const CYCLIC_YAML = `name: cyc\nnodes:\n  - {id: start, type: start}\n  - {id: a, type: llm_call, model: gemma}\n  - {id: end, type: end}\nedges:\n  - {from: start, to: a}\n  - {from: a, to: a}\n  - {from: a, to: end}\n`;

function fakeRunner(over: Record<string, Promise<RunResult> | undefined> = {}): WorkflowRunner {
  return {
    ids: () => ["demo"],
    run: (name) => over[name] ?? Promise.resolve({ ok: false, status: 404, error: "model_not_found" }),
  };
}

const okRun: RunResult = {
  ok: true,
  output: {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gateway/demo",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
    ],
    usage: null,
  },
};

function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

describe("/api workflows (6.10)", () => {
  function api(deps: Partial<Parameters<typeof makeApiHandler>[0]> = {}) {
    const db = new Database(":memory:");
    applySchema(db);
    const store = deps.store ?? new WorkflowStore(db);
    return makeApiHandler({ store, runner: fakeRunner(), ...deps });
  }

  test("GET /api/workflows lists stored workflows", async () => {
    const handler = api();
    const res = await handler(new Request("http://x/api/workflows"));
    expect(res.status).toBe(200);
    expect(await json<unknown[]>(res)).toEqual([]);
  });

  test("GET /api/workflows/:name returns the YAML envelope (404 unknown)", async () => {
    const { store } = depsOf();
    store.save("demo", goodGraph, 1);
    const handler = api({ store });
    const res = await handler(new Request("http://x/api/workflows/demo"));
    expect(res.status).toBe(200);
    const body = (await json(res)) as { name: string; version: number; yaml: string };
    expect(body.name).toBe("demo");
    expect(body.version).toBe(1);
    expect(body.yaml).toContain("name: Demo");
    expect((await handler(new Request("http://x/api/workflows/ghost"))).status).toBe(404);
  });

  test("PUT /api/workflows/:name accepts valid YAML and bumps version on resave", async () => {
    const { store } = depsOf();
    const handler = api({ store });
    const put = new Request("http://x/api/workflows/demo", {
      method: "PUT",
      headers: { "content-type": "application/yaml" },
      body: serializeWorkflowGraph(goodGraph),
    });
    const res = await handler(put);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { ok: boolean; name: string; version: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);
    const again = await handler(
      new Request("http://x/api/workflows/demo", {
        method: "PUT",
        headers: { "content-type": "application/yaml" },
        body: serializeWorkflowGraph(goodGraph),
      }),
    );
    expect(((await json(again)) as { version: number }).version).toBe(2);
  });

  test("PUT rejects malformed YAML naming the offending node (400)", async () => {
    const handler = api();
    const res = await handler(
      new Request("http://x/api/workflows/demo", {
        method: "PUT",
        headers: { "content-type": "application/yaml" },
        body: BAD_YAML,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    expect(body.error).toContain('node "x2"');
  });

  test("PUT rejects a graph that fails validation (400, names the error)", async () => {
    const handler = api();
    const res = await handler(
      new Request("http://x/api/workflows/cyc", {
        method: "PUT",
        headers: { "content-type": "application/yaml" },
        body: CYCLIC_YAML,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string; errors: string[] };
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.some((e) => /cycle/.test(e))).toBe(true);
  });

  test("DELETE /api/workflows/:name removes and 404s when absent", async () => {
    const { store } = depsOf();
    store.save("demo", goodGraph, 1);
    const handler = api({ store });
    expect((await handler(new Request("http://x/api/workflows/demo", { method: "DELETE" }))).status).toBe(204);
    expect((await handler(new Request("http://x/api/workflows/demo", { method: "DELETE" }))).status).toBe(404);
  });

  test("POST /api/workflows/:name/run relays the runner result", async () => {
    const { store } = depsOf();
    store.save("demo", goodGraph, 1);
    const handler = api({ store, runner: fakeRunner({ demo: Promise.resolve(okRun) }) });
    const res = await handler(
      new Request("http://x/api/workflows/demo/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await json(res)) as { model: string };
    expect(body.model).toBe("gateway/demo");
  });

  test("POST run maps runner failures: 404 unknown, 502 engine error", async () => {
    const { store } = depsOf();
    store.save("demo", goodGraph, 1);
    const handler = api({ store, runner: fakeRunner() });
    expect(
      (await handler(
        new Request("http://x/api/workflows/ghost/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        }),
      )).status,
    ).toBe(404);
    const errRunner = fakeRunner({
      demo: Promise.resolve({ ok: false, status: 502, error: "upstream exploded" }),
    });
    const errApi = api({ store, runner: errRunner });
    const res = await errApi(
      new Request("http://x/api/workflows/demo/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(res.status).toBe(502);
    expect(((await json(res)) as { error: string }).error).toBe("upstream exploded");
  });

  test("POST run with a malformed JSON body is a 400", async () => {
    const { store } = depsOf();
    store.save("demo", goodGraph, 1);
    const handler = api({ store });
    const res = await handler(
      new Request("http://x/api/workflows/demo/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/workflows/:name/logs returns run history (404 unknown)", async () => {
    const { store } = depsOf();
    store.save("demo", goodGraph, 1);
    store.recordExecution("demo", { status: "ok", startedAt: "t1", ms: 5 });
    const handler = api({ store });
    const res = await handler(new Request("http://x/api/workflows/demo/logs"));
    expect(res.status).toBe(200);
    expect((await json<unknown[]>(res)).length).toBe(1);
    expect((await handler(new Request("http://x/api/workflows/ghost/logs"))).status).toBe(404);
  });

  test("unknown routes are 404", async () => {
    const handler = api();
    expect((await handler(new Request("http://x/api/whatever"))).status).toBe(404);
  });
});

function depsOf() {
  const db = new Database(":memory:");
  applySchema(db);
  return { store: new WorkflowStore(db) };
}