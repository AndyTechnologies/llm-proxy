/**
 * Model lifecycle controller (F2 — idle TTL unload + VRAM pressure unload).
 *
 * The llama.cpp router spawns ONE isolated worker process per loaded model.
 * The lifecycle watches those workers via /proc (children of the router
 * process), tracks per-model activity (lastUsed / in-flight requests), and on
 * every tick:
 *   1. unloads workers idle for longer than `ttl` seconds (TTL pass), and
 *   2. when VRAM usage (nvidia-smi) exceeds the policy ceiling, unloads the
 *      least-recently-used models until `used <= limit` (VRAM/LRU pass).
 *
 * Unloading prefers the llama-server router's HTTP API (POST /models/unload
 * with `{"model": <id>}` — verified against llama.cpp server.cpp router mode)
 * so the router's model state map and SSE clients stay consistent. The
 * signal-kill fallback (SIGTERM → ~2s → SIGKILL, see
 * LlamaServeManager.unloadWorker) covers older binaries or an unreachable
 * router. The router respawns the model on the next request (autoload is the
 * default), so unloading is operator-safe.
 *
 * All decision logic is PURE (unit-testable); the controller injects the IO
 * seams (listWorkers, killWorker, sampleVram, sleep, now, logger).
 */
import { readFileSync } from "node:fs";
import type {
  LifecycleConfig,
  ModelConfig,
} from "../config/schema.js";

/** Tick cadence (design: "cada 5s de tick"). The timer is unref'd. */
export const DEFAULT_TICK_INTERVAL_MS = 5000;
/** nvidia-smi resampling throttle — avoid a spawn per tick (design: each N ticks). */
export const VRAM_SAMPLE_INTERVAL_MS = 10000;
/**
 * Grace for passthrough traffic that cannot be end-tracked: a model whose
 * last activity is newer than this is assumed possibly in-flight and skipped
 * by both passes. Provider-tracked requests use explicit begin/end counters.
 */
export const SKIP_RECENT_MS = 10000;
/**
 * Floor for the VRAM ceiling: a computed limit below this (e.g. freeGb bigger
 * than the GPU) unloads everything, which is never useful. Clamped + logged.
 */
export const MIN_VRAM_LIMIT_MIB = 512;
/** Bounded history of unload events exposed to the dashboard. */
const MAX_UNLOAD_LOG = 50;

/** A live worker process: the router's child running one model. */
export interface WorkerInfo {
  /** Dashboard-facing model id (config section id, or the GGUF basename). */
  modelId: string;
  pid: number;
  /** Model file size in MiB (0 when unreadable) — credit for the VRAM pass. */
  sizeMiB: number;
}

export type UnloadReason = "ttl" | "vram" | "manual" | "manual-all";

export interface UnloadLog {
  modelId: string;
  pid: number;
  reason: UnloadReason;
  at: string;
  ok: boolean;
}

export interface LifecycleStatus {
  /** Model ids currently observed as loaded (worker process alive). */
  loaded: string[];
  /** modelId → ISO timestamp of the last activity. */
  lastUsed: Record<string, string>;
  /** True while the VRAM policy is active (sample succeeds + config enabled). */
  vramPolicyActive: boolean;
  lastVramSample: { totalMiB: number; usedMiB: number; at: string } | null;
  recentUnloads: UnloadLog[];
}

/** IO seams injected by the wiring site (src/index.ts) / tests. */
export interface LifecycleDeps {
  /** Live config getter — the controller re-reads it on every tick, so config
   *  reloads (dashboard apply) take effect without a restart. */
  getConfig: () => LifecycleConfig;
  logger?: (level: string, message: string, extra?: Record<string, unknown>) => void;
  /** Scan the router's worker processes (via /proc). */
  listWorkers: () => WorkerInfo[];
  /** Kill a worker process; resolves true when the process died. */
  killWorker: (pid: number) => Promise<boolean>;
  /** Optional router-API unload (modelId + pid so the caller can verify the
   *  worker's death). Resolve true when unloaded; false → killWorker fallback. */
  unloadModelId?: (modelId: string, pid: number) => Promise<boolean>;
  /** nvidia-smi sample; `null` = GPU unusable → VRAM policy disabled. */
  sampleVram?: () => Promise<{ totalMiB: number; usedMiB: number } | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tickIntervalMs?: number;
  /** Throttle between VRAM samples (default VRAM_SAMPLE_INTERVAL_MS). */
  vramSampleIntervalMs?: number;
}

