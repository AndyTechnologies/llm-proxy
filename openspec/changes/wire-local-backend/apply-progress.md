# Apply Progress: wire-local-backend

## Batch: Tanda 1 — Foundations (~250 lines)
**Date**: 2026-09-15
**Commit**: feat(backend): local backend foundations — active column, llama bin config, embeddings flag, health models

### Completed Tasks

| Task | Status | Test File | New Tests | Evidence |
|------|--------|-----------|-----------|----------|
| T1 — Schema migration (`active` column + settings fixture) | ✅ | `src/db/schema.test.ts` | 4 | `bun test src/db/schema.test.ts` → 10/10 pass |
| T2 — Config `WEAVELLM_LLAMA_BIN` → `llamaBin` | ✅ | `src/app/config.test.ts` | 3 | `bun test src/app/config.test.ts` → 6/6 pass |
| T3 — Spawn args `embeddings?: boolean` | ✅ | `src/backend/spawn-args.test.ts` | 4 | `bun test src/backend/spawn-args.test.ts` → 18/18 pass |
| T7 — Server health `localModels` field | ✅ | `src/app/server.test.ts` | 3 | `bun test src/app/server.test.ts` → 12/12 pass |
| T4 constant — `IDLE_TIMEOUT_MS` 5→10 min | ✅ (constant only) | `src/backend/manager.test.ts` | 1 | `bun test src/backend/manager.test.ts` → 11/11 pass |

**Total new tests written**: 15
**Full suite**: `bun run typecheck && bun run lint && bun test` → 397/397 pass

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| T1 | `src/db/schema.test.ts` | Unit | ✅ 6/6 | ✅ Written | ✅ Passed (10/10) | ✅ 4 cases: fresh, pre-migration, idempotent, settings fixture | ➖ None needed |
| T2 | `src/app/config.test.ts` | Unit | ✅ 3/3 | ✅ Written | ✅ Passed (6/6) | ✅ 3 cases: default, custom, empty→default | ➖ Pure function, already clean |
| T3 | `src/backend/spawn-args.test.ts` | Unit | ✅ 14/14 | ✅ Written | ✅ Passed (18/18) | ✅ 4 cases: true, omitted, false, full-argv pin | ➖ Pure function, already clean |
| T7 | `src/app/server.test.ts` | Unit | ✅ 9/9 | ✅ Written | ✅ Passed (12/12) | ✅ 3 cases: wired, absent, empty list | ➖ None needed |
| T4 constant | `src/backend/manager.test.ts` | Unit | ✅ 10/10 | ✅ Written | ✅ Passed (11/11) | ➖ Single (one possible constant value) | ➖ None needed |

### Deviations from Design

- **`ServerDeps.localModels` typed as `() => string[]`** (design §4.8) rather than `healthExtra?: () => Record<string, unknown>` from the task prompt suggestion. Design is the binding contract; the task prompt marked `healthExtra` as an example ("e.g.").
- **`resolveLlamaBin` extracted** as a pure function in `config.ts`, mirroring the existing `resolvePort` pattern — reuses the empty-string-fallback convention explicitly.
- **`ws.test.ts` updated** (2 lines) to satisfy the new required `AppConfig.llamaBin` field — not listed in the tasks but necessary because adding a required field breaks all AppConfig literal fixtures. Committed together per convention.

### Issues Found

- Worktree `node_modules` was missing `yaml`, `typescript`, `eslint` (never `bun install`ed in worktree). Ran `bun install` to fix the pre-existing environment gap. Not caused by this change.

### Remaining Tasks

- [ ] Task 4 (full hub.ts — `LocalBackendHub` core module, ~350-400 lines) — deferred to tanda 2
- [ ] Task 5 — Hub test matrix (`hub.test.ts`, ~500-550 lines)
- [ ] Task 6 — `/api/models` management routes behind auth
- [ ] Task 8 — Wire hub into boot (`main.ts` preflight + restoreActive)
- [ ] Task 9 — v1/runner integration tests

### Relevant Files

