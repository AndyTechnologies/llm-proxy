# Design: wire-local-backend

Status: draft (design phase). Consumes product-rfc.md, arch-rfc.md, spec.md, the binding arch-plan.md acta (12 decisions), proposal.md, and explore.md.

---

## 1. Overview

This change wires the already-implemented `LlamaProcessManager` lifecycle into the runtime boot path so local models become callable via `/v1/*` and the workflow engine. A single new module — `LocalBackendHub` (`src/backend/hub.ts`) — owns one `LlamaProcessManager` per active model in a `Map<string, LlamaProcessManager>`, exposes a readiness-gating `Provider` wrapper whose `chat`/`chatStream` await the manager's health poll before forwarding (lazy re-spawn after idle-stop, immediate 503 on error), and provides `activate`/`deactivate`/`status`/`statusAll`/`embedder`/`stopAll` for the new `/api/models` REST surface. Active state persists as an `active INTEGER NOT NULL DEFAULT 0` column on the existing `models` table (idempotent ALTER migration), an optional dedicated embedding model is designated via the existing `settings` table (`embedding_model` key) and spawned with `--embeddings`, and the binary path comes from a new `WEAVELLM_LLAMA_BIN` env var (default `llama`). Zero changes to `runner.ts`, `v1.ts`, `registry.ts`, `types.ts`, `embeddings.ts`, `model-config.ts`, or `fallback.ts` (explore.md blast radius); the existing DI seams in `makeRuntimeServices`, `makeV1Handler`, and `makeApiHandler` receive non-null closures at boot.

---

## 2. Architecture

### 2.1 Pattern decisions (design-patterns skill record)

| Pattern | Forces present | Lightweight alternative (rejected) | Cost added | Anti-pattern avoided |
|---|---|---|---|---|
| **Facade** — `LocalBackendHub` over per-model `LlamaProcessManager` instances | Simplify a complex subsystem's surface: lifecycle orchestration + provider wrapping + status aggregation behind one injected object; single-writer guarantee across API handlers and boot | Direct `Map` manipulation in `main.ts` boot — leaks lifecycle decisions into boot, untestable, violates the "single writer per model" invariant | One class + one `HubDeps` injection surface; facade is kept thin (it orchestrates, never re-implements spawn/health logic) | **God Object** (facade delegates all process logic to managers) and **Shared Database** (no model state shared between managers) |
| **Protection Proxy** — gating provider wrapper over the raw `LlamaServerProvider` | Access control / lazy to an object: readiness gate + transparent re-spawn must happen on every local request, from two call sites (v1 resolver, workflow runner) | Inline the gate into `v1.ts` routes — duplicated across the two call sites, and the runner's `localProvider()` path would bypass it | One `Provider`-shaped wrapper type; adds ~30 lines | **Chatty Communication** (explicitly rejected a `/ready` endpoint + client polling; the wrapper absorbs it) |
| **Factory Method** — `#createManager(modelId, args)` reused by `activate()` and `restoreActive()` | Create a manager whose construction (deps threading, spawn-args resolution) must stay in one place | Duplicated manager construction in two flows — drift risk | One private method | Already present `buildLlamaSpawnArgs` stays the single args factory |

Observer was intentionally **not** used: the manager's internal `monitorExit`/stdout watchers stay inside the manager; the hub never subscribes to process events, preserving the single-writer invariant.

### 2.2 Position in the existing seams

```
                        ┌────────────────────────── main.ts (boot) ──────────────────────────┐
                        │  db → config → secretStore → registry                               │
                        │  hub = new LocalBackendHub(db, config.llamaBin, {...deps})          │
                        │  hub.preflight()          // --version floor; ENOENT → per-model    │
                        │  await hub.restoreActive() // active=1 rows → spawn each            │
                        │                                                                     │
                        │  makeRuntimeServices({ … localProvider: (id?) => hub.localProvider(id?),│
                        │                        localModels: () => hub.localModels(),        │
                        │                        embedder: () => hub.embedder(), … })         │
                        │  makeV1Handler({ … same closures, embeddings: () => hub.embedder() })│
                        │  makeApiHandler({ …, hub, auth: makeAuthGate(…) })                  │
                        │  createWebServer({ …, localModels: () => hub.localModels() })       │
                        └────────────────────────────────────────────────────────────────────┘
        ┌───────────────────────────┐   ┌─────────────────────────────────────────────┐
        │  LocalBackendHub          │   │  request flow when model is local            │
        │  (src/backend/hub.ts)     │   │                                             │
        │                           │   │  /v1/chat/completions (v1.ts resolveModel)   │
        │  Map<string,             │   │   └─ localModels().includes(model) ──┐        │
        │    ManagedModel>          │   │                                      ▼        │
        │  ┌─────────────────────┐  │   │  hub.localProvider() → gating wrapper        │
        │  │ manager: LlamaProcess│  │   │   .chat(request)                            │
        │  │   Manager            │  │   │    ├─ manager.noteRequest()                 │
        │  │ provider: Provider   │  │   │    ├─ ensureReady(model):                   │
        │  │   (readiness gate)   │  │   │    │   running → forward (fast path)        │
        │  │ backend: LlamaServer │  │   │    │   starting → join startLatch (≤30s)    │
        │  │   Provider           │  │   │    │   stopped → start() via latch (re-spawn)│
        │  │ inFlight: number     │  │   │    │   error   → throw { status: 503 }      │
        │  │ startLatch: Promise  │  │   │    └─ backend.chat(request)                 │
        │  │ lastError: string|null│  │   │        (noteActivity: inFlight++ / --)     │
        │  └─────────────────────┘  │   │                                             │
        │  errors: Map<string,string>│  │  /api/models routes (api.ts, behind auth)    │
        │  embeddingModelId: string|null││   GET  /api/models        → statusAll()     │
        │  preflightError: string|null │  │   GET  /:id/status        → status()|404   │
        └───────────────────────────┘   │   POST /:id/activate        → 200|4xx|503    │
                                        │   POST /:id/deactivate      → 200|404        │
                                        └─────────────────────────────────────────────┘
```

