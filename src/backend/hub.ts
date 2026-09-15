/**
 * LocalBackendHub — single orchestrator for the managed llama-server
 * backends (backend-management spec).
 *
 * Facade over one `LlamaProcessManager` per active model
 * (`Map<string, ManagedModel>`): owns the lifecycle (spawn, supervise,
 * idle-stop, drain), exposes a readiness-gating `Provider` wrapper whose
 * `chat`/`chatStream` await the manager's health poll before forwarding
 * (lazy re-spawn after idle-stop, immediate 503 on error), and provides
 * `activate`/`deactivate`/`status`/`statusAll`/`embedder`/`stopAll` for
 * the /api/models REST surface.
 *
 * DI seams mirror ManagerDeps (spawnFn/now/sleep/healthCheck/exit) so the
 * whole orchestration is testable with fakes — no real llama-server needed.
 * The version-floor preflight distinguishes ENOENT (per-model error, boot
 * continues) from an old/unparseable build (global fail-fast via exit(1)).
 */
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  LlamaProcessManager,
  type SpawnFn,
  type SpawnedProc,
} from "./manager.js";
import { checkLlamaVersionFloor, type LlamaSpawnArgsInput } from "./spawn-args.js";
import { getModelConfig } from "../db/model-config.js";
import { makeLlamaServerProvider } from "../providers/llama-server.js";
import { makeLlamaEmbedder, type Embedder } from "../providers/embeddings.js";
import type { Provider } from "../providers/types.js";

/** Public hub state projection (the /api/models + /v1/models merge source). */
export interface ModelStatus {
  id: string;
  state: "active" | "disabled" | "error";
  pid?: number;
  port?: number;
  error?: string;
}

/** Error carrying an HTTP status; /api routes map it straight to a response. */
export class HubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Injected deps — mirrors ManagerDeps seams so fakes flow through to managers. */
export interface HubDeps {
  db: Database;
  /** llama-server binary path (config.llamaBin). */
  binary: string;
  /** Spawn primitive; flows into preflight --version AND every manager. */
  spawnFn?: SpawnFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Readiness probe; flows into every manager. */
  healthCheck?: (baseUrl: string) => Promise<boolean>;
  log?: (msg: string) => void;
  /** Idle-stop default 10 min (binding Decision 6). */
  idleTimeoutMs?: number;
  /** Idle watchdog poll cadence — flows into every manager (tests). */
  idlePollMs?: number;
  /** Deactivation drain poll interval (default 1000ms). */
  drainPollMs?: number;
  /** Deactivation drain safety timeout (default 30_000ms). */
  drainTimeoutMs?: number;
  /** Global fail-fast hook for the old-binary case; tests inject a thrower. */
  exit?: (code: number) => never;
  /** Provider per-request timeout (default 300_000, matches the provider default). */
  requestTimeoutMs?: number;
}

/** One owned model: manager + gating wrapper + raw backend + runtime counters. */
interface ManagedModel {
  manager: LlamaProcessManager;
  /** Readiness-gating wrapper handed to /v1 and the runner. */
  provider: Provider;
  /** Raw LlamaServerProvider (fetch + noteActivity) the wrapper forwards to. */
  backend: Provider;
  /** In-flight request count (noteActivity end-callback decrements). */
  inFlight: number;
  /** Serializes concurrent start()/re-spawn calls per model (single-writer). */
  startLatch: Promise<void> | null;
  /** Last failure message for status/503 reporting. */
  lastError: string | null;
}

/** Module-level constants. */
export const HUB_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // Decision 6
export const DRAIN_POLL_MS = 1000;
export const DRAIN_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const VERSION_FLOOR_BUILD = 9908; // b9908+ (informational)

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(cmd: string, args: string[]): SpawnedProc {
  // stdout/stderr piped; stdin unused. The cast narrows the structural
  // subset the manager supervises (same shape as manager.ts defaultSpawn).
  return Bun.spawn({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  }) as unknown as SpawnedProc;
}

async function defaultHealthCheck(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read stdout to end (preflight --version capture). */
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
    // stream teardown during stop — ignore
  }
  return chunks.join("");
}

