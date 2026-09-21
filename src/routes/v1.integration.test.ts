/**
 * T9 — /v1 integration tests (wire-local-backend).
 *
 * The /v1 surface end-to-end with a real LocalBackendHub: fake spawns drive
 * the llama-server lifecycle (preflight → activation → idle stop → lazy
 * re-spawn), and a real Bun.serve stub answers the backend's HTTP calls.
 * Exercises /v1/models ownership, chat + SSE streaming, idle-stop
 * re-spawn, failing-spawn 503, the unknown-model 404 envelope, the
 * workflow runner over a local llm_call, and /v1/embeddings with no
 * embedder designated.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase, applySchema } from "../db/schema.js";
import { buildProviderRegistry } from "../providers/registry.js";
import { makeV1Handler } from "./v1.js";
import { makeWorkflowRunner, makeRuntimeServices } from "../orchestrator/runner.js";
import { WorkflowStore } from "../orchestrator/store.js";
import { LocalBackendHub } from "../backend/hub.js";
import { LlamaProcessManager, type SpawnedProc } from "../backend/manager.js";

// ── Fake process harness (mirrors hub.test.ts) ─────────────────────────

function textStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const line of lines) controller.enqueue(enc.encode(`${line}\n`));
      controller.close();
    },
  });
}

function makeProc(stdoutLines: string[] = []): SpawnedProc & { killed: boolean; resolveExit: (code: number) => void } {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stdout: textStream(stdoutLines),
    stderr: textStream([]),
    exited,
    killed: false,
    kill: function () {
      this.killed = true;
      resolveExit(0);
    },
    resolveExit,
  };
}

const VERSION_OK = "llama.cpp version: b10000 (x)";

interface ScriptedSpawn {
  spawnFn: (cmd: string, args: string[]) => SpawnedProc;
  spawns: Array<{ cmd: string; args: string[] }>;
  modelProcs: Array<SpawnedProc & { killed: boolean }>;
  /** Empty-stdout procs → manager start fails fast with "never announced". */
  failModelSpawns: boolean;
}

function makeScriptedSpawn(opts: { port?: number; version?: string } = {}): ScriptedSpawn {
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const modelProcs: Array<SpawnedProc & { killed: boolean }> = [];
  const port = opts.port ?? 54321;
  const s: ScriptedSpawn = {
    spawns,
    modelProcs,
    failModelSpawns: false,
    spawnFn: (cmd: string, args: string[]): SpawnedProc => {
      spawns.push({ cmd, args });
      if (args.includes("--version")) {
        const p = makeProc([opts.version ?? VERSION_OK]);
        p.resolveExit(0);
        return p;
      }
      if (s.failModelSpawns) return makeProc([]);
      const p = makeProc([`llama-server: listening on 127.0.0.1:${port}`]);
      modelProcs.push(p);
      return p;
    },
  };
  return s;
}

// ── Real chat stub over HTTP ───────────────────────────────────────────

const stubs: Array<{ close(): void | Promise<void> }> = [];
afterAll(() => {
  for (const s of stubs) void s.close();
});