export interface ModelLifecycle {
  /** Record activity (request seen) for a model — unloads are pushed back. */
  noteActivity: (modelId: string) => void;
  /** Activity + in-flight counter (provider-tracked requests). */
  beginRequest: (modelId: string) => void;
  /** Release the in-flight counter and stamp activity again (end time). */
  endRequest: (modelId: string) => void;
  /** Run one lifecycle pass (TTL + VRAM/LRU) now. */
  tick: () => Promise<void>;
  /** Unload ONE model by dashboard id. False when no worker matches. */
  unload: (modelId: string, reason?: UnloadReason) => Promise<boolean>;
  /** Unload every observed worker. Returns how many were killed. */
  unloadAll: (reason?: UnloadReason) => Promise<number>;
  status: () => LifecycleStatus;
  /** Start the interval timer (unref'd — never blocks shutdown). */
  start: () => void;
  stop: () => void;
}

// ── Pure decision logic ──────────────────────────────────────────────────────

const NVIDIA_QUERY_RE = /^\s*(\d+)\s*MiB,\s*(\d+)\s*MiB\s*$/;

/**
 * Parse one line of `nvidia-smi --query-gpu=memory.total,memory.used
 * --format=csv,noheader` ("6144 MiB, 165 MiB"). Returns null when the shape
 * does not match (driver missing, query error…). First line only — in a
 * multi-GPU host the sample reflects GPU 0.
 */
export function parseVramLine(
  line: string,
): { totalMiB: number; usedMiB: number } | null {
  const m = NVIDIA_QUERY_RE.exec(line.trim());
  if (!m) return null;
  return { totalMiB: Number(m[1]), usedMiB: Number(m[2]) };
}

/**
 * VRAM ceiling for the policy configured by the user (design approved):
 *  - dynamic / margin: `VRAM total − freeGb` — keep `freeGb` of headroom.
 *  - cap: a FIXED ceiling (capGb), independent of the GPU.
 * Clamped to [MIN_VRAM_LIMIT_MIB, ∞) so absurd configs never wipe everything.
 */
export function vramLimitMiB(
  vram: Pick<LifecycleConfig["vram"], "mode" | "freeGb" | "capGb">,
  totalMiB: number,
): number {
  if (vram.mode === "cap") {
    return Math.max(Math.round(vram.capGb * 1024), MIN_VRAM_LIMIT_MIB);
  }
  const limit = totalMiB - Math.round(vram.freeGb * 1024);
  return Math.max(limit, MIN_VRAM_LIMIT_MIB);
}

const GGUF_RE = /\.gguf$/i;

/**
 * Map a worker's cmdline args to a dashboard-facing model id.
 * Resolution order (each independently testable):
 *   1. `--alias <x>` — the router's section alias IS the model id clients use.
 *   2. any arg ending in `.gguf` → basename; a registered config id when the
 *      file is declared in `llama.models`, else the basename verbatim (the
 *      id the detected-models payload uses).
 */
export function modelIdFromCmdline(
  args: string[],
  registeredByFile: ReadonlyMap<string, string>,
): { modelId: string; file: string } | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--alias" && args[i + 1].length > 0) {
      return { modelId: args[i + 1], file: "" };
    }
  }
  for (const arg of args) {
    if (!GGUF_RE.test(arg)) continue;
    const file = arg.slice(arg.lastIndexOf("/") + 1);
    return {
      modelId: registeredByFile.get(file.toLowerCase()) ?? file,
      file,
    };
  }
  return null;
}

/** Build the config-id index used by `modelIdFromCmdline` + `resolveModelId`. */
export function buildRegisteredIndex(models: Readonly<Record<string, ModelConfig>>): {
  byFile: Map<string, string>;
  ids: Set<string>;
} {
  const byFile = new Map<string, string>();
  const ids = new Set<string>();
  for (const [id, m] of Object.entries(models)) {
    ids.add(id);
    byFile.set(m.file.toLowerCase(), id);
  }
  return { byFile, ids };
}

/**
 * Resolve a raw `request.model` (client-supplied) to the lifecycle's model id:
 * exact config id → registered file basename (case-insensitive) → raw.
 */
export function resolveModelId(raw: string, index: {
  byFile: Map<string, string>;
  ids: Set<string>;
}): string {
  if (index.ids.has(raw)) return raw;
  const byFile = index.byFile.get(raw.toLowerCase());
  if (byFile) return byFile;
  return raw;
}

export interface TickInput {
  workers: WorkerInfo[];
  lastUsed: ReadonlyMap<string, number>;
  /** Provider-tracked in-flight models (never unloaded). */
  inFlight: ReadonlySet<string>;
  now: number;
  /** TTL in ms; <= 0 disables the TTL pass. */
  ttlMs: number;
  /** Skip models whose last activity is newer than this (untracked traffic). */
  skipRecentMs: number;
  /** VRAM snapshot; null disables the VRAM pass. */
  vram: { limitMiB: number; usedMiB: number } | null;
}