### 2.3 Closure-arity reconciliation (binding Decision 2 × existing seams)

Binding Decision 2 wires `localProvider: (id) => hub.localProvider(id)`; Decision 5 specifies `hub.localProvider(modelId)`. The existing seams — `RuntimeDeps.localProvider` (`runner.ts:30`) and `V1HandlerDeps.localProvider` (`v1.ts:31`) — are typed `() => Provider | null` and are **called with zero arguments** (`runner.ts:59`, `v1.ts:107`); both call sites confirm the model via `localModels().includes(model)` and then pass it inside the request payload (`local.chat({ model, messages })` / `local.chat({ ...body })`).

The design resolves this without touching the seams:

- The gating logic is **per-request**: the wrapper's `chat`/`chatStream` read `request.model` and gate on that model's manager. Both call sites already guarantee `request.model` ∈ `localModels()` before invoking the wrapper.
- `hub.localProvider(modelId: string | undefined = undefined): Provider | null`:
  - `modelId` **omitted** (the runtime reality — the boot closure receives `undefined`): returns the per-request-dispatching wrapper (never `null`; correctness is enforced downstream by `localModels()` membership).
  - `modelId` **given** (direct callers, tests): returns the same wrapper, or `null` when that model has no non-error entry — so decision-shaped callers get an honest "cannot serve this model".
- TypeScript accepts the wiring: `(id?: string) => Provider | null` is assignable to `() => Provider | null`; the runtime `undefined` case is the documented default-value path above.

This is the only seam-level ambiguity introduced by the binding decisions, and it is resolved here so the apply phase does not re-derive it.

---

## 3. Data model

### 3.1 `models.active` column (binding Decision 9)

```sql
-- MODELS_TABLE CREATE statement (fresh DBs) gains:
active INTEGER NOT NULL DEFAULT 0
```

`applySchema` (`src/db/schema.ts:116`), after the existing `CREATE TABLE IF NOT EXISTS` executions, runs the idempotent migration:

```typescript
const cols = db
  .query("PRAGMA table_info(models)")
  .all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === "active")) {
  db.exec("ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0");
}
```

- Fresh DB: column present in CREATE. Existing DB: ALTER adds it; existing rows get `active = 0` (the DEFAULT).
- Idempotent: the PRAGMA check makes a second run a no-op.
- **The `active` boolean is the ONLY persisted runtime dimension** (arch-rfc State Persistence): pid/port are never stored; they are reconstructed from the live process via `manager.status()`.

### 3.2 `settings.embedding_model` row (binding Decision 8)

No schema change; the `settings` table already exists (`schema.ts:109`). A row `{ key: 'embedding_model', value: '<modelId>' }` designates the dedicated embedder. The hub reads it once at construction:

```typescript
const row = db.query("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
  | { value: string }
  | null;
this.embeddingModelId = row?.value ?? null;
```

The model designated by the row is spawned with `--embeddings` (Section 4.5). When unset, or when the designated model is missing/error/deactivated, `hub.embedder()` returns `null` and `/v1/embeddings` keeps its existing 404 behavior (`v1.ts:278-294`).

### 3.3 Write paths

| Operation | SQL |
|---|---|
| `activate(id)` persists | `UPDATE models SET active = 1 WHERE id = ?` |
| `deactivate(id)` persists | `UPDATE models SET active = 0 WHERE id = ?` |
| `restoreActive()` reads | `SELECT id, path FROM models WHERE active = 1` |
| `status(modelId)` fallback read | `SELECT active FROM models WHERE id = ?` |
| `statusAll()` registered set | `SELECT id FROM models` (live read — no stale known-set) |

Other persisted inputs (read-only): `model_config` via `getModelConfig(db, id)` (`src/db/model-config.ts:62`), `models.path` (GGUF location), `models.gguf_ctx` / `models.yarn_orig_ctx` (YaRN rope derivation, Section 4.4).

---

## 4. Module design — `LocalBackendHub`

### 4.1 Public surface (new file `src/backend/hub.ts`)