async function makeChatStub(): Promise<{ port: number; requests: () => number; close: () => void }> {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        requests += 1;
        const body = (await req.json().catch(() => ({}))) as { stream?: boolean };
        if (body.stream === true) {
          // OpenAI-wire SSE: two chunks + the upstream [DONE] (consumed by the relay).
          return new Response(
            'data: {"id":"stub-1","object":"chat.completion.chunk","created":1,"model":"stub","choices":[{"index":0,"delta":{"role":"assistant","content":"hello from stub"},"finish_reason":null}]}\n\n' +
              'data: {"id":"stub-1","object":"chat.completion.chunk","created":1,"model":"stub","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
              "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "stub-completion",
            object: "chat.completion",
            created: 1,
            model: "stub",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello from stub" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const stub = {
    port: server.port ?? 0,
    requests: () => requests,
    close: () => void server.stop(true),
  };
  stubs.push(stub);
  return stub;
}

// ── Hub + handler harness ──────────────────────────────────────────────

const ggufDir = mkdtempSync(join(tmpdir(), "v1-int-gguf-"));
let ggufSeq = 0;
function ggufFile(id: string): string {
  ggufSeq += 1;
  const p = join(ggufDir, `${id}-${ggufSeq}.gguf`);
  writeFileSync(p, "fake gguf bytes");
  return p;
}

interface IntHarness {
  hub: LocalBackendHub;
  spawn: ScriptedSpawn;
  v1: (req: Request) => Promise<Response>;
  close: () => void;
}

async function makeIntHarness(opts: {
  port: number;
  idleTimeoutMs?: number;
  seed?: Array<{ id: string; active?: boolean }>;
}): Promise<IntHarness> {
  const db = openAppDatabase(":memory:");
  applySchema(db);

  for (const m of opts.seed ?? []) {
    db.query(
      "INSERT INTO models (id, source, name, path, active, state) VALUES (?, 'local', ?, ?, ?, 'registered')",
    ).run(m.id, m.id, ggufFile(m.id), m.active === true ? 1 : 0);
  }

  const spawn = makeScriptedSpawn({ port: opts.port });
  const hub = new LocalBackendHub({
    db,
    binary: "/usr/local/bin/llama-server",
    spawnFn: spawn.spawnFn,
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    healthCheck: async () => true,
    log: () => {},
    idlePollMs: 10,
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  });
  await hub.preflight();
  await hub.restoreActive();

  const regDb = openAppDatabase(":memory:");
  applySchema(regDb);
  const registry = await buildProviderRegistry({
    db: regDb,
    store: { get: async () => null },
  });

  const handler = makeV1Handler({
    registry,
    localProvider: () => hub.localProvider(),
    localModels: () => hub.localModels(),
    embeddings: () => hub.embedder(),
  });

  return {
    hub,
    spawn,
    // /v1 paths always dispatch; null is only returned for non-/v1 paths.
    v1: async (req: Request): Promise<Response> => {
      const res = await handler(req);
      if (res === null) throw new Error(`v1 dispatcher returned null for ${req.url}`);
      return res;
    },
    close: () => {
      void hub.stopAll();
      db.close();
      regDb.close();
    },
  };
}

// ── Suite ──────────────────────────────────────────────────────────────

const harnesses: Array<{ close(): void }> = [];
afterAll(async () => {
  for (const h of harnesses) h.close();
  rmSync(ggufDir, { recursive: true, force: true });
});

describe("v1 integration — local backend (T9)", () => {
  test("a: /v1/models advertises the active model owned_by local", async () => {
    const stub = await makeChatStub();
    const h = await makeIntHarness({ port: stub.port, seed: [{ id: "m1" }] });
    harnesses.push(h);
    await h.hub.activate("m1");

    const res = await h.v1(new Request("http://127.0.0.1:4317/v1/models"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };
    expect(data.data).toContainEqual({ id: "m1", object: "model", created: 0, owned_by: "local" });
  });

  test("b: POST /v1/chat/completions streams one [DONE] and the stub content", async () => {
    const stub = await makeChatStub();
    const h = await makeIntHarness({ port: stub.port, seed: [{ id: "m1" }] });
    harnesses.push(h);
    await h.hub.activate("m1");

    const res = await h.v1(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "m1",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("hello from stub");
    const terminals = body.split("data: [DONE]").length - 1;
    expect(terminals).toBe(1);
    expect(stub.requests()).toBe(1);
  });

  test("c: idle-stop then chat re-spawns the backend (spawn count 2)", async () => {
    const stub = await makeChatStub();
    const h = await makeIntHarness({
      port: stub.port,
      idleTimeoutMs: 40,
      seed: [{ id: "m1" }],
    });
    harnesses.push(h);
    await h.hub.activate("m1");
    expect(h.spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(1);

    // Idle watchdog stops the backend after 40ms without requests.
    const entry = (
      h.hub as unknown as {
        models: Map<string, { manager: LlamaProcessManager }>;
      }
    ).models.get("m1")!;
    const deadline = Date.now() + 2000;
    while (entry.manager.status().state !== "stopped") {
      if (Date.now() > deadline) throw new Error("timeout waiting for idle stop");
      await new Promise((r) => setTimeout(r, 5));
    }

    // The next chat lazily re-spawns → second model spawn.
    const res = await h.v1(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
      }),
    )!;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0].message.content).toBe("hello from stub");
    expect(h.spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(2);
  });

  test("d: idle-stop + failing spawn → next chat answers 503", async () => {
    const stub = await makeChatStub();
    const h = await makeIntHarness({
      port: stub.port,
      idleTimeoutMs: 40,
      seed: [{ id: "m1" }],
    });
    harnesses.push(h);
    await h.hub.activate("m1");

    const entry = (
      h.hub as unknown as {
        models: Map<string, { manager: LlamaProcessManager }>;
      }
    ).models.get("m1")!;
    const deadline = Date.now() + 2000;
    while (entry.manager.status().state !== "stopped") {
      if (Date.now() > deadline) throw new Error("timeout waiting for idle stop");
      await new Promise((r) => setTimeout(r, 5));
    }

    h.spawn.failModelSpawns = true;
    const res = await h.v1(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
      }),
    )!;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string | null; type: string } };
    expect(body.error.type).toBe("api_error");
  });

  test("e: unmapped model answers the OpenAI unknown-model 404 envelope", async () => {
    const stub = await makeChatStub();
    const h = await makeIntHarness({ port: stub.port, seed: [{ id: "m1" }] });
    harnesses.push(h);

    const res = await h.v1(
      new Request("http://127.0.0.1:4317/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
      }),
    )!;
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("nope");
  });

  test("f: workflow start → llm_call(m1) → end runs over the local backend", async () => {
    const stub = await makeChatStub();
    const db = openAppDatabase(":memory:");
    applySchema(db);
    const store = new WorkflowStore(db);
    const h = await makeIntHarness({ port: stub.port, seed: [{ id: "m1" }] });
    harnesses.push(h);

    const { parseWorkflowGraph } = await import("../orchestrator/workflow-yaml.js");
    const { validateGraph } = await import("../orchestrator/graph.js");
    const yaml =
      "name: LocalFlow\n" +
      "nodes:\n" +
      "  - {id: start, type: start}\n" +
      "  - {id: llm, type: llm_call, model: m1}\n" +
      "  - {id: end, type: end}\n" +
      "edges:\n" +
      "  - {from: start, to: llm}\n" +
      "  - {from: llm, to: end}\n";
    const parsed = parseWorkflowGraph(yaml);
    const validation = validateGraph(parsed.graph, { knownModels: ["m1"] });
    expect(validation.ok).toBe(true);
    store.save("LocalFlow", parsed.graph, parsed.version ?? 1);

    await h.hub.activate("m1");
    const services = makeRuntimeServices({
      registry: {
        adapters: new Map(),
        get: () => null,
      },
      localProvider: () => h.hub.localProvider(),
      localModels: () => h.hub.localModels(),
      store,
      sandbox: async () => ({ ok: true, stdout: "", error: null }),
      embedder: () => h.hub.embedder(),
      chunks: () => null,
      memory: () => null,
    });
    const runner = makeWorkflowRunner({ store, services });

    const result = await runner.run("LocalFlow", {
      messages: [{ role: "user", content: "hi" }],
    });
    if (!result.ok) throw new Error(`run failed: ${result.error}`);
    const output = result.output as { choices: Array<{ message: { content: string } }> };
    expect(output.choices[0].message.content).toBe("hello from stub");
  });

  test("g: /v1/embeddings answers 404 when no embedding model is designated", async () => {
    const stub = await makeChatStub();
    const h = await makeIntHarness({ port: stub.port, seed: [{ id: "m1" }] });
    harnesses.push(h);
    await h.hub.activate("m1");

    const res = await h.v1(
      new Request("http://127.0.0.1:4317/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "hello" }),
      }),
    )!;
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });
});