/** Wait briefly for the spawned --version process to exit. */
async function settle(proc: SpawnedProc): Promise<void> {
  try {
    await Promise.race([proc.exited, defaultSleep(500)]);
  } catch {
    // ignore
  }
}

/** ENOENT and any other spawn failure are per-model, never global. */
function binaryUnavailableMessage(binary: string, err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT" || /ENOENT|no such file/i.test(e.message ?? "")) {
    return `llama-server binary not found at '${binary}'`;
  }
  return `llama-server binary unavailable at '${binary}': ${e.message ?? String(err)}`;
}

export class LocalBackendHub {
  private readonly db: Database;
  private readonly binary: string;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly healthCheck: (baseUrl: string) => Promise<boolean>;
  private readonly log: (msg: string) => void;
  private readonly idleTimeoutMs: number;
  private readonly idlePollMs: number | undefined;
  private readonly drainPollMs: number;
  private readonly drainTimeoutMs: number;
  private readonly exit: (code: number) => never;
  private readonly requestTimeoutMs: number;

  /** One manager per active model — the single-writer guarantee at hub level. */
  private readonly models = new Map<string, ManagedModel>();
  /** Per-model error messages for entries without a live manager (boot). */
  private readonly errors = new Map<string, string>();
  /** Set by preflight on binary-unavailable; suppresses all restore spawns. */
  private preflightError: string | null = null;
  /** settings.embedding_model row — read fresh per access (bootstrap seeds it before use). */
  private readonly embeddingModelId: () => string | null;
  /** Cached gated embedder; invalidated whenever a manager is re-created. */
  private embedderCache: Embedder | null = null;

  constructor(deps: HubDeps) {
    this.db = deps.db;
    this.binary = deps.binary;
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.healthCheck = deps.healthCheck ?? defaultHealthCheck;
    this.log = deps.log ?? (() => {});
    this.idleTimeoutMs = deps.idleTimeoutMs ?? HUB_IDLE_TIMEOUT_MS;
    this.idlePollMs = deps.idlePollMs;
    this.drainPollMs = deps.drainPollMs ?? DRAIN_POLL_MS;
    this.drainTimeoutMs = deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    this.exit = deps.exit ?? ((code: number): never => process.exit(code));
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.embeddingModelId = () => readEmbeddingModelId(this.db);
  }

  /**
   * Version-floor preflight: ENOENT (or any spawn failure) → per-model error
   * state, boot continues; parseable-but-old / unparseable → global fail-fast
   * via the injected exit hook (process.exit(1) in production).
   */
  async preflight(): Promise<void> {
    let proc: SpawnedProc;
    try {
      proc = this.spawnFn(this.binary, ["--version"]);
    } catch (err) {
      this.preflightError = binaryUnavailableMessage(this.binary, err);
      return;
    }
    const output = await collectAll(proc.stdout);
    await settle(proc);
    try {
      checkLlamaVersionFloor(output);
    } catch (err) {
      this.log(`fatal: ${errorMessage(err)}`);
      this.exit(1); // never returns in production
    }
  }

  /** Restore active=1 models from SQLite and spawn each (boot). */
  async restoreActive(): Promise<void> {
    const active = this.db
      .query("SELECT id, path FROM models WHERE active = 1")
      .all() as Array<{ id: string; path: string | null }>;
    if (this.preflightError !== null) {
      // Binary unavailable → every active row enters error state; no spawns.
      for (const m of active) this.errors.set(m.id, this.preflightError);
      return;
    }
    await Promise.allSettled(active.map((m) => this.spawnModel(m.id, m.path)));
  }

  /**
   * Activate a model: verify GGUF → create manager → start → persist
   * active=1 (last). Idempotent for an already-running model; a manager in
   * error state is recreated from scratch (retry path).
   */
  async activate(modelId: string): Promise<{ state: "active"; pid: number; port: number }> {
    const row = this.db
      .query("SELECT id, path FROM models WHERE id = ?")
      .get(modelId) as { id: string; path: string | null } | null;
    if (row === null) throw new HubError(404, `model not found: ${modelId}`);

    const existing = this.models.get(modelId);
    if (existing !== undefined && existing.manager.status().state === "running") {
      const s = existing.manager.status();
      return { state: "active", pid: s.pid ?? 0, port: s.port ?? 0 }; // idempotent
    }
    if (existing !== undefined && existing.manager.status().state === "error") {
      this.models.delete(modelId); // retry path: recreate from scratch
    }

    await this.spawnModel(modelId, row.path, { persist: true }); // HubError(503) on failure
    const s = this.models.get(modelId)!.manager.status();
    return { state: "active", pid: s.pid ?? 0, port: s.port ?? 0 };
  }

