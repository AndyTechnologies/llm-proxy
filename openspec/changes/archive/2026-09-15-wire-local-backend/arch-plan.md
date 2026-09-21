# Architecture Plan: wire-local-backend

Binding acta for the `wire-local-backend` change. Each decision is titled, sourced, and contains rationale, alternatives, and consequences.

---

## Decision 1 — Hub Module

**Title:** LocalBackendHub as per-model manager owner

**Decision:** Create `LocalBackendHub` in `src/backend/hub.ts` as a class owning a `Map<string, LlamaProcessManager>` (one manager per active model) plus closures: `localProvider(modelId)`, `localModels()`, `embedder()`, `activate()`, `deactivate()`, `status()`, `statusAll()`, `stopAll()`.

**Rationale:** The arch-rfc (Manager Topology section) specifies one `LlamaProcessManager` per active model in a `Map<string, LlamaProcessManager>`, single owner, no races. The explore.md confirms the new file `src/backend/hub.ts` is the only new file needed. The proposal gives the full interface. This follows the existing DI pattern: manager.ts already owns per-model lifecycle, the hub simply aggregates multiple managers.

**Alternatives considered:**
- *Single shared manager* — rejected; arch-rfc explicitly says "one manager per active model" and "no shared state between managers."
- *Module-level Map* — rejected; loses DI seams, harder to test, violates existing class-injected pattern.

**Consequences:**
- `hub.test.ts` tests all activate/deactivate/status/stopAll flows in isolation.
- `ApiDeps` gains a `hub` field; boot wiring creates one hub instance.
- No changes to `runner.ts`, `v1.ts`, `registry.ts`, or `types.ts` (explore.md blast radius confirmed).
- Hub is the single writer guarantee — eliminates race between API handlers and boot (arch-rfc invariants).

---

## Decision 2 — Boot Wiring

**Title:** Non-null DI closures into makeRuntimeServices, makeV1Handler, makeApiHandler

**Decision:** In `src/main.ts`: create hub, call `hub.preflight()` then `hub.restoreActive()`, then wire:
```
localProvider: (id) => hub.localProvider(id),
localModels: () => hub.localModels(),
embedder: hub.embedder(),
```
into `makeRuntimeServices`. Add `hub` to `ApiDeps` passed to `makeApiHandler`. `makeV1Handler` receives the same non-null closures. Version-floor preflight runs before `restoreActive()`.

**Rationale:** main.ts currently has `localProvider: () => null` and `localModels: () => []` (line 73-74, 86-87). The arch-rfc (Boot Wiring Order) specifies: read DB → version floor → spawn active models → create handlers. The explore.md confirms main.ts is the integration point. The proposal Section 2 gives the exact wiring shape.

**Alternatives considered:**
- *Post-server-start spawn* — rejected; arch-rfc requires active models available before server.start() accepts traffic.
- *Lazy hub creation* — rejected; version floor must run before any manager is created.

**Consequences:**
- Boot order becomes: DB → config → secretStore → registry → hub.preflight() → hub.restoreActive() → makeRuntimeServices (non-null) → makeV1Handler (non-null) → makeApiHandler (with hub) → createWebServer → server.start().
- `main.test.ts` adds boot wiring tests verifying non-null closures flow through.
- The existing comment on line 69 ("local ids do not resolve") becomes stale and must be removed.

---

## Decision 3 — Version-Floor Semantics

**Title:** ENOENT → per-model error + boot continues; parseable-but-old → global fail-fast

**Decision:** The preflight (`hub.preflight()`) distinguishes three outcomes:
1. **ENOENT** (binary not found at `config.llamaBin`): all models enter error state with `"llama-server binary not found at '<path>'"`; boot continues; external providers and workflows unaffected.
2. **Parseable but below b9908**: `process.exit(1)` with actionable upgrade message — global fail-fast.
3. **Parseable and current (≥ b9908)**: proceed.