- `src/db/schema.ts` — `active INTEGER NOT NULL DEFAULT 0` in `MODELS_TABLE`; `migrateModelsActive` PRAGMA-gated ALTER
- `src/db/schema.test.ts` — fresh/legacy/idempotent migration tests + settings fixture
- `src/app/config.ts` — `AppEnv.WEAVELLM_LLAMA_BIN?` + `resolveLlamaBin` pure function
- `src/app/types.ts` — `AppConfig.llamaBin: string` (now required)
- `src/app/config.test.ts` — `llamaBin` default/custom/empty tests
- `src/backend/spawn-args.ts` — `LlamaSpawnArgsInput.embeddings?: boolean` + `--embeddings` emission
- `src/backend/spawn-args.test.ts` — embeddings flag position/absence/full-argv tests
- `src/backend/manager.ts` — `IDLE_TIMEOUT_MS` now 10 min (5 * 60_000 → 10 * 60_000)
- `src/backend/manager.test.ts` — 10-minute constant assertion
- `src/app/server.ts` — `ServerDeps.localModels?: () => string[]` + health branch
- `src/app/server.test.ts` — health localModels wired/absent/empty tests
- `src/app/ws.test.ts` — `AppConfig` fixture updated for `llamaBin` (2 lines)

---

## Batch: Tanda 2 — Hub core + boot wiring (~950 lines)
**Date**: 2026-09-15
**Commit**: feat(backend): LocalBackendHub module — lifecycle, activation, readiness gating, boot wiring

### Completed Tasks

| Task | Status | Test File | New Tests | Evidence |
|------|--------|-----------|-----------|----------|
| T4 — `LocalBackendHub` orchestration module | ✅ | `src/backend/hub.ts` (behavior proven by T5) | — | `bun run typecheck` clean |
| T5 — Hub unit test matrix | ✅ | `src/backend/hub.test.ts` | 24 | `bun test src/backend/hub.test.ts` → 24/24 pass, 82 expect calls |
| T6 — `/api/models` routes behind optional auth | ✅ | `src/routes/api.test.ts` | 6 | `bun test src/routes/api.test.ts` → 17/17 pass (workflows suite untouched) |
| T8 — Boot wiring (preflight → restoreActive → closures → shutdown) | ✅ | `src/main.test.ts` | 3 | `bun test src/main.test.ts` → 4/4 pass |
| T9 — v1/runner integration tests | ✅ | `src/routes/v1.integration.test.ts` (**new file**, see deviations) | 7 | `bun test src/routes/v1.integration.test.ts` → 7/7 pass |

