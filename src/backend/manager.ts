/**
 * LlamaProcessManager — single-model llama-server lifecycle (backend-management).
 *
 * Spawns ONE `llama-server` per active model with `--port 0`, detects the
 * bound port from stdout (`listening on ...:(\d+)`), gates readiness on a
 * health poll before state becomes `running`, supervises with exponential-
 * backoff restart on unexpected exit (bounded by maxRestartAttempts), and
 * stops gracefully after an idle timeout (SIGTERM semantics via `kill`).
 *
 * Fail-fast boot: if the port is never announced / never healthy within
 * startTimeoutMs, the child is killed and start() rejects with an actionable
 * message including the stderr tail. EADDRINUSE in stderr gets a dedicated
 * actionable error.
 *
 * The spawn primitive, clock, sleep, and health check are injected (DI) so
 * the whole lifecycle is testable with fakes — no real llama-server needed.
 * Preset/router mode is gone: per-model flags come from buildLlamaSpawnArgs
 * (SQLite model config), and the b9908+ floor is enforced via `--version`.
 */
import { buildLlamaSpawnArgs, checkLlamaVersionFloor, parseListeningPort, type LlamaSpawnArgsInput } from "./spawn-args.js";

/** Default idle timeout: a backend with no requests for 10 minutes stops. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Backoff window after an unexpected exit: 1s, then 2s, 4s, ... capped. */
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** How often the idle watchdog wakes. */
const IDLE_POLL_MS = 1000;
/** Bounded stderr tail (last 4KB) for fail-fast diagnostics. */
const MAX_STDERR_BYTES = 4096;

export type BackendState = "starting" | "running" | "stopped" | "error";

/** Operational status consumers read (routes, dashboard, /api). */
export interface BackendStatus {
  state: BackendState;
  pid: number | null;
  port: number | null;
  baseUrl: string | null;
}

/** Minimal process surface the manager supervises (subset of Bun's Subprocess). */
export interface SpawnedProc {
  pid: number | null;
  exitCode: number | null;
  signalCode: string | null;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}

/** Spawn primitive; real default is Bun.spawn, tests inject fakes. */
export type SpawnFn = (cmd: string, args: string[]) => SpawnedProc;

/** Injected deps + configuration for one managed backend. */
export interface ManagerDeps {
  /** llama-server binary path (defaults resolved by the wiring site). */
  binary: string;
  /** Resolved spawn config for the active model (model_config + GGUF YaRN). */
  run: LlamaSpawnArgsInput;
  spawnFn?: SpawnFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Readiness probe; defaults to real GET /health against the parsed port. */
  healthCheck?: (baseUrl: string) => Promise<boolean>;
  log?: (msg: string) => void;
  idleTimeoutMs?: number;
  idlePollMs?: number;
  startTimeoutMs?: number;
  healthPollMs?: number;
  maxRestartAttempts?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pure idle decision: true once `idleTimeoutMs` passes since lastRequestAt. */
export function idleElapsed(lastRequestAt: number, now: number, idleTimeoutMs: number): boolean {
  return now - lastRequestAt >= idleTimeoutMs;
}

function defaultSpawn(cmd: string, args: string[]): SpawnedProc {
  // stdout/stderr piped (ReadableStream<Uint8Array>); stdin unused. The cast
  // narrows the structural subset the manager supervises.
  return Bun.spawn({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  }) as unknown as SpawnedProc;
}

export class LlamaProcessManager {
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly healthCheck: (baseUrl: string) => Promise<boolean>;
  private readonly log: (msg: string) => void;
  private readonly idleTimeoutMs: number;
  private readonly idlePollMs: number;
  private readonly startTimeoutMs: number;
  private readonly healthPollMs: number;
  private readonly maxRestartAttempts: number;

  private proc: SpawnedProc | null = null;
  private state: BackendState = "stopped";
  private port: number | null = null;
  private _startedAt = 0;
  private lastRequestAt: number;
  private watching = false;
  private restartAttempts = 0;
  private stopRequested = false;

  constructor(private readonly deps: ManagerDeps) {
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.healthCheck = deps.healthCheck ?? defaultHealthCheck;
    this.log = deps.log ?? (() => {});
    this.idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.idlePollMs = deps.idlePollMs ?? IDLE_POLL_MS;
    this.startTimeoutMs = deps.startTimeoutMs ?? 30_000;
    this.healthPollMs = deps.healthPollMs ?? 300;
    this.maxRestartAttempts = deps.maxRestartAttempts ?? 5;
    this.lastRequestAt = this.now();
  }

  /** The last spawn attempt — separated so tests can inject a seeded proc. */
  spawnOnce(): SpawnedProc {
    const args = buildLlamaSpawnArgs(this.deps.run);
    return this.spawnFn(this.deps.binary, args);
  }

  /**
   * Boot the backend: spawn → parse port from stdout → health-poll until
   * ready or startTimeoutMs. Rejects (and kills the child) on failure with
   * an actionable message — the proxy never accepts traffic before this.
   */
  async start(): Promise<void> {
    this.state = "starting";
    this.stopRequested = false;
    this._startedAt = this.now();
    this.restartAttempts = 0;
    const proc = this.spawnOnce();
    this.proc = proc;

    const [port, stderrTail] = await this.waitForPortAndTail(proc);
    if (this.stopRequested) {
      this.state = "stopped";
      return;
    }
    if (port === null) {
      this.state = "error";
      await this.killProc(proc);
      const eaddr = /EADDRINUSE|address already in use/i.test(stderrTail);
      throw new Error(
        eaddr
          ? `backend failed to bind: port already in use (EADDRINUSE). Free the port or restart the app.`
          : `llama-server never announced a listening port within ${this.startTimeoutMs} ms. ` +
            `stderr tail: ${stderrTail || "(empty)"}`,
      );
    }
    this.port = port;

    const baseUrl = this.baseUrlFor(port);
    await this.waitHealthy(baseUrl, proc, stderrTail);

    this.state = "running";
    this.lastRequestAt = this.now();
    this.monitorExit(proc, baseUrl);
    this.watchIdle();
    this.log(`backend ready at ${baseUrl} (pid ${proc.pid ?? "?"})`);
  }