**Rationale:** arch-rfc Constraints section: "Version floor check runs once at boot (fail-fast if old)." spec.md "Version floor — binary not found (ENOENT)" scenario: "boot continues; the system remains operational for external providers and workflows." explore.md Design Decision 1: "ENOENT is a deployment configuration issue (wrong path), not a code incompatibility." The existing `checkLlamaVersionFloor()` in spawn-args.ts (line 129) throws on both ENOENT and old-version — the hub must catch ENOENT and convert it to per-model error, not let the throw propagate to `process.exit(1)`.

**Alternatives considered:**
- *Fail-fast on ENOENT too* — rejected; explore.md and spec.md explicitly require boot continuation for ENOENT so external providers stay available.
- *Per-model error on old binary too* — rejected; an old binary can produce corrupted responses for all models — global fail-fast is correct.

**Consequences:**
- `hub.preflight()` must call the binary's `--version` via a spawn, catch ENOENT specifically (not just any error), and store the "all models disabled" error message.
- `hub.restoreActive()` must skip spawning when preflight stored an ENOENT error.
- Tests: ENOENT path → hub has error state, boot returns normally; old binary → process.exit(1) captured in test.

---

## Decision 4 — Activation Flow

**Title:** POST /api/models/:id/activate → verify GGUF → create manager → start() → respond {state, pid, port}

**Decision:** `hub.activate(modelId)`:
1. Look up model in DB (id exists? → 404).
2. Verify GGUF file exists on disk (`fs.existsSync` or equivalent) → missing file returns 4xx error with clear message.
3. Check if already active (manager exists + running) → return current {state, pid, port} (idempotent).
4. Build `LlamaSpawnArgsInput` from `getModelConfig(db, modelId)` + catalog row.
5. Create `LlamaProcessManager` with `config.llamaBin` as binary, `ManagerDeps.run` from spawn args.
6. `await manager.start()` — if it throws, manager enters error state, response is 503 with error message.
7. Persist `active=1` to SQLite.
8. Return `{state: "active", pid: manager.status().pid, port: manager.status().port}`.

**Rationale:** spec.md "Activate a model" scenario: process starts, response is `{state, pid, port}`, active=1 persisted. "Activate an already-active model" → return current state without re-spawning (idempotent). "Activate with missing GGUF returns error." explore.md: "activate endpoint — buildable (hub + status())." arch-rfc: "Model activation is always an explicit user action; never automatic."

**Alternatives considered:**
- *Background activation* — rejected; spec requires synchronous response with pid/port; user must know activation succeeded.
- *Two-phase (queue + poll)* — rejected; over-engineering for a local desktop app; the 30s start timeout is acceptable.

**Consequences:**
- Route handler in api.ts: `POST /api/models/:id/activate` → `hub.activate(id)` → 200/4xx/503.
- 503 propagation: manager.start() throws → hub catches → `err.status = 503` → providerError in v1.ts maps to 503 (explore.md Design Decision 3).
- Existing test for `/api/models/:id/activate` goes into `src/routes/api.test.ts` and `hub.test.ts`.
- `getModelConfig` must be imported from `src/db/model-config.ts` (explore.md confirmed unchanged).

---

## Decision 5 — Readiness-Gating Wrapper

**Title:** localProvider() wrapper awaits start() when stopped, running when starting, 503 on spawn failure, re-spawns after idle-stop

**Decision:** `hub.localProvider(modelId)` returns a `Provider` wrapper (not the raw `LlamaServerProvider`) whose `chat`/`chatStream` methods:
1. If manager state is `stopped` (idle-stop) → call `manager.start()` (re-spawn), then forward request.
2. If manager state is `starting` → await health poll (up to 30s) before forwarding.
3. If manager state is `error` → throw immediately with `err.status = 503`.
4. If manager state is `running` → forward directly (fast path).

**Rationale:** spec.md "Spawn-time readiness gate" requirement: "LocalBackendHub.localProvider() SHALL return a provider wrapper whose chat/chatStream methods await the manager's health poll before forwarding." "If the manager is not yet ready (still spawning), the request SHALL block until ready or time out (30s). If in error state, the wrapper SHALL throw immediately with err.status = 503." The proposal Section 1 "Readiness-gating wrapper" confirms this shape.