**Total new tests written (tanda 2)**: 40
**Full suite**: `bun run typecheck && bun run lint && bun test` → **437/437 pass, 1115 expect calls, 41 files** (tanda 1 baseline was 397).

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| T4/T5 | `src/backend/hub.test.ts` | Unit (fakes) | ✅ full-file baseline green before hub landed | ✅ harness written against the planned surface; 6 failures fixed (override/assertion decoupling, construction-time embedder read, sleep race) | ✅ 24/24 | ✅ 24 scenarios: activation args/idempotency/400/404/503, drain happy+timeout, status 3D, preflight ENOENT/old-build, restoreActive, idle re-spawn ×2, latch serialization, zero-arg dispatch, embedder null↔non-null, stopAll | ✅ `makeHub(over, scripted?)` signature so the hub and assertions share ONE ScriptedSpawn |
| T6 | `src/routes/api.test.ts` | API | ✅ 13/13 workflows suite green before/after | ✅ models sections written against makeApiHandler + real hub | ✅ 17/17 | ✅ 6 cases: list, auth 401/absent, :id status + 404, activate 200/400, deactivate persists active=0 + 404, 405 matrix | ✅ per-endpoint method guards (a top-level GET guard would have 405'd activate/deactivate POSTs) |
| T8 | `src/main.test.ts` | Boot integration | ✅ | ✅ 3 new boot tests | ✅ 4/4 | ✅ error-state boot (missing binary + seeded active), script-binary clean boot, shutdown resolves | ✅ existing boot test hardened with missing `WEAVELLM_LLAMA_BIN` (hermetic) |
| T9 | `src/routes/v1.integration.test.ts` | Integration (real hub + real HTTP stub) | ✅ | ✅ 7 tests | ✅ 7/7 | ✅ /v1/models ownership, chat 200 + SSE stream with exactly one `[DONE]`, idle re-spawn (count 2), failing re-spawn → 503, unknown model 404 envelope, runner llm_call(m1) → stub content, embeddings 404 with no embedder | ✅ harness `v1()` wrapper returns non-null Response instead of scattering `!` at call sites |

### Deviations from Design / Task Prompt

- **T9 lives in a NEW file `src/routes/v1.integration.test.ts`** — the task prompt named a new file; `tasks.md`/arch-plan said modify `src/routes/v1.test.ts`. Followed the prompt; `v1.test.ts` untouched. Flag for the archive step.
- **`restoreActive()` runs BEFORE handler construction/server start** — arch-plan Decision 2 + design §2.2 are binding; the T8 prompt text said "restoreActive after server start". Followed the binding acta.
- **`ApiDeps.hub` is OPTIONAL (`hub?:`)** — design §4.7 said required. Made optional so the pre-existing `api.test.ts` fixtures compile and the un-wired handler keeps its legacy 404-on-models behavior; boot always passes a hub.
- **`embeddingModelId` is read FRESH per access** — design §3.2 read it once at construction. Lazy read via `private embeddingModelId()` (settings row) was required by test seeding order (settings written after hub construction) and is strictly more correct for runtime designation changes.
- **`HubDeps.idlePollMs` added** (additive, optional) — flows into every manager; not in design, needed for deterministic idle tests. Default undefined → manager defaults unchanged.
- **`maybe-restore test seams`**: hub tests use real capped sleep timers (`min(ms, 5)`) + `performance.now`, NOT the no-op sleep design §8.1 suggested — a no-op sleep starves the idle watchdog's microtask loop (same trap documented in `manager.test.ts`). The starting-latch test uses REAL (uncapped) sleep via override.
- **`BootResult.shutdown` added** — task text didn't list it; required for D1 drain semantics at process exit (SIGINT/SIGTERM → `hub.stopAll()` then `server.stop()`).
- **`main.test.ts` T8 seed done via `openAppDataDatabase(appData)` before `boot()`** — tasks.md suggested seeding through the `db` handle returned by `boot()`; pre-seeding is required to exercise `restoreActive()` (active=1 must exist before boot).
- **`makeGatingProvider(modelId, backend)` — manager param dropped** (construction-time arity fix; the manager is bound inside the closure by the hub).

### Issues Found

- **TS non-null-assertion precedence**: `await h.v1(...)!` asserts on the Promise (never null), not the awaited value — `res` still had type `Response | null`. Fix: harness wrapper returns `Response` and throws on dispatcher-null; no scattered `!` needed.
- **`llama-server` adapter `chatStream` parses real SSE** from the upstream — the test stub MUST return `text/event-stream` for `stream: true` requests (a JSON response would fail parsing), while `chat()` expects JSON. Stub branches on the request body.
- **Top-level GET guard trap in `api.ts`**: an early `req.method !== "GET"` 405 would have rejected the activate/deactivate POSTs — method checks must be per-endpoint. Caught by the typecheck (unreachable-comparison errors) BEFORE runtime.
- **Hub test harness override/assertion decoupling** (documented in `hub.test.ts`): `makeHub(over, scripted?)` must receive the SAME `ScriptedSpawn` the hub uses; earlier shape had the hub build an internal scripted spawn shadowed by `over.spawnFn`, so assertions read stale state.

### Remaining Tasks

- [x] All tasks complete — change is ready for the architecture-lint / verify gate. SDD pipeline docs (proposal/quest/explore/RFC/design/spec) remain untracked in the worktree; they are pipeline-owned and land with the change archive.

### Relevant Files

- `src/backend/hub.ts` — `LocalBackendHub` + `ModelStatus`/`HubError`/`HubDeps`; `preflight` (ENOENT-tolerant, version floor 9908), `restoreActive`, `activate`/`deactivate` (drain 1s poll / 30s force), 3-state `status`/`statusAll`, `localProvider(modelId?)` dispatcher + readiness gate (`ensureReady`, `startLatch`), `localModels`, `embedder` (lazy designation read), `stopAll`, `makeGatingProvider(modelId, backend)`.
- `src/backend/hub.test.ts` — 24-test matrix; `makeScriptedSpawn` (spawns/modelProcs/failModelSpawns), `makeHub(over, scripted?)`, `entryOf` white-box, real `Bun.serve` chat stub.
- `src/routes/api.ts` — `ApiDeps.hub?` + `auth?`; `/api/models` branch (list, :id/status, activate, deactivate; 401 gate, 404/400/503 via `HubError.status`, per-endpoint 405s); workflows branch byte-identical.
- `src/routes/api.test.ts` — 6 new models tests (17/17 total).
- `src/main.ts` — hub constructed after registry, `preflight` → `restoreActive` before handlers; shared `makeAuthGate` for v1+api; non-null closures into `makeRuntimeServices`/`makeV1Handler`/`createWebServer`; `BootResult.shutdown` (+SIGINT/SIGTERM).
- `src/main.test.ts` — hermetic missing-binary boot, seeded-active error-state boot, script-binary clean boot + shutdown (4/4).
- `src/routes/v1.integration.test.ts` — NEW: 7 end-to-end tests (real hub + fake spawns + real Bun.serve stub).