  /**
   * Deactivate a model: drain in-flight (1s poll, 30s safety timeout), stop
   * the manager, persist active=0. Unknown model → HubError(404); an
   * already-disabled model is an idempotent success.
   */
  async deactivate(modelId: string): Promise<{ state: "disabled" }> {
    const entry = this.models.get(modelId);
    if (entry === undefined) {
      const row = this.db
        .query("SELECT active FROM models WHERE id = ?")
        .get(modelId) as { active: number } | null;
      if (row === null) throw new HubError(404, `model not found: ${modelId}`);
      return { state: "disabled" }; // already disabled — idempotent
    }
    await this.drain(entry); // in-flight → 0, 30s safety timeout
    await entry.manager.stop();
    this.models.delete(modelId);
    this.db.query("UPDATE models SET active = 0 WHERE id = ?").run(modelId);
    return { state: "disabled" };
  }

  /** 3D state projection: active/disabled/error + live pid/port from the manager. */
  status(modelId: string): ModelStatus | null {
    const entry = this.models.get(modelId);
    if (entry !== undefined) return this.toStatus(modelId, entry);
    const row = this.db
      .query("SELECT active FROM models WHERE id = ?")
      .get(modelId) as { active: number } | null;
    if (row === null) return null; // → route 404
    if (row.active === 1) {
      return {
        id: modelId,
        state: "error",
        error: this.errors.get(modelId) ?? "model is active but not loaded",
      };
    }
    return { id: modelId, state: "disabled" };
  }

  /** Every registered model id with its 3D state (live read — no stale set). */
  statusAll(): ModelStatus[] {
    const ids = this.db.query("SELECT id FROM models").all() as Array<{ id: string }>;
    return ids.map((r) => this.status(r.id) ?? { id: r.id, state: "disabled" });
  }

  /**
   * Readiness-gating wrapper (Design §2.3 arity reconciliation):
   * - modelId omitted (the runtime reality — boot closures are called with
   *   zero args): a per-request-dispatching wrapper, never null; correctness
   *   is enforced downstream by `localModels()` membership.
   * - modelId given (direct callers, tests): the same gating wrapper, or
   *   null when that model has no non-error entry.
   */
  localProvider(modelId?: string): Provider | null {
    if (modelId === undefined) return this.perRequestProvider();
    const entry = this.models.get(modelId);
    if (entry === undefined || entry.manager.status().state === "error") return null;
    return entry.provider;
  }

