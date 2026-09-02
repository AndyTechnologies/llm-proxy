/**
 * LlamaServeManager — lifecycle manager for the managed llama-server process.
 *
 * Spawns `llama serve` in router mode via Bun.spawn, waits for readiness via
 * health-check polling, supervises with exponential-backoff restart on
 * unexpected exit (bounded by config.maxRestartAttempts, fail-fast when
 * exceeded), and performs graceful shutdown (SIGTERM → timeout → SIGKILL).
 *
 * The manager is the single source of truth for:
 *  - Whether the backend is running (status().state)
 *  - The dynamic port the backend is listening on (status().baseUrl)
 *  - Which models are registered (status().models)
 *
 * DESIGN DECISION: the manager validates config, creates the preset INI,
 * spawns the process, and polls readiness. This keeps the boot sequence
 * simple: one `await manager.start()` call before `app.listen()`.
 *
 * MIGRATION (S1, Bun 1.4.0): `node:child_process` → `Bun.spawn`. Exit
 * supervision uses the `exited` Promise and its live `exitCode`/`signalCode`
 * (Bun's Subprocess has no onExit — runtime-verified). stdout/stderr chunks
 * are Uint8Array and are decoded before port-regex/log matching. The spawn
 * primitive and the clock are injected (spawnFn/now/sleep, ADR-3) because
 * `mock.module("bun")` cannot intercept the builtin bun module.
 */
import { spawn } from "bun";
import path from "node:path";
import { validateBackendConfig } from "./validation.js";
import { writePresetIni } from "./preset.js";
import type { LlamaConfig } from "../config/schema.js";

/** Backend operational status. */
export interface BackendStatus {
  state: "starting" | "running" | "stopped" | "error";
  pid: number | null;
  models: string[];
  baseUrl: string;
}

/**
 * Minimal process surface the manager supervises — a structural subset of
 * Bun's Subprocess (stdout/stderr piped, so the streams are non-null).
 */
export interface SpawnedProc {
  pid: number | null;
  exitCode: number | null;
  signalCode: string | null;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}

/** Spawn primitive. Real default is Bun.spawn; tests inject fakes (ADR-3). */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined> },
) => SpawnedProc;

/** Factory deps — injected by the entry point. */
export interface ManagerDeps {
  config: LlamaConfig;
  logger?: (msg: string) => void;
  spawnFn?: SpawnFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Initial restart backoff; growth and cap come from config (healthPoll/backoffCap). */
const BACKOFF_INITIAL_MS = 1000;
/** Bounded stderr tail (last 4KB) for fail-fast diagnostics. */
const MAX_STDERR_BYTES = 4096;
/** Health-poll fetch timeout — a hung socket must not stall readiness. */
const HEALTH_FETCH_TIMEOUT_MS = 2000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined> },
): SpawnedProc {
  // stdout/stderr are piped (ReadableStream<Uint8Array>); stdin is unused.
  // Cast: with "pipe" the streams are non-null, matching the SpawnedProc
  // contract the manager supervises.
  return spawn({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: opts.env,
  }) as SpawnedProc;
}

export class LlamaServeManager {
  private readonly config: LlamaConfig;
  private readonly modelsDir: string;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private child: SpawnedProc | null = null;
  private intentionallyStopped = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private port: number;
  private _status: BackendStatus;
  /** Bounded stderr tail (last 4KB) for fail-fast diagnostics. */
  private lastStderr = "";
  /** Resolves when the current child's stderr stream has been fully consumed. */
  private stderrComplete: Promise<void> = Promise.resolve();
  /** Unexpected-exit restart cycles since boot; capped by maxRestartAttempts. */
  private restartCount = 0;

  constructor(deps: ManagerDeps) {
    this.config = deps.config;
    this.modelsDir = path.resolve(deps.config.modelsDir);
    this.log = deps.logger ?? console.log;
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.port = deps.config.port;
    this._status = {
      state: "stopped",
      pid: null,
      models: Object.keys(deps.config.models),
      baseUrl: `http://${deps.config.host}:${this.port}`,
    };
  }

  /** Current backend status (call after start() for running state). */
  status(): BackendStatus {
    return { ...this._status };
  }

  /** Full startup sequence: validate → preset → spawn → wait-ready. */
  async start(): Promise<void> {
    this.intentionallyStopped = false;

    // 1. Fail-fast validation (binary, modelsDir, GGUF files)
    validateBackendConfig(this.config);

    if (!this.config.autoStart) {
      this.log("[manager] autoStart is false — skipping backend spawn");
      this._status = {
        state: "stopped",
        pid: null,
        models: Object.keys(this.config.models),
        baseUrl: "",
      };
      return;
    }

    // 2. Generate preset INI (Bun.file write)
    const presetPath = await writePresetIni(this.config, this.modelsDir);

    // 3. Spawn llama serve
    this._status = { ...this._status, state: "starting" };
    await this.spawnAndWaitReady(presetPath);

    this.log(
      `[manager] backend ready: pid=${this._status.pid}, baseUrl=${this._status.baseUrl}`,
    );
  }

