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
  /**
   * Resolve the EFFECTIVE context (tokens) for a model id — the per-model
   * value written into the preset INI section. When absent, the raw config
   * `ctx` (or nothing) is used, preserving the legacy behavior.
   */
  modelContextFor?: (id: string) => number | undefined;
}

/** Initial restart backoff; growth and cap come from config (healthPoll/backoffCap). */
const BACKOFF_INITIAL_MS = 1000;
/** Bounded stderr tail (last 4KB) for fail-fast diagnostics. */
const MAX_STDERR_BYTES = 4096;
/** Health-poll fetch timeout — a hung socket must not stall readiness. */
const HEALTH_FETCH_TIMEOUT_MS = 2000;
/** Router-API unload fetch timeout (F2) — a hung router must not stall a tick. */
const UNLOAD_API_TIMEOUT_MS = 3000;
/** After a router-API unload (async on the router side) the child has up to
 *  `stop_timeout` (default 10s) to exit; we bound our own wait at 3s then
 *  SIGKILL so the lifecycle sees the worker gone within one tick. */
const WORKER_EXIT_GRACE_MS = 3000;
/** Liveness poll cadence while waiting for a worker process to exit. */
const WORKER_EXIT_POLL_MS = 300;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process liveness via signal 0 (no signal is delivered). Real PID only —
 * the worker processes are NOT children of this Bun process, so Bun's
 * Subprocess surface does not apply to them.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  private readonly modelContextFor?: (id: string) => number | undefined;
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
    this.modelContextFor = deps.modelContextFor;
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

  /**
   * Resolve the EFFECTIVE context (tokens) for a model id, when the entry
   * point provided the mapping. `undefined` means "no effective value known" —
   * callers fall back to the raw config ctx.
   */
  modelContext(id: string): number | undefined {
    return this.modelContextFor?.(id);
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

    // 2. Generate preset INI (Bun.file write). Per-model `ctx-size` sections
    //    are rendered from the effective context when a resolver is provided.
    const presetPath = await writePresetIni(
      this.config,
      this.modelsDir,
      this.modelContextFor,
    );

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

  /**
   * Unload a model worker process (F2 lifecycle): SIGTERM → wait ~2s → SIGKILL.
   *
   * The llama.cpp router runs each loaded model in its own isolated child;
   * the lifecycle controller kills that child to unload the model and the
   * router respawns it on the next request (autoload is the default).
   *
   * @returns true when the process is no longer alive after the attempt
   *   (including "already gone" — the goal state) — false only when a signal
   *   could not be delivered to a still-alive process.
   */
  async unloadWorker(pid: number): Promise<boolean> {
    if (!isProcessAlive(pid)) return true; // already gone — nothing to do

    try {
      process.kill(pid, "SIGTERM");
      this.log(`[manager] SIGTERM sent to worker pid=${pid}`);
    } catch (err) {
      this.log(`[manager] worker kill failed (pid=${pid}): ${(err as Error).message}`);
      return false;
    }

    if (await this.waitForWorkerExit(pid, 2000)) return true; // clean exit

    try {
      process.kill(pid, "SIGKILL");
      this.log(`[manager] SIGKILL sent to worker pid=${pid}`);
    } catch {
      // already gone — fine
    }
    return true;
  }

  /**
   * F2: unload a model worker preferring the llama-server router's HTTP API
   * (`POST /models/unload` with `{"model": <id>}` — verified against
   * llama.cpp server.cpp router mode) so the router's model state map and SSE
   * clients stay consistent. The router-side unload is async (the child exits
   * on the monitor thread, force-killed after `stop_timeout`, default 10s);
   * we bound our own wait, then SIGKILL a lingering child — the router marks
   * it UNLOADED on exit either way.
   *
   * Falls back to the signal path (unloadWorker) when the router is
   * unreachable, the endpoint is absent (older build), or the API errors.
   *
   * @returns true when the worker is no longer alive after the attempt
   *   (including "already gone") — false only when the kill fallback could
   *   not deliver a signal to a still-alive process.
   */
  async unloadModel(modelId: string, pid: number): Promise<boolean> {
    if (!isProcessAlive(pid)) return true; // goal state already reached
    const baseUrl = this._status.baseUrl;
    if (!baseUrl) return this.unloadWorker(pid);

    try {
      const res = await fetch(`${baseUrl}/models/unload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
        signal: AbortSignal.timeout(UNLOAD_API_TIMEOUT_MS),
      });
      if (!res.ok) return this.unloadWorker(pid); // e.g. "model is not found"

      this.log(`[manager] router API unload: model=${modelId}`);
      if (await this.waitForWorkerExit(pid, WORKER_EXIT_GRACE_MS)) return true;

      try {
        process.kill(pid, "SIGKILL");
        this.log(`[manager] SIGKILL after API unload timeout: model=${modelId}, pid=${pid}`);
      } catch {
        // already gone — fine
      }
      return true;
    } catch {
      // Router unreachable / endpoint absent (older build) → signal path.
      return this.unloadWorker(pid);
    }
  }

  // ── Private ──

  /** Poll the process liveness until it exits or the grace budget is spent. */
  private async waitForWorkerExit(pid: number, graceMs: number): Promise<boolean> {
    let waited = 0;
    while (waited < graceMs) {
      await this.sleep(WORKER_EXIT_POLL_MS);
      waited += WORKER_EXIT_POLL_MS;
      if (!isProcessAlive(pid)) return true;
    }
    return false;
  }

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
      // NO global `--ctx-size` here: in router mode llama.cpp overlays the
      // router's own CLI args on top of every model preset section, so a
      // global `--ctx-size` would override each section's `ctx-size` with one
      // value for all models (verified against server-models.cpp
      // `preset.merge(base_preset)` + common/preset.cpp merge-overwrite).
      // Per-model windows live in the preset sections rendered by preset.ts.
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