**Alternatives considered:**
- *Fail-fast when stopped* — rejected; spec explicitly requires transparent re-spawn for idle-stop recovery.
- *Separate /ready endpoint + client polling* — rejected; unnecessary complexity for a local proxy; the wrapper handles it internally.

**Consequences:**
- Wrapper must call `manager.noteRequest()` on every forwarded request (resets idle timer).
- The 30s timeout on re-spawn is the same `startTimeoutMs` on `ManagerDeps` — no new constant needed.
- v1.ts `resolveModel()` (line 101-112) already handles the `localProvider()` return — the wrapper is transparent to the caller.
- Tests: idle-stop + re-spawn, error state → 503, starting state → blocks then succeeds.

---

## Decision 6 — Idle-Stop

**Title:** 10 min default, configurable via ManagerDeps.idleTimeoutMs

**Decision:** Change `IDLE_TIMEOUT_MS` from `5 * 60 * 1000` (5 min, line 23 of manager.ts) to `10 * 60 * 1000` (10 min). The value remains configurable via `ManagerDeps.idleTimeoutMs` (line 68 of manager.ts). Hub passes the default; no new config env var for now.

**Rationale:** arch-rfc Quality Attributes section: "Idle-stop default: 10 min; configurable." spec.md "Idle-stop after 10 minutes" scenario. explore.md: "IDLE_TIMEOUT_MS 5→10 min." The `ManagerDeps.idleTimeoutMs` field already exists (line 68 of manager.ts), so no structural change needed — just the constant update.

**Alternatives considered:**
- *Env-configurable idle timeout* — rejected for this change; the explore.md and proposal do not mention it; adding a new env var is future work.
- *No idle-stop* — rejected; VRAM management requires releasing resources.

**Consequences:**
- Single constant change in manager.ts line 23.
- `manager.test.ts` must update any tests asserting 5 min behavior.
- Idle watchdog (`watchIdle`, line 321) already uses `this.idleTimeoutMs` — no code change needed there.

---

## Decision 7 — In-Flight Drain on Deactivation

**Title:** Deactivation waits for noteActivity counter to reach 0, 30s safety timeout, then stop()

**Decision:** `hub.deactivate(modelId)`:
1. Read current in-flight count via `LlamaServerProvider`'s `noteActivity` counter (already exposed by the provider's `trackRequest` mechanism).
2. If 0: call `stop()` immediately.
3. If > 0: poll every 1s for up to 30s until counter reaches 0, then `stop()`.
4. If timeout: force `stop()` anyway (in-flight requests fail with connection reset — acceptable per spec).
5. Remove manager from Map, persist `active=0` to SQLite.
6. Return `{state: "disabled"}`.

**Rationale:** spec.md "In-flight drain on deactivation" scenario: "poll every 1s for up to 30s until in-flight count reaches 0, then calls stop()." "Deactivation timeout forces stop" scenario: "stop() is called anyway after 30s timeout." explore.md Design Decision 4: "gate stop() on the in-flight counter (noteActivity)." arch-rfc invariants: "In-flight requests complete before process termination on deactivation."

**Alternatives considered:**
- *Hard kill with no drain* — rejected; violates arch-rfc invariant.
- *Infinite wait for drain* — rejected; 30s safety timeout prevents unbounded deactivation hangs.

**Consequences:**
- The `noteActivity` counter (noteActivity callback in LlamaServerOptions, line 32 of llama-server.ts) must be wrapped: hub needs a reference to the in-flight count. The existing `trackRequest` returns an end-callback that decrements — hub must maintain the counter.
- `hub.stopAll()` (graceful shutdown) applies the same drain per manager.
- Tests: drain with active requests, drain timeout forces stop, drain with zero requests.

---

## Decision 8 — Embedder

**Title:** Dedicated embedding model designated via settings row `embedding_model`; spawn with --embeddings