```typescript
import type { Database } from "bun:sqlite";
import {
  LlamaProcessManager,
  type ManagerDeps,
  type SpawnFn,
  type SpawnedProc,
} from "./manager.js";
import type { Provider } from "../providers/types.js";
import type { Embedder } from "../providers/embeddings.js";

/** Public hub state projection (the route payloads /v1/models merge source). */
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
  /** Serializes concurrent start()/re-spawn calls per model. */
  startLatch: Promise<void> | null;
  /** Last failure message for status/503 reporting. */
  lastError: string | null;
}

export class LocalBackendHub {
  constructor(deps: HubDeps) { /* ... */ }

  /** Version-floor preflight: ENOENT → per-model error, old → exit(1). */
  async preflight(): Promise<void>;
  /** Restore active=1 models from SQLite and spawn each (boot). */
  async restoreActive(): Promise<void>;

  activate(modelId: string): Promise<{ state: "active"; pid: number; port: number }>;
  deactivate(modelId: string): Promise<{ state: "disabled" }>;
  status(modelId: string): ModelStatus | null;
  statusAll(): ModelStatus[];

  /** Readiness-gating wrapper; see 2.3 for the arity semantics. */
  localProvider(modelId?: string): Provider | null;
  /** IDs served via /v1/models and /api/health: active, non-error entries. */
  localModels(): string[];
  /** Dedicated embedder wrapper, or null (404 path preserved). */
  embedder(): Embedder | null;

  /** Graceful shutdown: drain + stop every manager. */
  stopAll(): Promise<void>;
}

/** Module-level constants. */
export const HUB_IDLE_TIMEOUT_MS = 10 * 60 * 1000;               // Decision 6
export const DRAIN_POLL_MS = 1000;
export const DRAIN_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const VERSION_FLOOR_BUILD = 9908;                          // b9908+ (informational)
```

### 4.2 Responsibilities per method

**`preflight()`** (binding Decision 3):

```typescript
async preflight(): Promise<void> {
  let proc: SpawnedProc;
  try {
    proc = this.spawnFn(this.binary, ["--version"]);
  } catch (err) {
    this.preflightError = binaryUnavailableMessage(this.binary, err);
    return; // ENOENT (or any spawn failure) → per-model error; boot continues
  }
  const output = await collectOutput(proc);
  await settleProc(proc);
  try {
    checkLlamaVersionFloor(output); // throws on old OR unparseable
  } catch (err) {
    this.log(`fatal: ${msg(err)}`);
    this.exit(1); // global fail-fast — never returns in production
  }
}

function binaryUnavailableMessage(binary: string, err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT" || /ENOENT|no such file/i.test(e.message ?? "")) {
    return `llama-server binary not found at '${binary}'`;
  }
  return `llama-server binary unavailable at '${binary}': ${e.message ?? String(err)}`;
}
```

- Three outcomes exactly per Decision 3: **ENOENT → `preflightError` set, boot continues**; **parseable-but-old (or unparseable) → `this.exit(1)`** with the actionable message from `checkLlamaVersionFloor`; **current → proceed**.
- `exit` is injected (`this.exit = deps.exit ?? ((code: number): never => process.exit(code))`) so tests capture the fail-fast instead of killing the runner.
- `collectOutput`/`settleProc` mirror manager.ts's existing `collectAll`/`drain` behavior (read stdout to end; wait ≤500ms for exit).

**`restoreActive()`** (binding Decision 2, arch-rfc Boot Wiring Order):

```typescript
async restoreActive(): Promise<void> {
  const active = this.db
    .query("SELECT id, path FROM models WHERE active = 1")
    .all() as Array<{ id: string; path: string | null }>;
  await Promise.allSettled(active.map((m) => this.spawnModel(m.id, m.path)));
}
```

- `spawnModel` (Section 4.6) is shared with `activate()`. Per-model failures (missing GGUF, spawn error) never propagate — `allSettled` + internal try/catch keep boot green.
- When `this.preflightError !== null`: skip all spawns, record `errors.set(id, preflightError)` for every active row, return (Decision 3 consequences).
- Spawns run in parallel (managers share no state — arch-rfc invariant); each failure is logged, not fatal.

**`activate(modelId)`** (binding Decision 4):

```typescript
async activate(modelId: string): Promise<{ state: "active"; pid: number; port: number }> {
  const row = this.db
    .query("SELECT id, path FROM models WHERE id = ?")
    .get(modelId) as { id: string; path: string | null } | null;
  if (row === null) throw new HubError(404, `model not found: ${modelId}`);

  const existing = this.models.get(modelId);
  if (existing !== undefined && existing.manager.status().state === "running") {
    const s = existing.manager.status();
    return { state: "active", pid: s.pid ?? 0, port: s.port ?? 0 }; // idempotent (no re-spawn)
  }
  if (existing !== undefined && existing.manager.status().state === "error") {
    this.models.delete(modelId); // retry path: recreate from scratch
  }

  await this.spawnModel(modelId, row.path, { persist: true }); // throws HubError(503) on failure
  const s = this.models.get(modelId)!.manager.status();
  return { state: "active", pid: s.pid ?? 0, port: s.port ?? 0 };
}
```

Order of persistence: **spawn succeeds → `UPDATE models SET active = 1`** (persist last, per Decision 4 step 7). "Activate an already-active model" returns the current `{state, pid, port}` without re-spawning (idempotent, spec scenario).

**`deactivate(modelId)`** (binding Decision 7):

```typescript
async deactivate(modelId: string): Promise<{ state: "disabled" }> {
  const entry = this.models.get(modelId);
  if (entry === undefined) {
    const row = this.db.query("SELECT active FROM models WHERE id = ?").get(modelId);
    if (row === null) throw new HubError(404, `model not found: ${modelId}`);
    return { state: "disabled" }; // already disabled — idempotent
  }
  await this.drain(entry);                 // in-flight → 0, 30s safety timeout
  await entry.manager.stop();
  this.models.delete(modelId);
  this.db.query("UPDATE models SET active = 0 WHERE id = ?").run(modelId);
  return { state: "disabled" };
}

private async drain(entry: ManagedModel): Promise<void> {
  const deadline = this.now() + this.drainTimeoutMs;
  while (entry.inFlight > 0 && this.now() < deadline) {
    await this.sleep(this.drainPollMs);
  }
  // timeout → force stop regardless; in-flight requests fail with connection reset (spec-sanctioned)
}
```

