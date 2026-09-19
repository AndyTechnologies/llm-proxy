/**
 * T5 — LocalBackendHub orchestration (backend-management spec).
 * DI seams inject spawn/clock/sleep/health so the whole orchestration is
 * testable with fakes (no real llama-server). GGUF paths must be REAL files
 * (existsSync gate); sleep uses capped real timers (a no-op sleep starves
 * the idle watchdog's microtask loop — same trap as manager.test.ts).
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase, applySchema } from "../db/schema.js";
import type { Database } from "bun:sqlite";
import { LocalBackendHub, type HubDeps } from "./hub.js";
import { LlamaProcessManager, type SpawnedProc } from "./manager.js";

// ── Fake process harness (mirrors manager.test.ts) ────────────────────

function textStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const line of lines) controller.enqueue(enc.encode(`${line}\n`));
      controller.close();
    },
  });
}

function delayedTextStream(lines: string[], delayMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      await new Promise((r) => setTimeout(r, delayMs));
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

/** Dispatch spawns: --version → version proc; else a model proc on the given port. */
function makeScriptedSpawn(opts: {
  port?: () => number;
  version?: string;
  failVersion?: boolean;
  stdoutDelayMs?: number;
} = {}): ScriptedSpawn {
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const modelProcs: Array<SpawnedProc & { killed: boolean }> = [];
  const s: ScriptedSpawn = {
    spawns,
    modelProcs,
    failModelSpawns: false,
    spawnFn: (cmd: string, args: string[]): SpawnedProc => {
      spawns.push({ cmd, args });
    if (args.includes("--version")) {
      if (opts.failVersion === true) {
        throw Object.assign(new Error(`no such file: ${cmd}`), { code: "ENOENT" });
      }
      const p = makeProc([opts.version ?? VERSION_OK]);
      p.resolveExit(0);
      return p;
    }
    if (s.failModelSpawns) return makeProc([]); // empty stdout → fast start failure
      const port = (opts.port ?? (() => 54321))();
      const line = `llama-server: listening on 127.0.0.1:${port}`;
      const stream = (opts.stdoutDelayMs ?? 0) > 0
        ? delayedTextStream([line], opts.stdoutDelayMs!)
        : textStream([line]);
      const p = makeProc([line]);
      (p as { stdout: ReadableStream<Uint8Array> }).stdout = stream;
      modelProcs.push(p);
      return p;
    },
  };
  return s;
}

interface HubHarness {
  hub: LocalBackendHub;
  db: Database;
  spawn: ScriptedSpawn;
  close: () => void;
}

function makeHub(over: Partial<HubDeps> = {}, scripted?: ScriptedSpawn): HubHarness {
  const db = openAppDatabase(":memory:");
  applySchema(db);
  // The SAME scripted spawn the hub uses must be the one tests assert on —
  // passing it explicitly prevents the override/assertion decoupling trap.
  const spawn = scripted ?? makeScriptedSpawn();
  const hub = new LocalBackendHub({
    db,
    binary: "/usr/local/bin/llama-server",
    spawnFn: spawn.spawnFn,
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    healthCheck: async () => true,
    log: () => {},
    idlePollMs: 10,
    ...over,
  });
  return { hub, db, spawn, close: () => db.close() };
}

/** White-box access to one ManagedModel — observe latch / inFlight / lastError. */
function entryOf(
  hub: LocalBackendHub,
  id: string,
): { manager: LlamaProcessManager; inFlight: number; lastError: string | null } {
  const models = (
    hub as unknown as {
      models: Map<string, { manager: LlamaProcessManager; inFlight: number; lastError: string | null }>;
    }
  ).models;
  const e = models.get(id);
  if (e === undefined) throw new Error(`no entry for ${id}`);
  return e;
}