**Decision:**
- A `settings` table row with key `embedding_model` and value = model ID designates the dedicated embedder.
- Hub reads this row at construction time.
- When set: hub creates that model's `LlamaProcessManager` with `--embeddings` flag in spawn args, wraps it as a `LlamaEmbedder` (from `src/providers/embeddings.ts`).
- When not set: `hub.embedder()` returns `null`; `/v1/embeddings` returns 404 (existing behavior preserved — spec.md Scenario: "No embedding model configured → 404").
- `LlamaSpawnArgsInput` gains `embeddings?: boolean` field; when true, `buildLlamaSpawnArgs` pushes `"--embeddings"` (spec.md "Spawn args support embeddings mode").

**Rationale:** spec.md embeddings-rag delta: "A dedicated model SHALL be designated via a settings table row with key embedding_model." explore.md: "recommend settings row embedding_model; requires --embeddings in spawn-args." proposal Section 1: "If settings table has embedding_model key... hub creates dedicated manager... wraps it as LlamaEmbedder." The `settings` table already exists (schema.ts line 109) — no new table needed.

**Alternatives considered:**
- *Hardcoded embedder model* — rejected; spec requires settings-based designation for flexibility.
- *Embedder as separate process outside hub* — rejected; violates "one manager per model" invariant; harder to lifecycle-manage.
- *UI configuration in this change* — rejected; proposal explicitly says "power users set it via SQLite directly."

**Consequences:**
- `spawn-args.ts`: add `embeddings?: boolean` to `LlamaSpawnArgsInput`; push `"--embeddings"` when true.
- `spawn-args.test.ts`: add test for embeddings flag.
- `hub.embedder()` returns `LlamaEmbedder | null` — `embeddings.ts` already exports `LlamaEmbedder` (explore.md: "LlamaEmbedder fits the dedicated-embedder contract").
- Embedding model lifecycle tied to its manager: deactivate → embedder() returns null; re-activate → embedder() restores.
- Boot: if `embedding_model` is set and model has `active=1`, hub restores its manager and embedder on `restoreActive()`.

---

## Decision 9 — Schema

**Title:** active INTEGER NOT NULL DEFAULT 0 + idempotent ALTER migration

**Decision:**
- Add `active INTEGER NOT NULL DEFAULT 0` to the `MODELS_TABLE` CREATE statement (for fresh DBs).
- In `applySchema`, after existing table creation: query `PRAGMA table_info(models)`, check for `active` column. If absent: `ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0`.
- Existing rows get `active=0` (the DEFAULT).

**Rationale:** spec.md "Active column in SQLite models table": "Fresh databases SHALL have this column in the CREATE statement. Existing databases SHALL receive an idempotent ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0 migration (checked via PRAGMA table_info(models))." explore.md: "add active INTEGER NOT NULL DEFAULT 0 + idempotent ALTER migration for existing DBs." schema.ts currently has no `active` column (line 19-33).

**Alternatives considered:**
- *Separate migration file* — rejected; the project has no migration framework; inline ALTER in applySchema is the established pattern.
- *Runtime check instead of migration* — rejected; the column must exist in SQLite for queries; ALTER is the only option.

**Consequences:**
- `MODELS_TABLE` string literal (schema.ts line 19) gains the `active` column.
- `applySchema` (schema.ts line 116) adds the PRAGMA check + ALTER block.
- `schema.test.ts` must test: fresh DB has column, existing DB without column gets migrated, idempotent re-run doesn't fail.
- No new table; the `embedding_model` key lives in the existing `settings` table (no schema change for that).

---

## Decision 10 — Config

**Title:** WEAVELLM_LLAMA_BIN env var → llamaBin on AppConfig

**Decision:**
- `AppEnv` interface (config.ts) gains `WEAVELLM_LLAMA_BIN?: string`.
- `AppConfig` interface (types.ts) gains `llamaBin: string`.
- `resolveAppConfig` reads `WEAVELLM_LLAMA_BIN`, defaults to `"llama"`.