- `inFlight` is fed by the backend's `noteActivity` hook (Section 4.3).
- **`stopAll()`** applies the same `drain()` per entry, then `manager.stop()`, then clears the maps — the graceful-shutdown path (spec: drain ≤30s/model, no orphan persists).

**`status(modelId)` / `statusAll()`:**

```typescript
status(modelId: string): ModelStatus | null {
  const entry = this.models.get(modelId);
  if (entry !== undefined) return this.toStatus(modelId, entry);
  const row = this.db.query("SELECT active FROM models WHERE id = ?").get(modelId) as
    | { active: number }
    | null;
  if (row === null) return null;                       // → route 404
  if (row.active === 1) {
    return { id: modelId, state: "error", error: this.errors.get(modelId) ?? "model is active but not loaded" };
  }
  return { id: modelId, state: "disabled" };
}

statusAll(): ModelStatus[] {
  const ids = this.db.query("SELECT id FROM models").all() as Array<{ id: string }>;
  return ids.map((r) => this.status(r.id) ?? { id: r.id, state: "disabled" });
}

private toStatus(modelId: string, entry: ManagedModel): ModelStatus {
  const s = entry.manager.status();
  if (s.state === "error") return { id: modelId, state: "error", error: entry.lastError ?? "backend in error state" };
  return {
    id: modelId,
    state: "active",                                  // permission dimension; covers starting/stopped/loaded
    ...(s.pid !== null ? { pid: s.pid } : {}),
    ...(s.port !== null ? { port: s.port } : {}),
  };
}
```

The 3D projection: `active` = loaded (`running`) + loading (`starting`) + unloaded-but-permitted (`stopped`, idle); `error` = manager error OR active-without-entry (missing GGUF, ENOENT); `disabled` = registered, `active=0`, no entry. Runtime pid/port always derived from the live process, never from SQLite (arch-rfc invariant).

**`localModels()`:** entries whose manager state is not `"error"` — the `/v1/models` merge source and `/api/health.localModels` source. Intentionally includes `stopped` entries so idle-stopped models stay advertised and lazily re-spawn (`localModels()` excludes `error`).

### 4.3 Readiness-gating wrapper (binding Decision 5)

```typescript
getOrBuildProvider(modelId: string, manager: LlamaProcessManager): Provider {
  const backend = makeLlamaServerProvider({
    getBaseUrl: () => manager.status().baseUrl ?? "",
    requestTimeoutMs: this.requestTimeoutMs,
    noteActivity: () => {
      manager.noteRequest();                 // idle reset (belt and braces; gate also resets)
      const entry = this.models.get(modelId);
      if (entry !== undefined) entry.inFlight += 1;
      return () => {
        const e = this.models.get(modelId);
        if (e !== undefined && e.inFlight > 0) e.inFlight -= 1;
      };
    },
  });
  return {
    name: `local:${modelId}`,
    chat: async (request, chainName) => {
      const model = typeof request.model === "string" ? request.model : modelId;
      await this.ensureReady(model);
      return backend.chat(request, chainName);
    },
    chatStream: async function* (request, signal) {
      const model = typeof request.model === "string" ? request.model : modelId;
      await this.ensureReady(model);
      yield* backend.chatStream(request, signal);
    },
  };
}
```

(`getOrBuildProvider` is wrapped so each `ManagedModel` holds one instance; arrow-function `this` capture must be preserved for `chatStream` — implement with a self-binding arrow or lexical `hub` const.)

**`ensureReady(modelId)` — the gate:**

```typescript
private async ensureReady(modelId: string): Promise<void> {
  const entry = this.models.get(modelId);
  if (entry === undefined) throw this.unavailable(503, `local model not loaded: ${modelId}`);
  entry.manager.noteRequest();                       // every request resets the idle timer (spec invariant)
  const state = entry.manager.status().state;
  if (state === "running") return;                   // fast path
  if (state === "error") throw this.unavailable(503, entry.lastError ?? "backend in error state");
  // state is "starting" or "stopped" → (re-)spawn, serialized per model
  if (entry.startLatch !== null) return entry.startLatch;   // join the in-flight spawn
  const latch = entry.manager
    .start()
    .catch((err) => {
      entry.lastError = err instanceof Error ? err.message : String(err);
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
```

- `.catch` marks `lastError` AND converts to `{ status: 503 }` so the existing `providerError` mapper in `v1.ts` emits 503 (Service Unavailable), not 502 (arch-plan Decision: spawn error distinction).
- The `startLatch` gives the single-writer guarantee at hub level: two concurrent requests hitting a `stopped` (idle) manager share ONE spawn; a second spawn is impossible (arch-plan risk register mitigation).
- `manager.start()` self-transitions `starting` → `running`/`error`; after a failed start the manager sits in `error` and the wrapper throws 503 until the user re-activates (spec: "subsequent requests receive HTTP 503").