export interface UnloadAction {
  modelId: string;
  pid: number;
  reason: "ttl" | "vram";
}

/**
 * Decide which workers to unload on one tick (PURE).
 *  1. TTL pass: every non-busy worker idle longer than `ttlMs` (and past the
 *     recent-traffic grace) → unload.
 *  2. VRAM pass: while `usedMiB > limitMiB`, unload the LRU remaining workers
 *     (skip busy + grace + already chosen), crediting each model's file size.
 */
export function decideUnloads(input: TickInput): UnloadAction[] {
  const actions: UnloadAction[] = [];
  const chosen = new Set<string>();
  const recentCutoff = input.now - input.skipRecentMs;

  for (const w of input.workers) {
    if (input.inFlight.has(w.modelId)) continue;
    const last = input.lastUsed.get(w.modelId) ?? input.now;
    if (last > recentCutoff) continue; // possibly in-flight (passthrough)
    if (input.ttlMs > 0 && input.now - last > input.ttlMs) {
      actions.push({ modelId: w.modelId, pid: w.pid, reason: "ttl" });
      chosen.add(w.modelId);
    }
  }

  if (input.vram && input.vram.usedMiB > input.vram.limitMiB) {
    const candidates = input.workers
      .filter((w) => !input.inFlight.has(w.modelId) && !chosen.has(w.modelId))
      .map((w) => ({ w, last: input.lastUsed.get(w.modelId) ?? input.now }))
      .sort((a, b) => a.last - b.last)
      .filter((c) => c.last <= recentCutoff);
    let usedMiB = input.vram.usedMiB;
    for (const { w } of candidates) {
      if (usedMiB <= input.vram.limitMiB) break;
      actions.push({ modelId: w.modelId, pid: w.pid, reason: "vram" });
      chosen.add(w.modelId);
      usedMiB -= Math.max(w.sizeMiB, 0);
    }
  }

  return actions;
}

// ── /proc helpers (thin IO on top of the Linux procfs) ───────────────────────

/** Direct children of the router process (the llama.cpp model workers). */
export function readChildrenPids(routerPid: number): number[] {
  try {
    const text = readFileSync(
      `/proc/${routerPid}/task/${routerPid}/children`,
      "utf8",
    );
    const pids: number[] = [];
    for (const part of text.trim().split(/\s+/)) {
      const n = Number(part);
      if (Number.isInteger(n) && n > 1) pids.push(n);
    }
    return pids;
  } catch {
    return [];
  }
}

/** NUL-separated cmdline of a process; null when the process vanished. */
export function readProcCmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

// ── Controller ───────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the model lifecycle controller. All side effects go through the
 * injected deps; the controller owns only the state (lastUsed, inFlight,
 * loaded, VRAM sample, unload log) and the timer.
 */
