/**
 * Phase 2 — LlamaProcessManager (single-model llama-server lifecycle).
 * DI seams inject the spawn primitive, clock, sleep, health check, and log
 * so the whole lifecycle is testable with fakes (no real llama-server).
 * Specs: backend-management (single spawn, --port 0 + stdout regex,
 * wait-ready before traffic, restart on crash, fail-fast boot, idle stop).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  LlamaProcessManager,
  idleElapsed,
  IDLE_TIMEOUT_MS,
  type ManagerDeps,
  type SpawnedProc,
} from "./manager.js";

// ── Fake process harness ──────────────────────────────────────────────

function textStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const line of lines) controller.enqueue(enc.encode(`${line}\n`));
      // Simulate process exit: a closed stream completes read() with `done`.
      controller.close();
    },
  });
}

interface FakeProcOpts {
  stdoutLines?: string[];
  stderrLines?: string[];
}

function makeProc(opts: FakeProcOpts = {}): SpawnedProc & {
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
    stdout: textStream(opts.stdoutLines ?? []),
    stderr: textStream(opts.stderrLines ?? []),
    exited,
    killed: false,
    kill: function () {
      this.killed = true;
      resolveExit(0);
    },
    resolveExit,
  };
}

interface Harness {
  deps: ManagerDeps;
  spawns: Array<{ cmd: string; args: string[] }>;
}

function makeHarness(over: Partial<ManagerDeps> = {}): Harness {
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn = (cmd: string, args: string[]): SpawnedProc => {
    spawns.push({ cmd, args });
    return makeProc();
  };
  const deps: ManagerDeps = {
    binary: "/usr/local/bin/llama-server",
    run: { modelPath: "/m/models/q4.gguf", ctxSize: 131072, rope: { scale: 4, origCtx: 32768 } },
    spawnFn: spawnFn as unknown as ManagerDeps["spawnFn"],
    now: () => performance.now(),
    // Real (capped) timers — an instant-sleep fake starves the event loop:
    // the idle watchdog's microtask loop would prevent setTimeout from firing.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    healthCheck: async () => true,
    log: () => {},
    startTimeoutMs: 200,
    healthPollMs: 10,
    idlePollMs: 20,
    maxRestartAttempts: 3,
    ...over,
  };
  return { deps, spawns };
}

const PORT_LINE = "llama-server: listening on 127.0.0.1:54321";

beforeEach(() => {});

describe("LlamaProcessManager — single-model lifecycle", () => {
  test("start spawns one llama-server with --port 0 and waits for the stdout port", async () => {
    const h = makeHarness();
    const seeded = makeProc({ stdoutLines: [PORT_LINE] });
    const manager = new LlamaProcessManager(h.deps);
    (manager as unknown as { spawnOnce: () => SpawnedProc }).spawnOnce = () => seeded;
    await manager.start();
    const st = manager.status();
    expect(st.state).toBe("running");
    expect(st.port).toBe(54321);
    expect(st.baseUrl).toBe("http://127.0.0.1:54321");
    await manager.stop();
    expect(seeded.killed).toBe(true);
  });

  test("spawn args include --port 0, model path, ctx and YaRN flags", async () => {
    const seeded = makeProc({ stdoutLines: [PORT_LINE] });
    const recorded: Array<{ cmd: string; args: string[] }> = [];
    const manager = new LlamaProcessManager({
      ...makeHarness().deps,
      spawnFn: (cmd: string, args: string[]) => {
        recorded.push({ cmd, args });
        return seeded;
      },
    });
    await manager.start();
    expect(recorded.length).toBe(1);
    const { cmd, args } = recorded[0];
    expect(cmd).toBe("/usr/local/bin/llama-server");
    expect(args).toContain("--port");
    expect(args[args.indexOf("--port") + 1]).toBe("0");
    expect(args[args.indexOf("--model") + 1]).toBe("/m/models/q4.gguf");
    expect(args[args.indexOf("--rope-scaling") + 1]).toBe("yarn");
    await manager.stop();
  });

  test("wait-ready gate: traffic only after health passes; port from stdout regex", async () => {
    let healthy = false;
    const h = makeHarness({ healthCheck: async () => healthy });
    const seeded = makeProc({ stdoutLines: [PORT_LINE] });
    const manager = new LlamaProcessManager(h.deps);
    (manager as unknown as { spawnOnce: () => SpawnedProc }).spawnOnce = () => seeded;
    const startP = manager.start();
    // give the poll loop a beat, then flip health to true
    await new Promise((r) => setTimeout(r, 30));
    healthy = true;
    await startP;
    expect(manager.status().state).toBe("running");
    await manager.stop();
  });

  test("fail-fast: never-ready backend rejects with actionable stderr tail", async () => {
    const h = makeHarness({
      healthCheck: async () => false,
      startTimeoutMs: 50,
      healthPollMs: 10,
    });
    const seeded = makeProc({
      stdoutLines: ["itllama: loading model..."],
      stderrLines: ["error: out of memory allocating KV cache"],
    });
    const manager = new LlamaProcessManager(h.deps);
    (manager as unknown as { spawnOnce: () => SpawnedProc }).spawnOnce = () => seeded;
    await expect(manager.start()).rejects.toThrow(/out of memory|never became ready|failed/i);
    expect(seeded.killed).toBe(true);
  });

  test("EADDRINUSE in stderr yields an actionable address-in-use error", async () => {
    const h = makeHarness({ startTimeoutMs: 50, healthPollMs: 10 });
    const seeded = makeProc({
      stderrLines: ["llama-server: error: bind() failed: Address already in use (EADDRINUSE)"],
    });
    const manager = new LlamaProcessManager(h.deps);
    (manager as unknown as { spawnOnce: () => SpawnedProc }).spawnOnce = () => seeded;
    await expect(manager.start()).rejects.toThrow(/address already in use|EADDRINUSE/i);
  });

  test("restart on crash: unexpected exit respawns with backoff until healthy", async () => {
    const h = makeHarness();
    const first = makeProc({ stdoutLines: [PORT_LINE] });
    const second = makeProc({ stdoutLines: [PORT_LINE] });
    let useFirst = true;
    const spawnFn = (_cmd: string, _args: string[]) => {
      const p = useFirst ? first : second;
      useFirst = false;
      return p;
    };
    const manager = new LlamaProcessManager({
      ...h.deps,
      spawnFn: spawnFn as unknown as ManagerDeps["spawnFn"],
    });
    await manager.start();
    expect(manager.status().state).toBe("running");
    // simulator: the backend crashes
    first.resolveExit(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(manager.status().state).toBe("running");
    expect(second.killed).toBe(false);
    await manager.stop();
  });

  test("idle kill: an unused backend stops after the idle timeout", async () => {
    const h = makeHarness({
      idleTimeoutMs: 40,
      idlePollMs: 10,
      healthCheck: async () => true,
    });
    const seeded = makeProc({ stdoutLines: [PORT_LINE] });
    const manager = new LlamaProcessManager(h.deps);
    (manager as unknown as { spawnOnce: () => SpawnedProc }).spawnOnce = () => seeded;
    await manager.start();
    expect(manager.status().state).toBe("running");
    await new Promise((r) => setTimeout(r, 300));
    expect(manager.status().state).toBe("stopped");
    expect(seeded.killed).toBe(true);
  });

  test("noteRequest keeps an active backend alive past the idle timeout", async () => {
    const h = makeHarness({ idleTimeoutMs: 60, idlePollMs: 10, healthCheck: async () => true });
    const seeded = makeProc({ stdoutLines: [PORT_LINE] });
    const manager = new LlamaProcessManager(h.deps);
    (manager as unknown as { spawnOnce: () => SpawnedProc }).spawnOnce = () => seeded;
    await manager.start();
    // touch every 30ms across a 60ms idle budget → never idle
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      manager.noteRequest();
    }
    expect(manager.status().state).toBe("running");
    await manager.stop();
  });

  test("stop is graceful (SIGTERM-style kill) and terminal", async () => {
    const h = makeHarness();
    const seeded = makeProc({ stdoutLines: [PORT_LINE] });
    const manager = new LlamaProcessManager(h.deps);
    (manager as unknown as { spawnOnce: () => SpawnedProc }).spawnOnce = () => seeded;
    await manager.start();
    await manager.stop();
    expect(manager.status().state).toBe("stopped");
  });

  test("checkVersion enforces the b9908+ floor via --version output", async () => {
    const old = makeProc({ stdoutLines: ["llama.cpp version: b4140 (abc)"] });
    const oldManager = new LlamaProcessManager({
      ...makeHarness().deps,
      spawnFn: (() => old) as unknown as ManagerDeps["spawnFn"],
    });
    await expect(oldManager.checkVersion()).rejects.toThrow(/b9908|upgrade|update/i);

    const ok = makeProc({ stdoutLines: ["llama.cpp version: b9908 (x)"] });
    const okManager = new LlamaProcessManager({
      ...makeHarness().deps,
      spawnFn: (() => ok) as unknown as ManagerDeps["spawnFn"],
    });
    await expect(okManager.checkVersion()).resolves.toBe("b9908");
  });
});

describe("idleElapsed — pure idle decision", () => {
  test("returns true only once the idle timeout has passed since the last request", () => {
    const now = 5 * 60 * 1000;
    expect(idleElapsed(now - 1000, now, IDLE_TIMEOUT_MS)).toBe(false);
    expect(idleElapsed(now - IDLE_TIMEOUT_MS, now, IDLE_TIMEOUT_MS)).toBe(true);
    expect(idleElapsed(now - IDLE_TIMEOUT_MS - 1, now, IDLE_TIMEOUT_MS)).toBe(true);
  });
});