### 4.4 `spawnModel(modelId, ggufPath, opts?)` — shared by activate/restore

```typescript
private async spawnModel(
  modelId: string,
  ggufPath: string | null,
  opts?: { persist: boolean },
): Promise<void> {
  if (ggufPath === null || !fs.existsSync(ggufPath)) {
    const message = `GGUF file not found: '${ggufPath ?? "(none)"}'`;
    if (opts?.persist) throw new HubError(400, message);      // activate → 4xx naming the file
    this.errors.set(modelId, message); return;                // restoreActive → error state, boot continues
  }

  const cfg = getModelConfig(this.db, modelId);               // model_config row (nullable)
  const modelRow = this.db.query(
    "SELECT gguf_ctx, yarn_orig_ctx FROM models WHERE id = ?",
  ).get(modelId) as { gguf_ctx: number | null; yarn_orig_ctx: number | null } | null;

  const ctxSize = cfg?.ctxSize ?? modelRow?.gguf_ctx ?? undefined;
  const run: LlamaSpawnArgsInput = {
    modelPath: ggufPath,
    ...(ctxSize !== undefined ? { ctxSize } : {}),
    ...(this.isEmbeddingModel(modelId)
      ? { embeddings: true }
      : {}),
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

  const manager = new LlamaProcessManager({
    binary: this.binary,
    run,
    spawnFn: this.spawnFn,
    now: this.now,
    sleep: this.sleep,
    healthCheck: this.healthCheck,
    log: this.log,
    idleTimeoutMs: this.idleTimeoutMs,     // 10 min (Decision 6)
  });

  this.models.set(modelId, {
    manager,
    provider: this.getOrBuildProvider(modelId, manager),   // gating wrapper
    backend: /* see 4.3 — one raw LlamaServerProvider built inside */,
    inFlight: 0,
    startLatch: null,
    lastError: null,
  });

  try {
    await manager.start();
    this.errors.delete(modelId);
    if (opts?.persist) this.db.query("UPDATE models SET active = 1 WHERE id = ?").run(modelId);
  } catch (err) {
    const entry = this.models.get(modelId);
    if (entry !== undefined) entry.lastError = err instanceof Error ? err.message : String(err);
    if (opts?.persist) throw new HubError(503, entry?.lastError ?? "spawn failed");
    this.log(`restore failed for ${modelId}: ${entry?.lastError}`);
  }
}
```

Wait — one structural fix: `getOrBuildProvider` must receive the same `ManagedModel` it populates (the `noteActivity` closure reads `this.models.get(modelId)`); to avoid the chicken-and-egg, the hub builds the raw backend + wrapper **before** inserting the entry, and `noteActivity` looks the entry up lazily from the map (already written that way — the lookup happens at request time, after insertion). This is safe because requests only arrive after `spawnModel` returns.

### 4.5 Embedder (binding Decision 8)

```typescript
embedder(): Embedder | null {
  if (this.embeddingModelId === null) return null;          // nothing designated
  const entry = this.models.get(this.embeddingModelId);
  if (entry === undefined || entry.manager.status().state === "error") return null;
  if (this.embedderCache === null) {
    const raw = makeLlamaEmbedder({
      baseUrl: () => entry.manager.status().baseUrl ?? "",
      model: this.embeddingModelId,
    });
    this.embedderCache = {
      model: this.embeddingModelId,
      embed: async (input) => {
        await this.ensureReady(this.embeddingModelId!);     // lazy re-spawn, 503 on error
        return raw.embed(input);
      },
    };
  }
  return this.embedderCache;
}
```

- Lifecycle tied to the designated model's `ManagedModel`: **deactivate → entry removed → `embedder()` returns `null`** (spec scenario "Deactivate embedding model clears embedder"); re-activate → restored. Crash-restart: manager goes error → `embedder()` null; manager restarts healthy → non-null again ("embedder resumes when the process becomes healthy").
- The embedder's `embed` goes through `ensureReady` so an idle-stopped embedding model lazily re-spawns instead of failing on an empty baseUrl — consistent with the chat path.
- Spawn args for the designated model include `embeddings: true` (Section 4.4) → `buildLlamaSpawnArgs` emits `--embeddings`.

### 4.6 `src/backend/spawn-args.ts` delta (Decision 8)

```typescript
export interface LlamaSpawnArgsInput {
  /* existing fields … */
  /** Embeddings mode: pushes `--embeddings` (dedicated embedding model). */
  embeddings?: boolean;
}
```

`buildLlamaSpawnArgs` appends `"--embeddings"` immediately after the `--model` pair when `input.embeddings === true` (deterministic order; llama-server accepts flags in any order):

```typescript
if (input.modelPath !== undefined) { /* existing */ }
if (input.embeddings === true) args.push("--embeddings");
/* remaining existing flags … */
```

### 4.7 Route wiring (`src/routes/api.ts`)

```typescript
export interface ApiDeps {
  store: WorkflowStore;
  runner: WorkflowRunner;
  knownModels?: () => string[];
  /** Local backend lifecycle manager (new). */
  hub: LocalBackendHub;
  /** Auth gate applied to the /api/models branch only (spec: management behind the gate). */
  auth?: (req: Request) => Promise<boolean>;
}
```

`makeApiHandler` gains a `parts[1] === "models"` branch (before the existing `workflows` guard, which stays untouched):