  /** Graceful shutdown: SIGTERM → wait → SIGKILL. */
  async stop(): Promise<void> {
    this.intentionallyStopped = true;

    if (!this.child || !this.child.pid) {
      this._status = { ...this._status, state: "stopped", pid: null };
      return;
    }

    const child = this.child;
    const pid = child.pid;
    this.log(`[manager] stopping backend (pid=${pid})`);

    // SIGTERM
    child.kill("SIGTERM");

    // Wait for the exit (via the `exited` Promise — no onExit in Bun) or fall
    // back to SIGKILL after stopTimeoutMs. Race semantics match the previous
    // exit-event + timeout implementation.
    await new Promise<void>((resolve) => {
      let exited = false;
      const finish = () => {
        if (!exited) {
          exited = true;
          resolve();
        }
      };
      void child.exited.then(finish, finish);
      void this.sleep(this.config.stopTimeoutMs).then(() => {
        if (exited) return; // clean exit observed — SIGKILL unnecessary
        try {
          child.kill("SIGKILL");
          this.log(`[manager] SIGKILL sent to pid=${pid}`);
        } catch {
          // process already gone
        }
        finish();
      });
    });

    this.child = null;
    this._status = { ...this._status, state: "stopped", pid: null };
    this.log("[manager] backend stopped");
  }

  // ── Private ──

  private async spawnAndWaitReady(presetPath: string): Promise<void> {
    const args = this.buildSpawnArgs(presetPath);

    this.log(
      `[manager] spawning: ${this.config.binary} ${args.join(" ")}`,
    );

    try {
      this.child = this.spawnFn(this.config.binary, args, {
        env: {
          ...process.env,
          CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES ?? "0",
        },
      });
    } catch (err) {
      // Bun.spawn throws synchronously on posix_spawn failure (ENOENT).
      this.log(`[manager] spawn error: ${(err as Error).message}`);
      this._status = { ...this._status, state: "error" };
      throw err;
    }

    this._status = { ...this._status, pid: this.child.pid ?? null };

    // Pipe stdout/stderr to console (observability). Chunks are Uint8Array —
    // decode before any text matching.
    void this.consumeStdout(this.child, (text) => {
      process.stdout.write(text);
      this.detectPort(text);
    });
    this.stderrComplete = this.consumeStderr(this.child, (text) => {
      process.stderr.write(text);
      this.detectPort(text); // llama.cpp logs its banner to stderr
      this.captureStderr(text);
    });

    // Supervised restart on unexpected exit (`exited` replaces onExit).
    void this.supervise();

    await this.waitForReady();
  }

