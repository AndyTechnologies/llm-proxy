/**
 * LlamaServeManager tests (strict TDD, S1 — Bun.spawn migration).
 *
 * These are adapter-level tests over the manager's DI seam (ADR-3): the
 * spawnFn/now/sleep dependencies are injected fakes, so no real llama-server
 * is spawned here (that boundary is the S1.6 supervisor smoke). The
 * health-poll readiness gate IS exercised against a real in-process Bun.serve
 * fixture: the fetch path is production code, not a mock.
 *
 * Fake-proc contract (runtime-verified 2026-09-02, Bun 1.4.0):
 *  - supervision MUST use the `exited` Promise — Subprocess has no onExit;
 *  - `exitCode`/`signalCode` go live BEFORE `exited` resolves (verified);
 *  - stdout/stderr chunks are Uint8Array and MUST be decoded before matching.
 *
 * The manager rewrite never uses onExit. Every fake resolves `exited` and sets
 * exitCode/signalCode exactly like a real Subprocess does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlamaConfig } from "../config/schema.js";
import {
  createLlamaServeManager,
  type ManagerDeps,
  type SpawnFn,
  type SpawnedProc,
} from "./manager.js";

const enc = new TextEncoder();

// ── Fixtures ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-proxy-manager-"));
  fs.mkdirSync(path.join(tmpDir, "models"));
  fs.mkdirSync(path.join(tmpDir, "bin"));
  // Executable fake binary + a GGUF file: real fs so start()'s fail-fast
  // config validation (unchanged in S1) passes hermetically.
  const binPath = path.join(tmpDir, "bin", "llama");
  fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(path.join(tmpDir, "models", "m1.gguf"), "dummy", "utf8");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Generated preset INI (gitignored) — written by the real writePresetIni.
  fs.rmSync(path.resolve(".llm-proxy"), { recursive: true, force: true });
});

/** Minimal LlamaConfig with schema-default router values. */
function baseConfig(over: Partial<LlamaConfig> = {}): LlamaConfig {
  return {
    binary: path.join(tmpDir, "bin", "llama"),
    host: "127.0.0.1",
    port: 0,
    autoStart: true,
    startupTimeoutMs: 30000,
    stopTimeoutMs: 5000,
    requestTimeoutMs: 300000,
    healthPollIntervalMs: 1000,
    portParseTimeoutMs: 5000,
    backoffCapMs: 30000,
    maxRestartAttempts: 5,
    modelsDir: path.join(tmpDir, "models"),
    autoload: true,
    router: {
      ctx: 8192,
      n: 2048,
      nGpuLayers: -1,
      flashAttn: true,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      batch: 2048,
      ubatch: 512,
      tools: "all",
      parallel: 1,
    },
    models: { m1: { file: "m1.gguf" } },
    ...over,
  };
}

/** A spawnable ReadableStream pre-filled with Uint8Array chunks. */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

interface FakeProcState {
  proc: SpawnedProc;
  killCalls: string[];
  /** Recorded stdout chunks (post-decode expectations can inspect these). */
  resolveExited: (code: number) => void;
}

/**
 * Fake spawned proc shaped EXACTLY like Bun's Subprocess surface the manager
 * uses: `exited` Promise + live exitCode/signalCode + Uint8Array streams.
 * No onExit anywhere — mirroring the real Bun 1.4.0 Subprocess.
 */
function fakeProc(
  over: {
    stdoutChunks?: Uint8Array[];
    stderrChunks?: Uint8Array[];
    pid?: number | null;
    exitCode?: number | null;
    signalCode?: string | null;
  } = {},
): FakeProcState {
  const killCalls: string[] = [];
  let resolveExitedValue: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExitedValue = resolve;
  });
  const proc: SpawnedProc = {
    pid: over.pid ?? 12345,
    exitCode: over.exitCode ?? null,
    signalCode: over.signalCode ?? null,
    stdout: streamFromChunks(over.stdoutChunks ?? []),
    stderr: streamFromChunks(over.stderrChunks ?? []),
    exited,
    kill: (signal) => {
      killCalls.push(signal ?? "SIGTERM");
    },
  };
  return {
    proc,
    killCalls,
    resolveExited: (code) => {
      proc.exitCode = code; // live before `exited` resolves (Bun-verified)
      resolveExitedValue(code);
    },
  };
}