| Method | Path | Handler / status |
|---|---|---|
| GET | `/api/models` | `jsonResponse(hub.statusAll(), 200)` |
| GET | `/api/models/:id/status` | `hub.status(id)` → `200`; `null` → `jsonResponse({error:"not_found"}, 404)` |
| POST | `/api/models/:id/activate` | `hub.activate(id)` → `200`; `HubError` → `jsonResponse({error: message}, err.status)` (400/404/503) |
| POST | `/api/models/:id/deactivate` | `hub.deactivate(id)` → `200`; `HubError(404)` → 404 |

The whole `models` branch is gated: `if (deps.auth !== undefined && !(await deps.auth(req)))` → `jsonResponse({ error: "unauthorized" }, 401)` first. The existing `/api/workflows` surface keeps its current (ungated) behavior — zero legacy breakage; `main.ts` passes the same `makeAuthGate({...})` instance it already builds for v1.

### 4.8 Health endpoint (`src/app/server.ts`, Decision 11)

```typescript
export interface ServerDeps {
  /* existing fields … */
  /** Local model ids for /api/health; omitted when the hub is not wired. */
  localModels?: () => string[];
}
```

```typescript
if (req.method === "GET" && url.pathname === "/api/health") {
  const body: Record<string, unknown> = { status: "ok" };
  if (deps.localModels !== undefined) body.localModels = deps.localModels();
  res = Response.json(body);
}
```

Field only present when the hub is wired (spec: "SHALL only be present when the hub is wired").

---

## 5. Request flows

### 5.1 Activation (`POST /api/models/:id/activate`)

```
route (auth gate) → hub.activate(id)
  → SELECT models row            → absent → 404
  → entry running?               → idempotent {state, pid, port} (no re-spawn)
  → entry error?                 → delete entry (retry path)
  → spawnModel(id, path, {persist:true})
      → GGUF missing?            → HubError 400 naming the file (no spawn)
      → build LlamaSpawnArgsInput (model_config + catalog cols + --embeddings?)
      → new LlamaProcessManager  (deps flow from HubDeps fakes)
      → await manager.start()    → spawn → port from stdout → health poll (300ms, 30s cap)
      → throws?                  → lastError set → HubError 503
      → succeeds                 → UPDATE models SET active = 1
  → return {state:"active", pid, port}
```

### 5.2 `/v1/chat/completions` on a local model

```
v1.ts resolveModel → localModels().includes(model) → { kind:"local", provider: wrapper }
wrapper.chat(request)
  → manager.noteRequest()                       (idle timer reset per request)
  → ensureReady(model)
      running  → continue                       (fast path)
      starting → join startLatch                (block ≤30s, then proceed)
      stopped  → start() via latch              (idle re-spawn; block ≤30s)
      error    → throw { status: 503 }          → providerError → HTTP 503
  → backend.chat(request)
      → noteActivity(model): inFlight++      (~gate already reset idle)
      → fetch(baseUrl + /v1/chat/completions)   (requestTimeout)
      → end() → inFlight--
```

Streaming is identical through `chatStream`; the wrapper gates, then yields the raw SSE payloads; `streamResponse` wires client-disconnect abort (unchanged).

### 5.3 Idle re-spawn (spec: "Request after idle-stop re-spawns")

1. `watchIdle` in the manager stops the process after 10 min without requests (`manager.stop()`, state `stopped`).
2. The model remains `active` — still in `localModels()` (non-error entry). Next request resolves to the wrapper.
3. `ensureReady` sees `stopped` → `start()` via the latch → spawn → health poll → `running` → forward. The request blocks until ready or the 30s spawn timeout; spawn failure → 503 (spec: "Re-spawn failure returns 503").

### 5.4 Deactivation drain (`POST /api/models/:id/deactivate`)

```
route → hub.deactivate(id)
  → entry absent?             → 404 | idempotent "disabled"
  → drain(entry): while inFlight > 0 and <30s: sleep 1s
      inFlight hits 0         → stop() now
      30s timeout             → force stop() anyway (in-flight requests reset/close)
  → manager.stop()            → SIGTERM → 3s grace → SIGKILL fallback (killProc)
  → models.delete(id)         → model leaves localModels() → new requests: unknown-model 404
  → UPDATE models SET active = 0
  → { state: "disabled" }
```

Mid-request deactivation: the request holds `inFlight` until `end()`; drain waits; the active request completes. New requests after removal get the 404 envelope ("new requests get error", spec).

### 5.5 Embeddings (`POST /v1/embeddings`)

```
v1.ts handleEmbeddings → deps.embeddings()?.() = hub.embedder()
  → no settings.embedding_model  → null → 404 (existing behavior preserved)
  → designated model missing GGUF / error / deactivated → null → 404
  → otherwise: gated embedder
      embed(input) → ensureReady(designated) → raw LlamaEmbedder.embed(input)
      → spawn-failure during embed → { status: 503 } → providerError → 503
```

---

## 6. Error handling

