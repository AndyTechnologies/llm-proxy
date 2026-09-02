/**
 * LlamaServeManager — lifecycle manager for the managed llama-server process.
 *
 * Spawns `llama serve` in router mode, waits for readiness via health-check
 * polling, supervises with exponential-backoff restart on unexpected exit
 * (bounded by config.maxRestartAttempts, fail-fast when exceeded), and
 * performs graceful shutdown (SIGTERM → timeout → SIGKILL).
 *
 * The manager is the single source of truth for:
 *  - Whether the backend is running (status().state)
 *  - The dynamic port the backend is listening on (status().baseUrl)
 *  - Which models are registered (status().models)
 *
 * DESIGN DECISION: the manager validates config, creates the preset INI,
 * spawns the process, and polls readiness. This keeps the boot sequence
 * simple: one `await manager.start()` call before `app.listen()`.
 */
import { spawn, type ChildProcess } from "node:child_process";
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

/** Factory deps — injected by the entry point. */
export interface ManagerDeps {
  config: LlamaConfig;
  logger?: (msg: string) => void;
}

/** Initial restart backoff; growth and cap come from config (healthPoll/backoffCap). */
const BACKOFF_INITIAL_MS = 1000;

export class LlamaServeManager {
  private readonly config: LlamaConfig;
  private readonly modelsDir: string;
  private readonly log: (msg: string) => void;
  private child: ChildProcess | null = null;
  private intentionallyStopped = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private port: number;
  private _status: BackendStatus;
  /** Bounded stderr tail (last 4KB) for fail-fast diagnostics. */
  private lastStderr = "";
  /** Unexpected-exit restart cycles since boot; capped by maxRestartAttempts. */
  private restartCount = 0;

  constructor(deps: ManagerDeps) {
    this.config = deps.config;
    this.modelsDir = path.resolve(deps.config.modelsDir);
    this.log = deps.logger ?? console.log;
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

    // 2. Generate preset INI
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

    const pid = this.child.pid;
    this.log(`[manager] stopping backend (pid=${pid})`);

    // SIGTERM
    this.child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // SIGKILL fallback
        try {
          process.kill(pid, "SIGKILL");
          this.log(`[manager] SIGKILL sent to pid=${pid}`);
        } catch {
          // process already gone
        }
        resolve();
      }, this.config.stopTimeoutMs);

      this.child!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
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

    this.child = spawn(this.config.binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES ?? "0",
      },
    });

    this._status = { ...this._status, pid: this.child.pid ?? null };

    // Pipe stdout/stderr to console (observability)
    this.child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      this.detectPort(text);
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      this.captureStderr(chunk.toString());
    });

    // Supervised restart on unexpected exit
    this.child.on("exit", (code, signal) => {
      if (this.intentionallyStopped) return;
      if (this._status.state === "starting") return; // startup death handled by waitForReady
      this.log(
        `[manager] backend exited unexpectedly (code=${code}, signal=${signal})`,
      );
      this._status = { ...this._status, state: "error" };

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
    });

    this.child.on("error", (err) => {
      this.log(`[manager] spawn error: ${err.message}`);
      this._status = { ...this._status, state: "error" };
      if (this._status.state === "starting") {
        // Will be caught by the promise rejection below
      }
    });

    // Wait for readiness via health polling
    await this.waitForReady();
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

    // llama.cpp reports: "listening on 127.0.0.1:<port>"
    const match = chunk.match(/listening\s+on\s+\S+:(\d+)/i);
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
    const deadline = Date.now() + this.config.startupTimeoutMs;

    // Wait briefly for port detection from stdout
    if (this.port === 0) {
      await new Promise((r) => setTimeout(r, this.config.portParseTimeoutMs));
      if (this.port === 0) {
        throw new Error(
          `[backend] could not detect dynamic port from llama-server stdout within ${this.config.portParseTimeoutMs}ms\n` +
            `  Fix: set llama.port to a fixed value (e.g. 8080) or check llama-server output`,
        );
      }
    }

    const pollUrl = `http://${this.config.host}:${this.port}`;

    while (Date.now() < deadline) {
      // Process died before readiness — fail fast (never wait for the deadline
      // while the child is already dead).
      if (this.childDead()) {
        throw this.earlyExitError("before becoming ready");
      }

      let healthy = false;
      try {
        const res = await fetch(`${pollUrl}/health`, {
          signal: AbortSignal.timeout(2000),
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

      await new Promise((r) => setTimeout(r, this.config.healthPollIntervalMs));
    }

    // Timeout — kill the process
    this.child?.kill("SIGKILL");
    throw new Error(
      `[backend] llama-server did not become ready within ${this.config.startupTimeoutMs}ms\n` +
        `  last stderr:\n${this.lastStderr.trim() || "(no stderr captured)"}\n` +
        `  Fix: increase llama.startupTimeoutMs, check CUDA, or verify model files exist`,
    );
  }

  /** True when the spawned child is no longer a live process. */
  private childDead(): boolean {
    return !this.child || this.child.exitCode !== null || this.child.killed;
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
    const MAX_STDERR_BYTES = 4096;
    this.lastStderr = (this.lastStderr + text).slice(-MAX_STDERR_BYTES);
  }

  private scheduleRestart(): void {
    this.log(`[manager] restarting in ${this.backoffMs}ms (backoff)`);

    setTimeout(() => {
      if (this.intentionallyStopped) return;
      this.log("[manager] attempting restart...");
      this.start().catch((err) => {
        this.log(`[manager] restart failed: ${err.message}`);
      });
    }, this.backoffMs);

    // Exponential backoff: 1s → 2s → 4s → 8s → … → cap backoffCapMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.config.backoffCapMs);
  }
}

/** Factory to keep construction uniform with future backends. */
export function createLlamaServeManager(deps: ManagerDeps): LlamaServeManager {
  return new LlamaServeManager(deps);
}