interface Harness {
  deps: ManagerDeps;
  logs: string[];
  clock: () => number;
  sleepCalls: number[];
  spawnCalls: Array<{
    cmd: string;
    args: string[];
    env: Record<string, string | undefined>;
  }>;
  procs: FakeProcState[];
}

/**
 * DI harness: spawnFn records argv and hands out fakes; `now` is a mutable
 * clock; `sleep` records delays, advances the clock, and resolves immediately.
 */
function buildHarness(
  cfg: LlamaConfig,
  makeProc: (index: number) => FakeProcState = () => fakeProc(),
): Harness {
  const logs: string[] = [];
  let clock = 0;
  const sleepCalls: number[] = [];
  const spawnCalls: Harness["spawnCalls"] = [];
  const procs: FakeProcState[] = [];
  const spawnFn: SpawnFn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, env: opts.env });
    const p = makeProc(procs.length);
    procs.push(p);
    return p.proc;
  };
  const deps: ManagerDeps = {
    config: cfg,
    logger: (msg) => logs.push(msg),
    spawnFn,
    now: () => clock,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      clock += ms;
    },
  };
  return { deps, logs, clock: () => clock, sleepCalls, spawnCalls, procs };
}

/** Real in-process health endpoint the manager's readiness gate polls. */
function healthServer(
  opts: { onRequest?: () => void; status?: () => number } = {},
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch: () => {
      opts.onRequest?.();
      const status = opts.status?.() ?? 200;
      return new Response(status === 200 ? "ok" : "not-ready", { status });
    },
  });
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function expectRejection(
  promise: Promise<unknown>,
): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: Error) => err,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("startup and readiness (S1.1)", () => {
  test("dynamic port: decodes Uint8Array stdout, parses 'listening on', polls health, reaches running", async () => {
    const server = healthServer();
    try {
      const cfg = baseConfig({ port: 0 });
      const chunk = enc.encode(`llama-server: listening on 127.0.0.1:${server.port}\n`);
      const h = buildHarness(cfg, () => fakeProc({ stdoutChunks: [chunk] }));
      const manager = createLlamaServeManager(h.deps);

      await manager.start();

      const st = manager.status();
      expect(st.state).toBe("running");
      expect(st.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(st.pid).toBe(12345);
      // Spawn argv was built BEFORE port detection (dynamic port stays 0).
      expect(h.spawnCalls[0].args).toContain("--port");
      const allLogs = h.logs.join("\n");
      expect(allLogs).toContain(`detected dynamic port: ${server.port}`);
      expect(allLogs).toContain(`backend ready: pid=12345, baseUrl=http://127.0.0.1:${server.port}`);
    } finally {
      server.stop();
    }
  });

  test("dynamic port: URL-form banner on stderr is detected (llama.cpp logs the listening line to stderr)", async () => {
    const server = healthServer();
    try {
      const cfg = baseConfig({ port: 0 });
      const chunk = enc.encode(
        `0.00.066.347 I srv  llama_server: listening on http://127.0.0.1:${server.port}\n`,
      );
      const h = buildHarness(cfg, () => fakeProc({ stderrChunks: [chunk] }));
      const manager = createLlamaServeManager(h.deps);

      await manager.start();

      const st = manager.status();
      expect(st.state).toBe("running");
      expect(st.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(h.logs.join("\n")).toContain(`detected dynamic port: ${server.port}`);
    } finally {
      server.stop();
    }
  });

  test("fixed port: spawn argv is exact (router mode, no shell), CUDA env injected", async () => {
    const server = healthServer();
    try {
      const cfg = baseConfig({
        port: server.port,
        autoload: false,
        models: { m1: { file: "m1.gguf" } },
      });
      const h = buildHarness(cfg);
      const manager = createLlamaServeManager(h.deps);

      await manager.start();

      expect(h.spawnCalls).toHaveLength(1);
      expect(h.spawnCalls[0].cmd).toBe(cfg.binary);
      expect(h.spawnCalls[0].args).toEqual([
        "serve",
        "--host", "127.0.0.1",
        "--port", String(server.port),
        "--models-dir", cfg.modelsDir,
        "--models-preset", path.resolve(".llm-proxy", "models.ini"),
        "--ctx-size", "8192",
        "--n-predict", "2048",
        "--n-gpu-layers", "-1",
        "--cache-type-k", "q8_0",
        "--cache-type-v", "q8_0",
        "-b", "2048",
        "-ub", "512",
        "--parallel", "1",
        "--flash-attn", "on",
        "--tools", "all",
        "--no-models-autoload",
      ]);
      expect(h.spawnCalls[0].env.CUDA_VISIBLE_DEVICES).toBe(
        process.env.CUDA_VISIBLE_DEVICES ?? "0",
      );
      expect(manager.status().state).toBe("running");
    } finally {
      server.stop();
    }
  });

  test("dynamic port never detected → actionable error within portParseTimeoutMs", async () => {
    const cfg = baseConfig({ port: 0, portParseTimeoutMs: 5000 });
    const h = buildHarness(cfg, () =>
      fakeProc({ stdoutChunks: [enc.encode("llama-server: loading model...\n")] }),
    );
    const manager = createLlamaServeManager(h.deps);

    const err = await expectRejection(manager.start());
    expect(err.message).toContain(
      "could not detect dynamic port from llama-server stdout within 5000ms",
    );
    expect(h.sleepCalls[0]).toBe(5000); // port-parse wait used the configured timeout
  });

  test("early exit before readiness fails fast with code/signal details (no restart during startup)", async () => {
    const cfg = baseConfig({ port: 18080 });
    const p = fakeProc({ exitCode: 3 });
    p.resolveExited(3);
    const h = buildHarness(cfg, () => p);
    const manager = createLlamaServeManager(h.deps);

    const err = await expectRejection(manager.start());
    expect(err.message).toContain(
      "exited before becoming ready (code=3, signal=n/a)",
    );
    expect(err.message).toContain("(no stderr captured)");
    expect(h.logs.join("\n")).not.toContain("restarting in");
  });

  test("port-collision guard: health 200 while our child died → fail-fast, not false-ready", async () => {
    let h: Harness;
    const server = healthServer({
      onRequest: () => {
        // The FIRST health poll succeeds while OUR child is still alive; the
        // foreign process keeps answering 200 AFTER our child dies mid-poll.
        // The re-check after the 200 must catch the dead child.
        h.procs[0]?.resolveExited(3);
      },
    });
    try {
      const cfg = baseConfig({ port: server.port, host: "127.0.0.1" });
      h = buildHarness(cfg, () => fakeProc());
      const manager = createLlamaServeManager(h.deps);

      const err = await expectRejection(manager.start());
      expect(err.message).toContain(
        "exited after health check succeeded (possible port conflict)",
      );
      expect(manager.status().state).not.toBe("running");
    } finally {
      server.stop();
    }
  });

  test("backend never healthy → SIGKILL + actionable timeout message with stderr tail", async () => {
    const server = healthServer({ status: () => 503 });
    try {
      const cfg = baseConfig({
        port: server.port,
        startupTimeoutMs: 3000,
        healthPollIntervalMs: 1000,
      });
      const p = fakeProc({ stderrChunks: [enc.encode("CUDA error: out of memory\n")] });
      const h = buildHarness(cfg, () => p);
      const manager = createLlamaServeManager(h.deps);

      const err = await expectRejection(manager.start());
      expect(err.message).toContain("did not become ready within 3000ms");
      expect(err.message).toContain("CUDA error: out of memory");
      expect(p.killCalls).toContain("SIGKILL");
    } finally {
      server.stop();
    }
  });

  test("stderr diagnostics tail is bounded to 4KB", async () => {
    const cfg = baseConfig({ port: 18081 });
    const big = "E".repeat(10000);
    const p = fakeProc({ stderrChunks: [enc.encode(big)], exitCode: 3 });
    p.resolveExited(3);
    const h = buildHarness(cfg, () => p);
    const manager = createLlamaServeManager(h.deps);

    const err = await expectRejection(manager.start());
    expect(err.message).toContain("last stderr:");
    expect(err.message).toContain("E".repeat(4096)); // tail kept
    expect(err.message).not.toContain("E".repeat(5000)); // head dropped
  });

  test("spawn failure (Bun.spawn sync ENOENT) → start() rejects, state error", async () => {
    const cfg = baseConfig({ port: 18082 });
    const h = buildHarness(cfg, () => {
      throw new Error("ENOENT: no such file or directory, posix_spawn '/nope'");
    });
    const manager = createLlamaServeManager(h.deps);

    const err = await expectRejection(manager.start());
    expect(err.message).toContain("ENOENT");
    expect(manager.status().state).toBe("error");
    expect(h.logs.join("\n")).toContain("spawn error:");
  });
});

describe("supervision and restart (S1.2)", () => {
  test("unexpected exit → restart with backoff delay → ready again; backoff resets on success", async () => {
    const server = healthServer();
    try {
      const cfg = baseConfig({ port: server.port, maxRestartAttempts: 5, backoffCapMs: 8000 });
      const h = buildHarness(cfg, () => fakeProc());
      const manager = createLlamaServeManager(h.deps);

      await manager.start();
      expect(manager.status().state).toBe("running");
      expect(h.spawnCalls).toHaveLength(1);

      // Crash the running child: supervision must restart it (exited-based).
      h.procs[0].resolveExited(3);
      await waitUntil(() => h.spawnCalls.length === 2);
      await waitUntil(() => manager.status().state === "running");

      expect(h.logs.join("\n")).toContain(
        "backend exited unexpectedly (code=3, signal=n/a)",
      );
      expect(h.logs.join("\n")).toContain("restarting in 1000ms (backoff)");
      expect(h.logs.join("\n")).toContain("attempting restart...");
      // The stderr flush (50ms grace) may precede the backoff sleep in the
      // sleep log — what matters is the backoff delay value itself.
      expect(h.sleepCalls).toContain(1000); // BACKOFF_INITIAL_MS

      // After a successful restart the backoff resets: next crash schedules 1000 again.
      h.procs[1].resolveExited(1);
      await waitUntil(() => h.spawnCalls.length === 3);
      expect(h.sleepCalls).toContain(1000);
      expect(h.logs.join("\n")).toContain("restarting in 1000ms (backoff)");
    } finally {
      server.stop();
    }
  });

  test("restart cap: after maxRestartAttempts the manager stops retrying, dumps stderr, state error", async () => {
    const server = healthServer();
    try {
      const cfg = baseConfig({ port: server.port, maxRestartAttempts: 2 });
      const h = buildHarness(cfg, () => fakeProc());
      const manager = createLlamaServeManager(h.deps);

      await manager.start(); // spawn #1

      h.procs[0].resolveExited(3);
      await waitUntil(() => h.spawnCalls.length === 2); // spawn #2 (restart 1)
      await waitUntil(() => manager.status().state === "running");

      h.procs[1].resolveExited(3);
      await waitUntil(() => h.spawnCalls.length === 3); // spawn #3 (restart 2)
      await waitUntil(() => manager.status().state === "running");

      // Third crash exceeds the cap: no fourth spawn, error state, no orphan.
      h.procs[2].resolveExited(3);
      await waitUntil(() => h.logs.join("\n").includes("failed to stay up after 2 attempts"));

      const logs = h.logs.join("\n");
      expect(h.spawnCalls).toHaveLength(3);
      expect(manager.status().state).toBe("error");
      expect(logs).toContain("backend failed to stay up after 2 attempts — check port/config conflicts");
      expect(logs).toContain("last stderr:");
      expect(logs).toContain("(no stderr captured)");
    } finally {
      server.stop();
    }
  });

  test("stop(): SIGTERM first, no restart after stop, state stopped", async () => {
    const server = healthServer();
    try {
      const cfg = baseConfig({ port: server.port });
      const h = buildHarness(cfg, () => fakeProc());
      const manager = createLlamaServeManager(h.deps);

      await manager.start();
      const stopPromise = manager.stop();
      expect(h.procs[0].killCalls).toEqual(["SIGTERM"]);

      h.procs[0].resolveExited(143); // graceful SIGTERM exit
      await stopPromise;

      const st = manager.status();
      expect(st.state).toBe("stopped");
      expect(st.pid).toBeNull();
      expect(h.logs.join("\n")).toContain("backend stopped");
      expect(h.logs.join("\n")).not.toContain("restarting in");
      expect(h.spawnCalls).toHaveLength(1); // never restarted
    } finally {
      server.stop();
    }
  });

  test("stop(): SIGKILL fallback after stopTimeoutMs when child ignores SIGTERM", async () => {
    const server = healthServer();
    try {
      const cfg = baseConfig({ port: server.port, stopTimeoutMs: 5000 });
      const h = buildHarness(cfg, () => fakeProc());
      const manager = createLlamaServeManager(h.deps);

      await manager.start();
      // exited stays pending forever → the stop timeout must force SIGKILL.
      await manager.stop();

      expect(h.procs[0].killCalls).toEqual(["SIGTERM", "SIGKILL"]);
      expect(h.logs.join("\n")).toContain("SIGKILL sent to pid=12345");
      expect(manager.status().state).toBe("stopped");
    } finally {
      server.stop();
    }
  });
});