async function waitFor(fn: () => boolean, what = "condition", timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Real backend stub (chat-through tests) ─────────────────────────────

const stubs: Array<{ close(): void }> = [];
afterAll(() => {
  for (const s of stubs) s.close();
  rmSync(ggufDir, { recursive: true, force: true });
});

async function makeChatStub(opts: { delayMs?: number } = {}): Promise<{
  port: number;
  requests: () => number;
  close: () => void | Promise<void>;
}> {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions") {
        requests += 1;
        if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
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
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/v1/embeddings") {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
            model: "stub",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const stub = { port: server.port ?? 0, requests: () => requests, close: () => server.stop(true) };
  stubs.push(stub);
  return stub;
}

// ── GGUF temp files + seeds ───────────────────────────────────────────

const ggufDir = mkdtempSync(join(tmpdir(), "hub-gguf-"));
let ggufSeq = 0;
function ggufFile(id?: string): string {
  ggufSeq += 1;
  const p = join(ggufDir, `${id ?? `model-${ggufSeq}`}.gguf`);
  writeFileSync(p, "fake gguf bytes");
  return p;
}

interface SeedModelOpts {
  id: string;
  path: string;
  active?: boolean;
  ggufCtx?: number | null;
  yarnOrigCtx?: number | null;
  config?: { ctxSize?: number; kvK?: string; kvV?: string; ngl?: number };
}

function seedModel(db: Database, opts: SeedModelOpts): void {
  db.query(
    `INSERT INTO models (id, source, name, path, gguf_ctx, yarn_orig_ctx, active, state)
     VALUES (?, 'local', ?, ?, ?, ?, ?, 'registered')`,
  ).run(
    opts.id,
    opts.id,
    opts.path,
    opts.ggufCtx ?? null,
    opts.yarnOrigCtx ?? null,
    opts.active === true ? 1 : 0,
  );
  const c = opts.config;
  if (c !== undefined) {
    db.query(
      `INSERT INTO model_config (model_id, ctx_size, kv_k, kv_v, ngl) VALUES (?, ?, ?, ?, ?)`,
    ).run(opts.id, c.ctxSize ?? null, c.kvK ?? null, c.kvV ?? null, c.ngl ?? null);
  }
}

function seedEmbeddingModel(db: Database, id: string): void {
  db.query(`INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', ?)`).run(id);
}

// ── Suite ──────────────────────────────────────────────────────────────

describe("LocalBackendHub — activation", () => {
  test("activate spawns with model_config + YaRN flags and persists active=1", async () => {
    const { hub, db, spawn } = makeHub();
    const path = ggufFile("m1");
    seedModel(db, {
      id: "m1",
      path,
      ggufCtx: 8192,
      yarnOrigCtx: 4096,
      config: { ctxSize: 8192, kvK: "q8_0", kvV: "q8_0", ngl: 99 },
    });

    const res = await hub.activate("m1");
    expect(res).toEqual({ state: "active", pid: 4242, port: 54321 });

    const modelSpawns = spawn.spawns.filter((s) => !s.args.includes("--version"));
    expect(modelSpawns).toHaveLength(1);
    const { cmd, args } = modelSpawns[0];
    expect(cmd).toBe("/usr/local/bin/llama-server");
    expect(args[args.indexOf("--model") + 1]).toBe(path);
    expect(args[args.indexOf("--ctx-size") + 1]).toBe("8192");
    expect(args[args.indexOf("--cache-type-k") + 1]).toBe("q8_0");
    expect(args[args.indexOf("--cache-type-v") + 1]).toBe("q8_0");
    expect(args[args.indexOf("--ngl") + 1]).toBe("99");
    expect(args[args.indexOf("--rope-scaling") + 1]).toBe("yarn");
    expect(args[args.indexOf("--rope-scale") + 1]).toBe("2");
    expect(args[args.indexOf("--yarn-orig-ctx") + 1]).toBe("4096");
    expect(args[args.indexOf("--port") + 1]).toBe("0");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");

    const row = db.query("SELECT active FROM models WHERE id = ?").get("m1") as { active: number };
    expect(row.active).toBe(1);
    expect(hub.localModels()).toEqual(["m1"]);
  });

  test("activate is idempotent for an already-running model", async () => {
    const { hub, db, spawn } = makeHub();
    seedModel(db, { id: "m1", path: ggufFile("m1") });

    const first = await hub.activate("m1");
    const second = await hub.activate("m1");
    expect(second).toEqual(first);
    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(1);
  });

  test("activate on a missing GGUF → HubError 400 naming the file; no spawn", async () => {
    const { hub, db, spawn } = makeHub();
    seedModel(db, { id: "m1", path: "/definitely/missing/m1.gguf" });

    await expect(hub.activate("m1")).rejects.toMatchObject({ status: 400 });
    await expect(hub.activate("m1")).rejects.toThrow(/GGUF file not found/);
    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(0);
  });

  test("activate spawn failure → HubError 503 and the entry reports error state", async () => {
    const { hub, db, spawn } = makeHub();
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    spawn.failModelSpawns = true;

    await expect(hub.activate("m1")).rejects.toMatchObject({ status: 503 });
    const st = hub.status("m1");
    expect(st?.state).toBe("error");
    expect(st?.error).toMatch(/never announced a listening port/);
    expect(entryOf(hub, "m1").lastError).toMatch(/never announced a listening port/);
  });

  test("activate on an unknown model → HubError 404", async () => {
    const { hub } = makeHub();
    await expect(hub.activate("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("LocalBackendHub — deactivation", () => {
  test("deactivate drains zero in-flight, stops the manager, persists active=0", async () => {
    const { hub, db } = makeHub();
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");

    const res = await hub.deactivate("m1");
    expect(res).toEqual({ state: "disabled" });
    const row = db.query("SELECT active FROM models WHERE id = ?").get("m1") as { active: number };
    expect(row.active).toBe(0);
    expect(hub.localModels()).toEqual([]);
    expect(hub.status("m1")).toEqual({ id: "m1", state: "disabled" });
  });

  test("deactivate waits for the in-flight request to finish, then stops", async () => {
    const stub = await makeChatStub({ delayMs: 200 });
    const { hub, db } = makeHub(
      { requestTimeoutMs: 5000 },
      makeScriptedSpawn({ port: () => stub.port }),
    );
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");

    const wrapper = hub.localProvider("m1")!;
    const chatP = wrapper.chat({ model: "m1", messages: [{ role: "user", content: "hi" }] });
    await waitFor(() => entryOf(hub, "m1").inFlight === 1, "in-flight marker");

    await hub.deactivate("m1"); // drain blocks until chat resolves
    const completion = (await chatP) as { choices: Array<{ message: { content: string } }> };
    expect(completion.choices[0].message.content).toBe("hello from stub");
    expect(hub.localModels()).toEqual([]);
  });

  test("drain safety timeout forces the stop while a request hangs", async () => {
    const stub = await makeChatStub({ delayMs: 10000 });
    const { hub, db } = makeHub(
      { drainPollMs: 10, drainTimeoutMs: 40, requestTimeoutMs: 150 },
      makeScriptedSpawn({ port: () => stub.port }),
    );
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");

    const wrapper = hub.localProvider("m1")!;
    const chatP = wrapper.chat({ model: "m1", messages: [{ role: "user", content: "hi" }] });
    void chatP.catch(() => {}); // mark handled — rejection lands at 150ms
    await waitFor(() => entryOf(hub, "m1").inFlight === 1, "in-flight marker");

    await hub.deactivate("m1"); // forced stop at the 40ms deadline
    expect(hub.localModels()).toEqual([]);
    await expect(chatP).rejects.toThrow(); // dangling chat aborts at 150ms
  });

  test("deactivate unknown model → 404; already-disabled → idempotent disabled", async () => {
    const { hub, db } = makeHub();
    await expect(hub.deactivate("nope")).rejects.toMatchObject({ status: 404 });

    seedModel(db, { id: "m1", path: ggufFile("m1"), active: false });
    await expect(hub.deactivate("m1")).resolves.toEqual({ state: "disabled" });
  });
});

describe("LocalBackendHub — status surface", () => {
  test("status 3D: active (pid/port) → disabled → error → unknown null", async () => {
    const { hub, db, spawn } = makeHub();
    seedModel(db, { id: "m1", path: ggufFile("m1") });

    await hub.activate("m1");
    expect(hub.status("m1")).toEqual({ id: "m1", state: "active", pid: 4242, port: 54321 });

    await hub.deactivate("m1");
    expect(hub.status("m1")).toEqual({ id: "m1", state: "disabled" });

    spawn.failModelSpawns = true;
    await hub.activate("m1").catch(() => {});
    expect(hub.status("m1")?.state).toBe("error");

    expect(hub.status("unknown")).toBeNull();
  });

  test("statusAll mirrors the three states without a stale set", async () => {
    const { hub, db, spawn } = makeHub();
    seedModel(db, { id: "active-m", path: ggufFile("a") });
    seedModel(db, { id: "disabled-m", path: ggufFile("b"), active: false });
    seedModel(db, { id: "error-m", path: ggufFile("c") });

    await hub.activate("active-m");
    spawn.failModelSpawns = true;
    await hub.activate("error-m").catch(() => {});

    const all = hub.statusAll();
    expect(all.find((s) => s.id === "active-m")?.state).toBe("active");
    expect(all.find((s) => s.id === "disabled-m")?.state).toBe("disabled");
    expect(all.find((s) => s.id === "error-m")?.state).toBe("error");
  });
});

describe("LocalBackendHub — preflight + restoreActive", () => {
  test("preflight ENOENT → per-model error, no spawns, no exit", async () => {
    const { hub, db, spawn } = makeHub({
      spawnFn: makeScriptedSpawn({ failVersion: true }).spawnFn,
    });
    seedModel(db, { id: "m1", path: ggufFile("m1"), active: true });

    await hub.preflight(); // resolves — boot continues
    await hub.restoreActive();

    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(0);
    const st = hub.status("m1");
    expect(st?.state).toBe("error");
    expect(st?.error).toContain("llama-server binary not found at '/usr/local/bin/llama-server'");
    expect(hub.localModels()).toEqual([]);
  });

  test("preflight old build → global fail-fast exit(1)", async () => {
    const { hub, db } = makeHub({
      spawnFn: makeScriptedSpawn({ version: "llama.cpp version: b4140 (xyz)" }).spawnFn,
      exit: (code: number): never => {
        throw new Error(`EXIT:${code}`);
      },
    });
    seedModel(db, { id: "m1", path: ggufFile("m1"), active: true });

    await expect(hub.preflight()).rejects.toThrow("EXIT:1");
  });

  test("restoreActive spawns every active=1 row (preflight ok)", async () => {
    const { hub, db, spawn } = makeHub();
    seedModel(db, { id: "m1", path: ggufFile("m1"), active: true });
    seedModel(db, { id: "m2", path: ggufFile("m2"), active: true });
    seedModel(db, { id: "m3", path: ggufFile("m3"), active: false });

    await hub.preflight();
    await hub.restoreActive();

    const modelSpawns = spawn.spawns.filter((s) => !s.args.includes("--version"));
    expect(modelSpawns).toHaveLength(2);
    expect(hub.localModels()).toEqual(expect.arrayContaining(["m1", "m2"]));
    expect(hub.localModels()).not.toContain("m3");
    expect(hub.status("m3")?.state).toBe("disabled");
  });

  test("restoreActive missing GGUF → error state, boot continues", async () => {
    const { hub, db } = makeHub();
    seedModel(db, { id: "broken", path: "/missing/broken.gguf", active: true });
    seedModel(db, { id: "ok", path: ggufFile("ok"), active: true });

    await hub.preflight();
    await hub.restoreActive();

    expect(hub.localModels()).not.toContain("broken");
    expect(hub.status("broken")?.state).toBe("error");
    expect(hub.status("broken")?.error).toContain("GGUF file not found");
    expect(hub.localModels()).toEqual(["ok"]);
  });
});

describe("LocalBackendHub — readiness-gating wrapper", () => {
  test("idle-stop then chat → lazy re-spawn succeeds; status stays active", async () => {
    const stub = await makeChatStub();
    const { hub, db, spawn } = makeHub(
      { idleTimeoutMs: 40, idlePollMs: 10 },
      makeScriptedSpawn({ port: () => stub.port }),
    );
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");

    await waitFor(() => entryOf(hub, "m1").manager.status().state === "stopped", "idle stop");
    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(1);

    const wrapper = hub.localProvider("m1")!;
    const completion = (await wrapper.chat({
      model: "m1",
      messages: [{ role: "user", content: "still there?" }],
    })) as { choices: Array<{ message: { content: string } }> };
    expect(completion.choices[0].message.content).toBe("hello from stub");
    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(2);
    expect(hub.status("m1")?.state).toBe("active");
    expect(hub.status("m1")?.port).toBe(stub.port);
  });

  test("concurrent requests while stopped share ONE re-spawn", async () => {
    const stub = await makeChatStub();
    const { hub, db, spawn } = makeHub(
      { idleTimeoutMs: 40, idlePollMs: 10 },
      makeScriptedSpawn({ port: () => stub.port }),
    );
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");
    await waitFor(() => entryOf(hub, "m1").manager.status().state === "stopped", "idle stop");

    const wrapper = hub.localProvider("m1")!;
    const [a, b] = await Promise.all([
      wrapper.chat({ model: "m1", messages: [{ role: "user", content: "a" }] }),
      wrapper.chat({ model: "m1", messages: [{ role: "user", content: "b" }] }),
    ]);
    expect((a as { choices: unknown[] }).choices).toHaveLength(1);
    expect((b as { choices: unknown[] }).choices).toHaveLength(1);
    // 1 initial + 1 shared re-spawn
    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(2);
  });

  test("wrapper on backend error → 503 immediately (no retry loop)", async () => {
    const stub = await makeChatStub();
    const { hub, db, spawn } = makeHub({}, makeScriptedSpawn({ port: () => stub.port }));
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");

    await entryOf(hub, "m1").manager.stop(); // crash into the stopped path
    spawn.failModelSpawns = true; // the re-spawn must now fail

    const wrapper = hub.localProvider("m1")!;
    await expect(
      wrapper.chat({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ status: 503 });
    expect(hub.status("m1")?.state).toBe("error");
  });

  test("chat during starting joins the activate latch (no double spawn)", async () => {
    const stub = await makeChatStub();
    let healthy = false;
    const spawned = makeScriptedSpawn({ port: () => stub.port, stdoutDelayMs: 60 });
    const { hub, db, spawn } = makeHub(
      {
        // REAL sleep: the delayed port line must beat the port-race timer —
        // a capped sleep would win the race and cancel the pending read.
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        healthCheck: async () => healthy,
      },
      spawned,
    );
    seedModel(db, { id: "m1", path: ggufFile("m1") });

    const activateP = hub.activate("m1"); // not awaited — model is "starting"
    const wrapper = hub.localProvider("m1")!;
    const chatP = wrapper.chat({ model: "m1", messages: [{ role: "user", content: "hi" }] });
    setTimeout(() => {
      healthy = true; // health flips before the port line arrives at 60ms
    }, 20);

    const completion = (await chatP) as { choices: Array<{ message: { content: string } }> };
    expect(completion.choices[0].message.content).toBe("hello from stub");
    expect((await activateP).state).toBe("active");
    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(1);
  });

  test("zero-arg localProvider dispatches per request.model", async () => {
    const stub = await makeChatStub();
    const { hub, db } = makeHub({}, makeScriptedSpawn({ port: () => stub.port }));
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");

    const dispatch = hub.localProvider();
    expect(dispatch).not.toBeNull();
    const completion = (await dispatch!.chat({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
    })) as { choices: Array<{ message: { content: string } }> };
    expect(completion.choices[0].message.content).toBe("hello from stub");
  });
});

describe("LocalBackendHub — embedder", () => {
  test("no designated embedding model → embedder() null", async () => {
    const { hub, db } = makeHub();
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    await hub.activate("m1");
    expect(hub.embedder()).toBeNull();
  });

  test("designation + activate → non-null, spawns with --embeddings, gates on re-spawn", async () => {
    const stub = await makeChatStub();
    const { hub, db, spawn } = makeHub(
      { idleTimeoutMs: 40, idlePollMs: 10 },
      makeScriptedSpawn({ port: () => stub.port }),
    );
    const path = ggufFile("em");
    seedModel(db, { id: "em", path });
    seedEmbeddingModel(db, "em");
    await hub.activate("em");

    expect(spawn.spawns[0].args).toContain("--embeddings");
    expect(hub.embedder()).not.toBeNull();

    await waitFor(() => entryOf(hub, "em").manager.status().state === "stopped", "idle stop");
    const res = await hub.embedder()!.embed("hello");
    expect(res.data[0].embedding).toEqual([0.1, 0.2]);
    expect(spawn.spawns.filter((s) => !s.args.includes("--version"))).toHaveLength(2);
  });

  test("embedder nulls on deactivate and is rebuilt on re-activate", async () => {
    const { hub, db } = makeHub();
    seedModel(db, { id: "em", path: ggufFile("em") });
    seedEmbeddingModel(db, "em");
    await hub.activate("em");
    expect(hub.embedder()).not.toBeNull();

    await hub.deactivate("em");
    expect(hub.embedder()).toBeNull();

    await hub.activate("em");
    expect(hub.embedder()).not.toBeNull();
  });
});

describe("LocalBackendHub — stopAll", () => {
  test("drains and stops every manager, clears the maps", async () => {
    const { hub, db, spawn } = makeHub();
    seedModel(db, { id: "m1", path: ggufFile("m1") });
    seedModel(db, { id: "m2", path: ggufFile("m2") });
    await hub.activate("m1");
    await hub.activate("m2");

    const procs = [...spawn.modelProcs];
    await hub.stopAll();

    for (const p of procs) expect(p.killed).toBe(true);
    expect(hub.localModels()).toEqual([]);
    expect(hub.embedder()).toBeNull();
  });
});