| Failure | Detection | Behavior | Status mapping |
|---|---|---|---|
| GGUF missing on activate | `fs.existsSync(models.path)` | No manager created; `HubError(400)` naming the file | 400 |
| GGUF missing at boot (active=1) | same, in `restoreActive` | `errors.set(id, msg)`; boot continues; omitted from `/v1/models` | n/a |
| Binary ENOENT (boot preflight) | spawn `--version` throws `code === "ENOENT"` | `preflightError` set; all active rows error state; boot continues (external providers + workflows unaffected) | n/a |
| Binary parseable-but-old / unparseable | `checkLlamaVersionFloor` throws | `this.exit(1)` with actionable upgrade message (global fail-fast) | process exit |
| Spawn failure (port/health timeout, OOM, perms) | `manager.start()` rejects | `entry.lastError` set; manager state `error`; `ensureReady` + `activate` throw `{status: 503}` | 503 (providerError / HubError) |
| Idle re-spawn failure | `start()` rejects in `ensureReady` | `lastError` set; 503 to the blocked request; model stays `error` until re-activate | 503 |
| Unexpected process exit (running) | `monitorExit` | Manager restart with exponential backoff (max 5 attempts, existing) | transient |
| Deactivation drain timeout | `inFlight > 0` after 30s | Force `stop()`; in-flight requests fail with connection reset (spec-sanctioned) | n/a |
| Unknown model (activate/deactivate/status) | DB lookup miss | `HubError(404)` | 404 |
| Deactivated mid-request | entry removed from map | Current request completes (drain); new requests get unknown-model 404 | 404 |

`providerError` (`v1.ts:75`) already respects `err.status`; the wrapper attaches `status: 503` explicitly so spawn failure is never mislabeled 502 (Bad Gateway implies upstream) — arch-plan Design Decision 3.

---

## 7. Config (binding Decision 10)

`src/app/env → src/app/config.ts → src/app/types.ts`:

```typescript
// config.ts
export interface AppEnv {
  WEAVELLM_PORT?: string;
  WEAVELLM_HOST?: string;
  WEAVELLM_AUTH?: string;
  WEAVELLM_APP_DATA?: string;
  /** Path to the llama-server binary (default "llama" on PATH). */
  WEAVELLM_LLAMA_BIN?: string;
}

// types.ts
export interface AppConfig {
  host: string;
  port: number;
  authEnabled: boolean;
  appData: string;
  /** llama-server binary path (WEAVELLM_LLAMA_BIN, default "llama"). */
  llamaBin: string;
}

// config.ts — mirror the resolvePort empty-string fallback pattern
llamaBin: env.WEAVELLM_LLAMA_BIN === undefined || env.WEAVELLM_LLAMA_BIN === ""
  ? "llama"
  : env.WEAVELLM_LLAMA_BIN,
```

`main.ts` passes `config.llamaBin` into `HubDeps.binary`. Empty string falls back to `"llama"` (Decision 10 test expectation).

---

## 8. Testing strategy

### 8.1 Fakes and seams (HubDeps mirrors ManagerDeps)

| Fake | Real default | Proves |
|---|---|---|
| `spawnFn` — returns a seeded `SpawnedProc` (scripted stdout chunks: `listening on 127.0.0.1:PORT`, then settle) | `Bun.spawn` | spawn args correctness, port parsing, `--version` preflight, ENOENT (throws a `{code:"ENOENT"}` error) |
| `now` — deterministic clock | `Date.now` | idle timing, drain deadline, health-poll deadline |
| `sleep` — no-op / manual tick | `setTimeout` | zero real waits in tests; drain poll loop |
| `healthCheck` — `() => resolved boolean` | real `GET /health` | readiness gating, spawn timeout → error |
| `exit` — throws a sentinel | `process.exit` | old-binary fail-fast captured without killing the runner |
| `db` — `":memory:"` `Database` | app DB | persistence assertions (`active` transitions) |

No real `llama-server` is needed anywhere. Manager-level behavior (spawn, health, restart) is already proven in `manager.test.ts` with the same fake pattern — hub tests focus on **orchestration**.

### 8.2 Test matrix

**`src/backend/hub.test.ts` (new)** — the core coverage:

| Test | Proves |
|---|---|
| `activate` happy path | Manager created with `binary` + args (GGUF, ctx, KV), `start()` awaited, `active=1` persisted, `{state, pid, port}` returned |
| `activate` idempotent | Running model → same `{pid, port}`, `spawnFn` called once |
| `activate` missing GGUF | `HubError(400)` naming the file, no spawn, no DB write |
| `activate` spawn failure | `HubError(503)`, entry state `error`, `lastError` set |
| `activate` unknown id | `HubError(404)` |
| `deactivate` zero in-flight | Immediate `stop()`, `active=0`, entry removed, `{state:"disabled"}` |
| `deactivate` with in-flight | Drain polls until `inFlight` reaches 0 (fake decrement), then stops |
| `deactivate` drain timeout | Fake clock pushes past 30s with `inFlight > 0` → `stop()` still called |
| `deactivate` unknown | 404 |
| `preflight` ENOENT | `preflightError` set; `restoreActive` marks active rows error; **no spawn**; no exit |
| `preflight` old binary | `exit` called with 1 (sentinel thrown) |
| `preflight` current | proceeds; `restoreActive` spawns |
| `restoreActive` two active models | Both spawned (spawnFn call count), appear in `localModels()` |
| `restoreActive` missing GGUF | `errors` map entry, boot continues, omitted from `localModels()` |
| idle re-spawn via wrapper | Manager `stopped` → `wrapper.chat()` → `start()` called → response succeeds |
| wrapper on `error` | `chat()` rejects with `status === 503` |
| wrapper on `starting` | `chat()` blocks (joins latch) until fake health flips → forwards |
| concurrent `stopped` hits | Both requests share one spawn (`spawnFn` once) — latch serialization |
| `localModels()` filters error | Error entry excluded; `stopped` entry included |
| `embedder()` null → non-null → null | Designated via settings; deactivate clears; re-activate restores |
| `embed()` through gate | Idle-stopped embedding model re-spawns before forwarding |
| `stopAll()` | Drains + stops every manager, map emptied |