  /** IDs served via /v1/models and /api/health: active entries (not error). */
  localModels(): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.models) {
      if (entry.manager.status().state !== "error") ids.push(id);
    }
    return ids;
  }

  /**
   * Dedicated embedder wrapper, or null (the /v1/embeddings 404 path).
   * Lifecycle tied to the designated model's ManagedModel: deactivate →
   * null; crash-restart → null until the manager is healthy again.
   */
  embedder(): Embedder | null {
    const designated = this.embeddingModelId();
    if (designated === null) return null;
    const entry = this.models.get(designated);
    if (entry === undefined || entry.manager.status().state === "error") return null;
    if (this.embedderCache === null) {
      const modelId = designated;
      const raw = makeLlamaEmbedder({
        baseUrl: () => entry.manager.status().baseUrl ?? "",
        model: modelId,
      });
      this.embedderCache = {
        model: modelId,
        embed: async (input) => {
          await this.ensureReady(modelId); // lazy re-spawn, 503 on error
          return raw.embed(input);
        },
      };
    }
    return this.embedderCache;
  }

  /** Graceful shutdown: drain + stop every manager, then clear the maps. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.models.entries()].map(async ([_id, entry]) => {
        await this.drain(entry);
        await entry.manager.stop();
      }),
    );
    this.models.clear();
    this.errors.clear();
    this.embedderCache = null;
  }

  // ── internals ────────────────────────────────────────────────────────

  private toStatus(modelId: string, entry: ManagedModel): ModelStatus {
    const s = entry.manager.status();
    if (s.state === "error") {
      return { id: modelId, state: "error", error: entry.lastError ?? "backend in error state" };
    }
    return {
      id: modelId,
      state: "active", // permission dimension; covers starting/stopped/running
      ...(s.pid !== null ? { pid: s.pid } : {}),
      ...(s.port !== null ? { port: s.port } : {}),
    };
  }

  /** Zero-arg seam wrapper: dispatches per request.model to the entry's gate. */
  private perRequestProvider(): Provider {
    const hub = this;
    return {
      name: "local",
      chat: async (request, chainName) => {
        const model = typeof request.model === "string" ? request.model : null;
        if (model === null) throw hub.unavailable(503, "local model not loaded: missing model field");
        const entry = hub.models.get(model);
        if (entry === undefined) throw hub.unavailable(503, `local model not loaded: ${model}`);
        return entry.provider.chat(request, chainName);
      },
      async *chatStream(request, signal) {
        const model = typeof request.model === "string" ? request.model : null;
        if (model === null) throw hub.unavailable(503, "local model not loaded: missing model field");
        const entry = hub.models.get(model);
        if (entry === undefined) throw hub.unavailable(503, `local model not loaded: ${model}`);
        yield* entry.provider.chatStream(request, signal);
      },
    };
  }

  /**
   * Readiness gate — the four-state decision per Design §4.3:
   * running → fast path; error → 503; starting/stopped → (re-)spawn through
   * the per-model startLatch (concurrent requests share ONE spawn).
   */
  private async ensureReady(modelId: string): Promise<void> {
    const entry = this.models.get(modelId);
    if (entry === undefined) throw this.unavailable(503, `local model not loaded: ${modelId}`);
    entry.manager.noteRequest(); // every request resets the idle timer
    const state = entry.manager.status().state;
    if (state === "running") return; // fast path
    if (state === "error") throw this.unavailable(503, entry.lastError ?? "backend in error state");
    if (entry.startLatch !== null) return entry.startLatch; // join the in-flight spawn
    const latch = entry.manager
      .start()
      .catch((err: unknown) => {
        entry.lastError = errorMessage(err);
        throw this.unavailable(503, entry.lastError);
      })
      .finally(() => {
        entry.startLatch = null;
      });
    entry.startLatch = latch;
    return latch;
  }

  private unavailable(status: number, message: string): Error & { status: number } {
    return Object.assign(new Error(message), { status });
  }

  /** Shared by activate()/restoreActive(): GGUF gate → args → manager → start. */
  private async spawnModel(
    modelId: string,
    ggufPath: string | null,
    opts?: { persist: boolean },
  ): Promise<void> {
    if (ggufPath === null || !existsSync(ggufPath)) {
      const message = `GGUF file not found: '${ggufPath ?? "(none)"}'`;
      if (opts?.persist) throw new HubError(400, message); // activate → 4xx naming the file
      this.errors.set(modelId, message); // restore → error state, boot continues
      return;
    }
    this.errors.delete(modelId);

    const run = this.buildSpawnArgs(modelId, ggufPath);
    const manager = new LlamaProcessManager({
      binary: this.binary,
      run,
      spawnFn: this.spawnFn,
      now: this.now,
      sleep: this.sleep,
      healthCheck: this.healthCheck,
      log: this.log,
      idleTimeoutMs: this.idleTimeoutMs,
      ...(this.idlePollMs !== undefined ? { idlePollMs: this.idlePollMs } : {}),
    });

    // Build the raw backend + gating wrapper BEFORE inserting the entry:
    // the noteActivity closure looks the entry up lazily at request time.
    const backend = makeLlamaServerProvider({
      getBaseUrl: () => manager.status().baseUrl ?? "",
      requestTimeoutMs: this.requestTimeoutMs,
      noteActivity: (requestModel: string) => {
        manager.noteRequest(); // idle reset (belt and braces; the gate also resets)
        const entry = this.models.get(requestModel);
        if (entry !== undefined) entry.inFlight += 1;
        return () => {
          const e = this.models.get(requestModel);
          if (e !== undefined && e.inFlight > 0) e.inFlight -= 1;
        };
      },
    });
    const wrapper = this.makeGatingProvider(modelId, backend);

    this.embedderCache = null; // a new manager invalidates the cached embedder
    const entry: ManagedModel = {
      manager,
      provider: wrapper,
      backend,
      inFlight: 0,
      startLatch: null,
      lastError: null,
    };
    this.models.set(modelId, entry);

    try {
      const latch = manager
        .start()
        .catch((err: unknown) => {
          entry.lastError = errorMessage(err);
          throw this.unavailable(503, entry.lastError);
        })
        .finally(() => {
          entry.startLatch = null;
        });
      entry.startLatch = latch; // concurrent requests join this spawn
      await latch;
      this.errors.delete(modelId);
      if (opts?.persist) this.db.query("UPDATE models SET active = 1 WHERE id = ?").run(modelId);
    } catch (err) {
      const e = this.models.get(modelId);
      if (e !== undefined) e.lastError = errorMessage(err);
      if (opts?.persist) throw new HubError(503, e?.lastError ?? "spawn failed");
      this.log(`restore failed for ${modelId}: ${e?.lastError}`);
    }
  }

  /** Resolve LlamaSpawnArgsInput from model_config + catalog cols + embedder. */
  private buildSpawnArgs(modelId: string, ggufPath: string): LlamaSpawnArgsInput {
    const cfg = getModelConfig(this.db, modelId); // model_config row (nullable)
    const modelRow = this.db
      .query("SELECT gguf_ctx, yarn_orig_ctx FROM models WHERE id = ?")
      .get(modelId) as { gguf_ctx: number | null; yarn_orig_ctx: number | null } | null;

    const ctxSize = cfg?.ctxSize ?? modelRow?.gguf_ctx ?? undefined;
    return {
      modelPath: ggufPath,
      ...(ctxSize !== undefined ? { ctxSize } : {}),
      ...(this.embeddingModelId() === modelId ? { embeddings: true } : {}),
      ...(cfg?.kvK !== undefined ? { cacheTypeK: cfg.kvK } : {}),
      ...(cfg?.kvV !== undefined ? { cacheTypeV: cfg.kvV } : {}),
      ...(cfg?.nCacheGpu !== undefined ? { nCacheGpu: cfg.nCacheGpu } : {}),
      ...(cfg?.cacheRam !== undefined ? { cacheRam: cfg.cacheRam } : {}),
      ...(cfg?.ngl !== undefined ? { ngl: cfg.ngl } : {}),
      ...(cfg?.flashAttn === true ? { flashAttn: true } : {}),
      ...(modelRow?.yarn_orig_ctx != null && ctxSize !== undefined
        ? { rope: { scale: ctxSize / modelRow.yarn_orig_ctx, origCtx: modelRow.yarn_orig_ctx } }
        : {}),
    };
  }

  /** Readiness-gating wrapper over one raw LlamaServerProvider (Design §4.3). */
  private makeGatingProvider(
    modelId: string,
    backend: Provider,
  ): Provider {
    const hub = this; // lexical capture keeps the async-generator `this` correct
    return {
      name: `local:${modelId}`,
      async chat(request, chainName) {
        const model = typeof request.model === "string" ? request.model : modelId;
        await hub.ensureReady(model);
        return backend.chat(request, chainName);
      },
      async *chatStream(request, signal) {
        const model = typeof request.model === "string" ? request.model : modelId;
        await hub.ensureReady(model);
        yield* backend.chatStream(request, signal);
      },
    };
  }

  /** Drain in-flight requests; the 30s safety timeout forces the stop anyway. */
  private async drain(entry: ManagedModel): Promise<void> {
    const deadline = this.now() + this.drainTimeoutMs;
    while (entry.inFlight > 0 && this.now() < deadline) {
      await this.sleep(this.drainPollMs);
    }
    // timeout → force stop regardless; in-flight requests fail with connection reset
  }
}

/** settings.embedding_model designation, read once at construction. */
function readEmbeddingModelId(db: Database): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
    | { value: string }
    | null;
  return row?.value ?? null;
}