**Rationale:** explore.md: "WEAVELLM_LLAMA_BIN (default 'llama') → llamaBin." proposal Section 5: "AppConfig gains llamaBin: string; resolveAppConfig reads WEAVELLM_LLAMA_BIN env, defaults to 'llama'." arch-rfc Constraints: "Missing binary → model in error state, boot continues."

**Alternatives considered:**
- *Hardcoded path* — rejected; no flexibility for different llama.cpp installations.
- *Config file* — rejected; the project is environment-driven (AGENTS.md: "no config file loaded by the app").

**Consequences:**
- `config.test.ts` must test: default "llama", custom value, empty string falls back to default.
- `main.ts` passes `config.llamaBin` to `LocalBackendHub` constructor.
- `AppEnv` and `AppConfig` type changes propagate to test files that construct these objects.

---

## Decision 11 — Health

**Title:** /api/health gains optional localModels field

**Decision:** `GET /api/health` response gains `localModels?: string[]` — the IDs of active+healthy local models from `hub.localModels()`. The field is only present when the hub is wired (non-null). Current response is `{status: "ok"}` (server.ts line 53); it becomes `{status: "ok", localModels?: [...]}`.

**Rationale:** spec.md dashboard-api delta: "GET /api/health SHALL include a localModels field listing IDs of active+healthy local models. The field SHALL only be present when the hub is wired." explore.md: "/api/health needs optional localModels field." proposal Section 7: "GET /api/health response gains optional localModels field."

**Alternatives considered:**
- *Always include localModels (empty array when no hub)* — rejected; spec says "only present when the hub is wired" to maintain backward compatibility.
- *Separate /api/local-models endpoint* — rejected; spec explicitly extends the existing health endpoint.

**Consequences:**
- `server.ts` `buildFetchHandler` (line 52): the health endpoint must receive hub dependency. `ServerDeps` (line 17) gains an optional `localModels?: () => string[]` field.
- `server.test.ts` must test: health with localModels present, health without hub (no localModels field).
- No new route; the health endpoint is inside `buildFetchHandler`, not routed through `api` or `v1`.

---

## Decision 12 — VRAM Heuristic Spawn (DEFERRED)

**Title:** VRAM heuristic spawn is EXPLICITLY DEFERRED

**Decision:** VRAM-aware spawn (detect VRAM, compare model demand, evict LRU, CPU fallback) is not implemented in this change. All spawns are unconditional. This is explicitly listed as a non-goal in the proposal, arch-rfc non-goals, and explore.md.

**Rationale:** proposal Non-Goals: "VRAM heuristic spawn (explicit future work; current change spawns unconditionally)." arch-rfc VRAM Management section describes the full heuristic but the Constraints section says: "No auto-activate all mode at boot." The arch-rfc's VRAM Heuristic Spawn is described architecturally but scoped out of this implementation.

**Alternatives considered:**
- *Minimal VRAM check before spawn* — rejected; the full heuristic is the only safe design, and it's substantial enough to warrant its own change.
- *Hard-fail on insufficient VRAM* — rejected; the arch-rfc specifies CPU fallback, not hard failure.

**Consequences:**
- Spawn is always unconditional (no VRAM check, no eviction).
- The arch-rfc VRAM section serves as the design reference for the future change.
- Tests do not need to cover VRAM-related scenarios.
- The `--n-gpu-layers 0` CPU fallback path is NOT implemented yet.

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Idle-stop re-spawn race (concurrent requests hitting stopped manager) | Medium | Single writer per manager (arch-rfc invariant); wrapper serializes start() calls. |
| 30s drain timeout leaves orphan processes | Low | `killProc` in manager.ts already sends SIGTERM + SIGKILL fallback (line 338-352). |
| Schema migration fails on corrupted DB | Low | PRAGMA table_info is read-only; ALTER is atomic in SQLite WAL mode. |
| Embedding model deactivation mid-embedding | Low | `hub.embedder()` returns null immediately; caller (v1.ts embeddings route) already returns 404. |

## Artifacts

| File | Action |
|---|---|
| `openspec/changes/wire-local-backend/arch-plan.md` | Create (this file) |
