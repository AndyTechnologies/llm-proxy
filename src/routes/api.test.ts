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

// ── /api/models tests (T6) ────────────────────────────────────────────

import { LocalBackendHub } from "../backend/hub.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnedProc } from "../backend/manager.js";

function textStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const line of lines) controller.enqueue(enc.encode(`${line}\n`));
      controller.close();
    },
  });
}

function makeProc(stdoutLines: string[] = []): SpawnedProc & {
  killed: boolean;
  resolveExit: (code: number) => void;
} {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  return {
    pid: 4242, exitCode: null, signalCode: null,
    stdout: textStream(stdoutLines), stderr: textStream([]),
    exited, killed: false,
    kill: function () { this.killed = true; resolveExit(0); },
    resolveExit,
  };
}

function makeScriptedSpawn(port: number) {
  return {
    spawnFn: (_cmd: string, args: string[]): SpawnedProc => {
      if (args.includes("--version")) {
        const p = makeProc(["llama.cpp version: b10000 (x)"]);
        p.resolveExit(0);
        return p;
      }
      return makeProc([`llama-server: listening on 127.0.0.1:${port}`]);
    },
  };
}

function modelsHandler(deps: { hub?: LocalBackendHub; auth?: (req: Request) => Promise<boolean> }) {
  const db = new Database(":memory:");
  applySchema(db);
  const store = new WorkflowStore(db);
  return makeApiHandler({ store, runner: fakeRunner(), ...deps });
}

describe("/api/models (T6)", () => {
  const ggufDir = mkdtempSync(join(tmpdir(), "api-models-gguf-"));
  let ggufSeq = 0;
  function ggufFile(): string {
    ggufSeq += 1;
    const p = join(ggufDir, `model-${ggufSeq}.gguf`);
    writeFileSync(p, "fake bytes");
    return p;
  }

  test("GET /api/models lists active + disabled models", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const hub = new LocalBackendHub({
      db, binary: "/usr/bin/llama",
      spawnFn: makeScriptedSpawn(54321).spawnFn,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      healthCheck: async () => true,
    });
    db.query("INSERT INTO models (id, source, path, active, state) VALUES ('m1', 'local', ?, 0, 'registered')").run(ggufFile());
    db.query("INSERT INTO models (id, source, path, active, state) VALUES ('m2', 'local', ?, 1, 'registered')").run(ggufFile());
    await hub.preflight();
    await hub.restoreActive(); // m2 activated; m1 stays disabled

    const handler = modelsHandler({ hub });
    const res = await handler(new Request("http://x/api/models"));
    expect(res.status).toBe(200);
    const list = (await json<{ id: string; state: string }[]>(res));
    expect(list.map((s) => s.id)).toEqual(expect.arrayContaining(["m1", "m2"]));
    const m2 = list.find((s) => s.id === "m2");
    expect(m2?.state).toBe("active");
  });

  test("auth gate: false → 401; absent → admitted", async () => {
    const hub = new LocalBackendHub({
      db: (() => { const d = new Database(":memory:"); applySchema(d); return d; })(),
      binary: "/usr/bin/llama",
      spawnFn: makeScriptedSpawn(54321).spawnFn,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      healthCheck: async () => true,
    });

    const deny = modelsHandler({ hub, auth: async () => false });
    expect((await deny(new Request("http://x/api/models"))).status).toBe(401);

    const open = modelsHandler({ hub });
    expect((await open(new Request("http://x/api/models"))).status).toBe(200);
  });

  test("GET /api/models/:id returns status; unknown → 404", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const path = ggufFile();
    db.query("INSERT INTO models (id, source, path, active, state) VALUES ('m1', 'local', ?, 0, 'registered')").run(path);
    const hub = new LocalBackendHub({
      db, binary: "/usr/bin/llama",
      spawnFn: makeScriptedSpawn(54321).spawnFn,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      healthCheck: async () => true,
    });
    const handler = modelsHandler({ hub });

    const res = await handler(new Request("http://x/api/models/m1"));
    expect(res.status).toBe(200);
    expect((await json(res)).state).toBe("disabled");

    expect((await handler(new Request("http://x/api/models/unknown"))).status).toBe(404);
  });

  test("POST /api/models/:id/activate returns {state, pid, port}; missing GGUF → 400", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const path = ggufFile();
    db.query("INSERT INTO models (id, source, path, active, state) VALUES ('m1', 'local', ?, 0, 'registered')").run(path);
    const hub = new LocalBackendHub({
      db, binary: "/usr/bin/llama",
      spawnFn: makeScriptedSpawn(54321).spawnFn,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      healthCheck: async () => true,
    });
    const handler = modelsHandler({ hub });

    const activate = await handler(new Request("http://x/api/models/m1/activate", { method: "POST" }));
    expect(activate.status).toBe(200);
    expect((await json(activate))).toEqual(expect.objectContaining({ state: "active", pid: 4242 }));

    // missing GGUF
    db.query("INSERT INTO models (id, source, path, active, state) VALUES ('bad', 'local', '/no/gguf.gguf', 0, 'registered')").run();
    expect(
      (await handler(new Request("http://x/api/models/bad/activate", { method: "POST" }))).status,
    ).toBe(400);
  });

  test("POST /api/models/:id/deactivate persists active=0; unknown → 404", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const path = ggufFile();
    db.query("INSERT INTO models (id, source, path, active, state) VALUES ('m1', 'local', ?, 0, 'registered')").run(path);
    const hub = new LocalBackendHub({
      db, binary: "/usr/bin/llama",
      spawnFn: makeScriptedSpawn(54321).spawnFn,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      healthCheck: async () => true,
    });
    await hub.activate("m1");
    const handler = modelsHandler({ hub });

    const deactivate = await handler(new Request("http://x/api/models/m1/deactivate", { method: "POST" }));
    expect(deactivate.status).toBe(200);
    expect((await json<{ state: string }>(deactivate))).toEqual({ state: "disabled" });
    const row = db.query("SELECT active FROM models WHERE id = ?").get("m1") as { active: number };
    expect(row.active).toBe(0);

    expect(
      (await handler(new Request("http://x/api/models/unknown/deactivate", { method: "POST" }))).status,
    ).toBe(404);
  });

  test("wrong methods on models endpoints return 405", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const hub = new LocalBackendHub({
      db, binary: "/usr/bin/llama",
      spawnFn: makeScriptedSpawn(54321).spawnFn,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      healthCheck: async () => true,
    });
    const handler = modelsHandler({ hub });

    expect((await handler(new Request("http://x/api/models", { method: "POST" }))).status).toBe(405);
    expect((await handler(new Request("http://x/api/models/unknown", { method: "PUT" }))).status).toBe(405);
    expect((await handler(new Request("http://x/api/models/unknown/activate", { method: "GET" }))).status).toBe(405);
    expect((await handler(new Request("http://x/api/models/unknown/deactivate", { method: "DELETE" }))).status).toBe(405);
  });
});