  /** Run `--version` and enforce the b9908+ floor; returns the build tag. */
  async checkVersion(): Promise<string> {
    const proc = this.spawnFn(this.deps.binary, ["--version"]);
    const [stdout, stderr] = await Promise.all([
      collectAll(proc.stdout),
      collectAll(proc.stderr),
    ]);
    await drain(proc);
    return checkLlamaVersionFloor(`${stdout}${stderr}`);
  }

  /** Touch the idle watchdog (call on every proxied request). */
  noteRequest(): void {
    this.lastRequestAt = this.now();
  }

  status(): BackendStatus {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      port: this.port,
      baseUrl: this.port === null ? null : this.baseUrlFor(this.port),
    };
  }

  /** Graceful stop: SIGTERM-style kill; terminal state. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.watching = false;
    const proc = this.proc;
    if (proc && this.state !== "stopped") {
      await this.killProc(proc);
    }
    this.proc = null;
    this.state = "stopped";
  }

  // ── internals ────────────────────────────────────────────────────────

  private baseUrlFor(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  /** Read stdout until the listening line appears (or timeout), tailing stderr. */
  private async waitForPortAndTail(proc: SpawnedProc): Promise<[number | null, string]> {
    const stderrTail: string[] = [];
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();

    // Read stderr concurrently, bounded to the last MAX_STDERR_BYTES.
    void this.tailStderr(stderrReader, stderrTail);

    try {
      for (;;) {
        const remaining = this.startTimeoutMs - (this.now() - this._startedAt);
        if (remaining <= 0) break; // deadline without a port line → fail fast
        const result = await Promise.race([
          stdoutReader.read().then((r) => ({ kind: "chunk" as const, ...r })),
          this.sleep(remaining).then(() => ({ kind: "timeout" as const })),
        ]);
        if (result.kind === "timeout") break;
        if (result.done) break;
        const line = new TextDecoder().decode(result.value);
        const port = parseListeningPort(line);
        if (port !== null) {
          await stdoutReader.cancel();
          return [port, stderrTail.join("")];
        }
      }
    } catch {
      // stream error → treat as no port
    }
    try {
      await stdoutReader.cancel();
    } catch {
      // already cancelled
    }
    return [null, stderrTail.join("")];
  }

  private async tailStderr(
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
    tail: string[],
  ): Promise<void> {
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          if (bytes > MAX_STDERR_BYTES * 4) {
            tail.length = 0; // keep the tail bounded
            bytes = 0;
          }
          tail.push(new TextDecoder().decode(value));
        }
      }
    } catch {
      // stream teardown during stop — ignore
    }
  }

  private async waitHealthy(baseUrl: string, proc: SpawnedProc, stderrTail: string): Promise<void> {
    const deadline = this.now() + this.startTimeoutMs;
    while (this.now() < deadline) {
      if (this.stopRequested) return;
      try {
        if (await this.healthCheck(baseUrl)) return;
      } catch {
        // transient — keep polling
      }
      await this.sleep(this.healthPollMs);
    }
    this.state = "error";
    await this.killProc(proc);
    throw new Error(
      `llama-server at ${baseUrl} never became healthy within ${this.startTimeoutMs} ms. ` +
        `stderr tail: ${stderrTail || "(empty)"}`,
    );
  }

  /** Supervise: unexpected exit → bounded exponential-backoff restart. */
  private monitorExit(proc: SpawnedProc, baseUrl: string): void {
    void proc.exited.then(async (code) => {
      if (this.stopRequested || this.proc !== proc || this.state === "stopped") return;
      this.log(`backend exited unexpectedly (code ${code}); restarting`);
      if (this.restartAttempts >= this.maxRestartAttempts) {
        this.state = "error";
        this.log(`restart budget exhausted (${this.maxRestartAttempts}); backend stays down`);
        return;
      }
      this.restartAttempts += 1;
      this.state = "starting";
      const backoff = Math.min(BACKOFF_INITIAL_MS * 2 ** (this.restartAttempts - 1), BACKOFF_MAX_MS);
      await this.sleep(backoff);
      if (this.stopRequested) return;
      try {
        await this.start();
        this.log(`backend restored at ${baseUrl}`);
      } catch (err) {
        this.log(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** Idle watchdog: stop the backend after `idleTimeoutMs` without requests. */
  private watchIdle(): void {
    if (this.watching) return;
    this.watching = true;
    const tick = async (): Promise<void> => {
      while (this.watching && !this.stopRequested) {
        await this.sleep(this.idlePollMs);
        if (this.stopRequested) break;
        if (this.state === "running" && idleElapsed(this.lastRequestAt, this.now(), this.idleTimeoutMs)) {
          this.log("idle timeout reached; stopping backend");
          await this.stop();
          break;
        }
      }
    };
    void tick();
  }

  private async killProc(proc: SpawnedProc): Promise<void> {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    await Promise.race([proc.exited, this.sleep(3000)]);
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }
}

async function collectAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
  } catch {
    // ignore
  }
  return chunks.join("");
}

async function drain(proc: SpawnedProc): Promise<void> {
  try {
    await Promise.race([proc.exited, defaultSleep(500)]);
  } catch {
    // ignore
  }
}

async function defaultHealthCheck(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}