export function createModelLifecycle(deps: LifecycleDeps): ModelLifecycle {
  const log = deps.logger ?? (() => {});
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const tickMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const vramSampleMs = deps.vramSampleIntervalMs ?? VRAM_SAMPLE_INTERVAL_MS;

  const lastUsed = new Map<string, number>();
  const inFlight = new Set<string>();
  let loaded = new Set<string>();
  let vramPolicyActive = false;
  let lastVram: { totalMiB: number; usedMiB: number; at: number } | null = null;
  let lastVramSampleAt = 0;
  const recentUnloads: UnloadLog[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickRunning = false;

  function noteActivity(modelId: string): void {
    lastUsed.set(modelId, now());
  }

  function beginRequest(modelId: string): void {
    noteActivity(modelId);
    inFlight.add(modelId);
  }

  function endRequest(modelId: string): void {
    inFlight.delete(modelId);
    noteActivity(modelId);
  }

  /** Re-scan workers; `loaded` follows reality; drop stale in-flight ids. */
  function reconcileWorkers(): WorkerInfo[] {
    const workers = deps.listWorkers();
    loaded = new Set(workers.map((w) => w.modelId));
    for (const id of inFlight) {
      if (!loaded.has(id)) inFlight.delete(id);
    }
    return workers;
  }

  async function doUnload(
    action: UnloadAction | { modelId: string; pid: number; reason: UnloadReason },
  ): Promise<boolean> {
    // Unload strategy: prefer the router's HTTP API (POST /models/unload) so
    // the router's model state + SSE clients stay consistent; the signal-kill
    // path covers older binaries / an unreachable router. API first, kill as
    // the fallback.
    let killed = false;
    if (deps.unloadModelId) {
      killed = await deps.unloadModelId(action.modelId, action.pid);
    }
    if (!killed) {
      killed = await deps.killWorker(action.pid);
    }
    recentUnloads.unshift({
      modelId: action.modelId,
      pid: action.pid,
      reason: action.reason,
      at: new Date(now()).toISOString(),
      ok: killed,
    });
    if (recentUnloads.length > MAX_UNLOAD_LOG) recentUnloads.length = MAX_UNLOAD_LOG;
    if (killed) {
      loaded.delete(action.modelId);
      log("info", `[lifecycle] model unloaded: ${action.modelId}`, {
        pid: action.pid,
        reason: action.reason,
        vramUsedMiB: lastVram?.usedMiB ?? null,
      });
    } else {
      log("warn", `[lifecycle] unload failed: ${action.modelId}`, {
        pid: action.pid,
        reason: action.reason,
      });
    }
    return killed;
  }

  async function tick(): Promise<void> {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const t = now();
      const cfg = deps.getConfig();
      const workers = reconcileWorkers();
      if (workers.length === 0) return; // backend down / nothing loaded

      // ── VRAM sample (throttled; stale sample reused in between) ──
      let vram: { limitMiB: number; usedMiB: number } | null = null;
      const wantSample =
        deps.sampleVram !== undefined &&
        (lastVramSampleAt === 0 || t - lastVramSampleAt >= vramSampleMs);
      if (wantSample) {
        lastVramSampleAt = t;
        const sample = await deps.sampleVram!();
        if (sample) {
          lastVram = { ...sample, at: t };
          if (!vramPolicyActive) {
            vramPolicyActive = true;
            log("info", "[lifecycle] VRAM policy active", {
              totalMiB: sample.totalMiB,
              limitMiB: vramLimitMiB(cfg.vram, sample.totalMiB),
            });
          }
          vram = {
            limitMiB: vramLimitMiB(cfg.vram, sample.totalMiB),
            usedMiB: sample.usedMiB,
          };
        } else if (vramPolicyActive) {
          vramPolicyActive = false;
          log(
            "warn",
            "[lifecycle] nvidia-smi unavailable — VRAM policy disabled (TTL still active)",
          );
        }
      } else if (lastVram) {
        vram = {
          limitMiB: vramLimitMiB(cfg.vram, lastVram.totalMiB),
          usedMiB: lastVram.usedMiB,
        };
      }

      // ── Decide + execute ──
      const actions = decideUnloads({
        workers,
        lastUsed,
        inFlight,
        now: t,
        ttlMs: cfg.ttl * 1000,
        skipRecentMs: SKIP_RECENT_MS,
        vram,
      });
      if (actions.length === 0) return;

      let vramUnloaded = false;
      for (const a of actions) {
        if (await doUnload(a)) vramUnloaded ||= a.reason === "vram";
      }

      // Post-batch re-sample: dashboard wants "antes/después" for VRAM.
      if (vramUnloaded && deps.sampleVram) {
        const after = await deps.sampleVram();
        if (after) {
          lastVram = { ...after, at: now() };
          log("info", "[lifecycle] vram after unload batch", {
            usedMiB: after.usedMiB,
            limitMiB: vram?.limitMiB ?? null,
          });
        }
      }
      await sleep(0);
    } finally {
      tickRunning = false;
    }
  }

  async function unload(
    modelId: string,
    reason: UnloadReason = "manual",
  ): Promise<boolean> {
    const w = deps.listWorkers().find((x) => x.modelId === modelId);
    if (!w) return false;
    return doUnload({ modelId, pid: w.pid, reason });
  }

  async function unloadAll(reason: UnloadReason = "manual-all"): Promise<number> {
    // Copy: killWorker may mutate the worker list (fake pools splice, the
    // real manager kills processes) — iterating the live array would skip
    // workers that shift into already-visited positions.
    let n = 0;
    for (const w of [...deps.listWorkers()]) {
      if (await doUnload({ modelId: w.modelId, pid: w.pid, reason })) n++;
    }
    return n;
  }

  function status(): LifecycleStatus {
    // Re-scan /proc — status() reflects reality even before the first tick
    // (the dashboard reads workers without waiting up to 5s for a tick).
    reconcileWorkers();
    const lastUsedOut: Record<string, string> = {};
    for (const [id, at] of lastUsed) {
      lastUsedOut[id] = new Date(at).toISOString();
    }
    return {
      loaded: [...loaded],
      lastUsed: lastUsedOut,
      vramPolicyActive,
      lastVramSample: lastVram
        ? {
            totalMiB: lastVram.totalMiB,
            usedMiB: lastVram.usedMiB,
            at: new Date(lastVram.at).toISOString(),
          }
        : null,
      recentUnloads,
    };
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, tickMs);
    // unref: the interval must never block graceful shutdown.
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    noteActivity,
    beginRequest,
    endRequest,
    tick,
    unload,
    unloadAll,
    status,
    start,
    stop,
  };
}