**Modified existing suites:**

- `src/backend/manager.test.ts` — assert `IDLE_TIMEOUT_MS === 10 * 60 * 1000`; update timer tests that referenced 5 min.
- `src/backend/spawn-args.test.ts` — `embeddings: true` → args include `--embeddings`; omitted/false → absent (spec scenarios).
- `src/db/schema.test.ts` — fresh DB has `active` column in `MODELS_TABLE`; existing DB without it gets ALTER; re-run is a no-op.
- `src/app/config.test.ts` — `llamaBin` default `"llama"`, custom value, empty string → default.
- `src/app/server.test.ts` — health returns `localModels` when wired; omits the field when not wired (Decision 11).
- `src/routes/api.test.ts` — `/api/models` list/status/404; activate 200 + 503; deactivate 200 + 404; auth gate applied to models branch (401 when enabled, admit when disabled).
- `src/main.test.ts` (boot) — hub created with `config.llamaBin`; `preflight` + `restoreActive` run before server start; non-null closures reach services; stale "local ids do not resolve" comment removed.

### 8.3 CI gate

`bun run typecheck && bun run lint && bun test` must stay green (acceptance criterion 7); no new inline eslint disables; all new types explicit, no `any`.

---

## 9. Risks

| Risk (carried from spec/arch-plan) | Severity | Design mitigation |
|---|---|---|
| Idle-stop re-spawn race (concurrent requests hitting a stopped manager) | Medium | `startLatch` per `ManagedModel` serializes `start()`; a second spawn is structurally impossible (Section 4.3). |
| 30s drain timeout leaves orphan processes | Low | Reuses `killProc` (SIGTERM → 3s → SIGKILL) — already in manager.ts; forced-stop path covered by test. |
| Schema migration on corrupted DB | Low | `PRAGMA table_info` is read-only; single atomic `ALTER` in WAL mode; migration test covers fresh + existing + idempotent. |
| Embedding model deactivation mid-embedding | Low | `embedder()` returns `null` immediately on entry removal; v1 embeddings route already 404s on null. |
| **Closure arity ambiguity** (`localProvider(modelId)` decision vs zero-arg seams) | Medium | Explicit reconciliation in Section 2.3; wrapper dispatches per `request.model`; tests cover both call shapes. |
| `--version` output unparseable | Low | Treated as fail-fast (matches `checkLlamaVersionFloor` contract — cannot prove the floor, refuse to serve corrupted responses); ENOENT is the only per-model path (Decision 3). |
| Non-ENOENT binary spawn failure (EACCES, missing loader) | Low | Bucketed with ENOENT as "binary unavailable" per-model error — boot continues; differentiated message includes the OS error. |
| `requestTimeoutMs` not in `AppConfig` | Low | Hub-level default constant (300_000) matches the provider default; no config surface added in this change. |
| YaRN rope formula drift | Low | `rope` derived from existing `models.yarn_orig_ctx` + effective ctx (model_config.ctx_size ?? gguf_ctx); implementer confirms against `catalog.ts` during apply, spawn-args test pins the emitted args. |
| VRAM heuristic (arch-rfc) | — | **Explicitly deferred** (Decision 12): spawn is unconditional; `--n-gpu-layers 0` CPU fallback NOT implemented; arch-rfc VRAM section is the reference for the future change. |

---

## 10. Binding-decision traceability

| Arch-plan decision | Satisfied by |
|---|---|
| D1 Hub module (`src/backend/hub.ts`, `Map<string, LlamaProcessManager>`, 8 closures/methods) | Section 4.1 |
| D2 Boot wiring (preflight → restoreActive → non-null closures; `hub` in ApiDeps) | Sections 2.2, 4.2, 4.7 |
| D3 Version-floor semantics (ENOENT per-model vs old fail-fast) | Section 4.2 `preflight` |
| D4 Activation flow (verify GGUF → manager → start → 200/4xx/503 → persist) | Sections 4.2, 5.1 |
| D5 Readiness-gating wrapper (stopped→start, starting→await, error→503, running→fast) | Section 4.3 |
| D6 Idle-stop 10 min default via `ManagerDeps.idleTimeoutMs` | Section 4.1 (`HUB_IDLE_TIMEOUT_MS`) + manager.ts constant change |
| D7 In-flight drain on deactivation (1s poll, 30s safety, force stop) | Section 4.2 `drain` |
| D8 Embedder via `settings.embedding_model` + `--embeddings` | Sections 3.2, 4.5, 4.6 |
| D9 Schema: `active INTEGER NOT NULL DEFAULT 0` + idempotent ALTER | Section 3.1 |
| D10 Config: `WEAVELLM_LLAMA_BIN` → `llamaBin` | Section 7 |
| D11 Health: optional `localModels` field | Section 4.8 |
| D12 VRAM heuristic deferred | Section 9 |

## Artifacts

| File | Action |
|---|---|
| `openspec/changes/wire-local-backend/design.md` | Create (this file) |