  private async consumeStdout(
    proc: SpawnedProc,
    onChunk: (text: string) => void,
  ): Promise<void> {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) onChunk(decoder.decode(value));
      }
    } catch {
      // Stream closed mid-read — nothing to supervise here.
    }
  }

  private async consumeStderr(
    proc: SpawnedProc,
    onChunk: (text: string) => void,
  ): Promise<void> {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) onChunk(decoder.decode(value));
      }
    } catch {
      // Stream closed mid-read — nothing to supervise here.
    }
  }

  /** Await `exited` and react to an unexpected process death. */
  private async supervise(): Promise<void> {
    const child = this.child;
    if (!child) return;

    let code: number;
    try {
      code = await child.exited;
    } catch (err) {
      this.log(`[manager] spawn error: ${(err as Error).message}`);
      this._status = { ...this._status, state: "error" };
      return;
    }

    if (this.intentionallyStopped) return;
    if (this._status.state === "starting") return; // startup death handled by waitForReady

    const signal = child.signalCode ?? "n/a";
    this.log(
      `[manager] backend exited unexpectedly (code=${code}, signal=${signal})`,
    );
    this._status = { ...this._status, state: "error" };

    // Drain pending stderr before building diagnostics.
    await this.flushStderr();

    // Fail-fast restart cap: after maxRestartAttempts unexpected exits, stop
    // retrying and surface a clear error instead of crash-looping forever.
    const maxAttempts = this.config.maxRestartAttempts;
    if (maxAttempts > 0 && this.restartCount >= maxAttempts) {
      this.log(
        `[manager] backend failed to stay up after ${this.restartCount} attempts — check port/config conflicts`,
      );
      this.log(
        `[manager] last stderr:\n${this.lastStderr.trim() || "(no stderr captured)"}`,
      );
      return;
    }

    this.restartCount++;
    this.scheduleRestart();
  }

  private buildSpawnArgs(presetPath: string): string[] {
    const r = this.config.router;
    const args = [
      "serve",
      "--host", this.config.host,
      "--port", String(this.port),
      "--models-dir", this.modelsDir,
      "--models-preset", presetPath,
      "--ctx-size", String(r.ctx),
      "--n-predict", String(r.n),
      "--n-gpu-layers", String(r.nGpuLayers),
      "--cache-type-k", r.cacheTypeK,
      "--cache-type-v", r.cacheTypeV,
      "-b", String(r.batch),
      "-ub", String(r.ubatch),
      "--parallel", String(r.parallel),
    ];

    if (r.flashAttn) {
      args.push("--flash-attn", "on");
    }

    if (r.tools) {
      args.push("--tools", r.tools);
    }

    if (!this.config.autoload) {
      args.push("--no-models-autoload");
    }

    return args;
  }

  private detectPort(chunk: string): void {
    if (this.port !== 0) return; // fixed port — no need to detect

    // llama.cpp reports the bound endpoint in several shapes depending on the
    // build: "listening on 127.0.0.1:8080" or "listening on http://127.0.0.1:39163"
    const match = chunk.match(/listening\s+on\s+.*:(\d+)/i);
    if (match) {
      this.port = parseInt(match[1], 10);
      this._status = {
        ...this._status,
        baseUrl: `http://${this.config.host}:${this.port}`,
      };
      this.log(`[manager] detected dynamic port: ${this.port}`);
    }
  }

  private async waitForReady(): Promise<void> {
    const deadline = this.now() + this.config.startupTimeoutMs;

    // Wait briefly for port detection from stdout
    if (this.port === 0) {
      await this.sleep(this.config.portParseTimeoutMs);
      if (this.port === 0) {
        throw new Error(
          `[backend] could not detect dynamic port from llama-server stdout within ${this.config.portParseTimeoutMs}ms\n` +
            `  Fix: set llama.port to a fixed value (e.g. 8080) or check llama-server output`,
        );
      }
    }

    const pollUrl = `http://${this.config.host}:${this.port}`;

    while (this.now() < deadline) {
      // Process died before readiness — fail fast (never wait for the deadline
      // while the child is already dead).
      if (this.childDead()) {
        await this.flushStderr();
        throw this.earlyExitError("before becoming ready");
      }

      let healthy = false;
      try {
        const res = await fetch(`${pollUrl}/health`, {
          signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
        });
        healthy = res.ok;
      } catch {
        // Not ready yet — continue polling
      }

      if (healthy) {
        // CRITICAL (port-collision guard): a 200 on the health poll may come
        // from a FOREIGN process squatting on our port while our own child
        // crash-loops on EADDRINUSE. Only declare ready when OUR child is
        // demonstrably alive at this instant — otherwise we false-ready and
        // the exit handler would restart a child that can never bind.
        if (this.childDead()) {
          await this.flushStderr();
          throw this.earlyExitError(
            "after health check succeeded (possible port conflict)",
          );
        }
        this._status = {
          ...this._status,
          state: "running",
          baseUrl: pollUrl,
        };
        this.backoffMs = BACKOFF_INITIAL_MS; // reset backoff on success
        return;
      }

      await this.sleep(this.config.healthPollIntervalMs);
    }

    // Timeout — kill the process
    this.child?.kill("SIGKILL");
    await this.flushStderr();
    throw new Error(
      `[backend] llama-server did not become ready within ${this.config.startupTimeoutMs}ms\n` +
        `  last stderr:\n${this.lastStderr.trim() || "(no stderr captured)"}\n` +
        `  Fix: increase llama.startupTimeoutMs, check CUDA, or verify model files exist`,
    );
  }

  /** True when the spawned child is no longer a live process. */
  private childDead(): boolean {
    // Bun sets exitCode (normal exit) or signalCode (signal exit) once the
    // process has actually died — both are live before `exited` resolves.
    return (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    );
  }

  /** Fail-fast error for a child that died before/while becoming ready. */
  private earlyExitError(where: string): Error {
    const code = this.child?.exitCode ?? "n/a";
    const signal = this.child?.signalCode ?? "n/a";
    const stderr = this.lastStderr.trim() || "(no stderr captured)";
    return new Error(
      `[backend] llama-server exited ${where} (code=${code}, signal=${signal})\n` +
        `  last stderr:\n${stderr}\n` +
        `  Fix: check for a port conflict (another process on port ${this.port}), the binary path, CUDA availability, and model files`,
    );
  }

  /** Bound the stderr tail so diagnostics never grow unbounded. */
  private captureStderr(text: string): void {
    this.lastStderr = (this.lastStderr + text).slice(-MAX_STDERR_BYTES);
  }

  /**
   * Drain pending stderr chunks before composing diagnostics. The child may be
   * dead while its stream reader still holds buffered output (streams close
   * asynchronously after exit, no onExit in Bun) — without this the
   * "last stderr" snippet would be missing exactly when it's most valuable.
   */
  private async flushStderr(): Promise<void> {
    await Promise.race([
      this.stderrComplete.catch(() => {}),
      this.sleep(50),
    ]);
  }

  private scheduleRestart(): void {
    this.log(`[manager] restarting in ${this.backoffMs}ms (backoff)`);

    void this.sleep(this.backoffMs).then(() => {
      if (this.intentionallyStopped) return;
      this.log("[manager] attempting restart...");
      this.start().catch((err) => {
        this.log(`[manager] restart failed: ${err.message}`);
      });
    });

    // Exponential backoff: 1s → 2s → 4s → 8s → … → cap backoffCapMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.config.backoffCapMs);
  }
}

/** Factory to keep construction uniform with future backends. */
export function createLlamaServeManager(deps: ManagerDeps): LlamaServeManager {
  return new LlamaServeManager(deps);
}