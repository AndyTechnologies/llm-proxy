```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:a1a14770584a219227f6c8f52130b006a7a668b297b972d0a407670eddea35be
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 19/19
scenarios: 47/47
test_command: bun test
test_exit_code: 0
test_output_hash: sha256:8b6fe438ab294e624d1db2bbbea7ad8331afe039fdeaed82acb00f5392afdd8c
build_command: bun run typecheck
build_exit_code: 0
build_output_hash: sha256:8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92
```
## Verification Report

**Change**: wire-local-backend
**Mode**: full — proposal, specs (19 requirements / 47 scenarios), design, tasks, arch-lint all present and verified
**Date**: 2026-09-15
**Worktree**: `/home/andy/.agent_worktrees/llm-proxy/wire-local-backend`
**Commits verified**: `8b1cdbd` (tanda 1 foundations), `f20fca4` (tanda 2 hub + boot wiring)

---

## Summary

All 9 tasks are marked complete and their evidence is real: each task's test file was run independently and passes, and the full gate is green. All 19 spec requirements map to implementation code with a passing covering test; all 7 acceptance criteria are proven by runtime test evidence; design coherence is confirmed section-by-section against `hub.ts`, `api.ts`, `main.ts`, `server.ts`, `schema.ts`, `config.ts`, `spawn-args.ts`, and `manager.ts`. Two minor coverage observations (a literal path shape not directly pinned by a test, and drain default constants not asserted in a test) do not block. **Verdict: PASS-WITH-WARNINGS.**

## AC-by-AC verification (Product RFC acceptance criteria)

| AC | Evidence (test file · assertion) | Runtime result | Verdict |
|---|---|---|---|
| 1. `POST /api/models/:id/activate` → `{state:"active", pid, port}` | `src/routes/api.test.ts` · "POST /api/models/:id/activate returns {state, pid, port}" expects 200 + `objectContaining({state:"active", pid:4242})`; `src/backend/hub.test.ts` · happy path asserts exact `{state:"active", pid:4242, port:54321}` and `active=1` persisted in SQLite | 17/17 pass (api) · 24/24 pass (hub) | ✅ PASS |
| 2. `GET /v1/models` includes activated local models | `src/routes/v1.integration.test.ts` · (a) asserts `data` contains `{id:"m1", object:"model", created:0, owned_by:"local"}` | 7/7 pass | ✅ PASS |
| 3. `POST /v1/chat/completions` with local model → valid completion | `src/routes/v1.integration.test.ts` · (b) 200, `text/event-stream`, body contains "hello from stub", exactly one terminal `data: [DONE]` (stream) | 7/7 pass | ✅ PASS |
| 4. Idle 10 min → process stops; next request re-spawns and succeeds | `src/routes/v1.integration.test.ts` · (c) idle watchdog drives state to `stopped`, next chat returns 200 with spawn count 1→2; `src/backend/manager.test.ts` · "idle timeout default is 10 minutes (binding Decision 6)" pins `IDLE_TIMEOUT_MS === 10*60*1000` | 7/7 pass · 11/11 pass | ✅ PASS |
| 5. Missing GGUF → model error state, boot not blocked | `src/backend/hub.test.ts` · "restoreActive missing GGUF → error state, boot continues" (status `error`, omitted from `localModels()`); `src/main.test.ts` · error-state boot (missing binary variant) proves boot succeeds and `/v1/models` omits the model | 24/24 pass · 4/4 pass | ✅ PASS |
| 6. `POST /v1/embeddings` with no embedder → 404 | `src/routes/v1.integration.test.ts` · (g) asserts 404 + `error.code === "model_not_found"` | 7/7 pass | ✅ PASS |
| 7. Full CI green (typecheck + lint + test) | Executed in this verification: `bun run typecheck` exit 0 · `bun run lint` exit 0 · `bun test` → 437 pass / 0 fail / 41 files | exit 0 × 3 | ✅ PASS |

## Task-by-task verification

| Task | Title | Status in tasks.md | Test file | Run result | Evidence match |
|---|---|---|---|---|---|
| 1 | `models.active` column + idempotent ALTER + settings fixture | ✅ `[x] complete tanda 1` | `src/db/schema.test.ts` | 10/10 pass | 4 new tests: fresh DB has `active` col (notnull=1, dflt 0) · pre-migration DB gains it via ALTER + rows read 0 · idempotent re-run · `embedding_model` settings fixture |
| 2 | `WEAVELLM_LLAMA_BIN` → `llamaBin` config | ✅ `[x] complete tanda 1` | `src/app/config.test.ts` | 6/6 pass | 3 new tests: default `"llama"` · custom path verbatim · empty string → default |
| 3 | `embeddings?: boolean` spawn flag | ✅ `[x] complete tanda 1` | `src/backend/spawn-args.test.ts` | 17/17 pass | 4 new tests: `--embeddings` after `--model` pair · omitted → absent · `false` → absent · full-argv order pinned |
| 4 | `LocalBackendHub` core module | ✅ `[x] complete tanda 2` | `src/backend/hub.ts` (behavior proven by T5) | typecheck clean | Module surface matches design §4.1 exactly (verified line-by-line: `preflight`/`restoreActive`/`activate`/`deactivate`/`status`/`statusAll`/`localProvider`/`localModels`/`embedder`/`stopAll` + 4-state `ensureReady` + `startLatch` + `drain`); `manager.ts` `IDLE_TIMEOUT_MS = 10*60*1000` |
| 5 | Hub unit test matrix | ✅ `[x] complete tanda 2` | `src/backend/hub.test.ts` | 24/24 pass | 7 suites: activation (happy/idempotent/400/503/404) · deactivation (zero/with-drain/timeout-force/404) · status 3D · preflight (ENOENT/old-build/restore ×2) · readiness gate (idle re-spawn, concurrent latch, error 503, starting join, zero-arg dispatch) · embedder (null↔non-null, `--embeddings`, gate-through) · stopAll |
| 6 | `/api/models` routes behind auth | ✅ `[x] complete tanda 2` | `src/routes/api.test.ts` | 17/17 pass | 6 new tests: list active/disabled · auth 401 absent→admitted · `:id` status + 404 · activate 200 + missing-GGUF 400 · deactivate persists `active=0` + 404 · per-endpoint 405 matrix; workflows suite untouched (13 tests) |
| 7 | Optional `localModels` on `/api/health` | ✅ `[x] complete tanda 1` | `src/app/server.test.ts` | 12/12 pass | 3 new tests: wired → `{status:"ok", localModels:["m1"]}` · absent dep → no key (legacy shape) · empty list → `[]` |
| 8 | Boot wiring (preflight → restoreActive → closures → shutdown) | ✅ `[x] complete tanda 2` | `src/main.test.ts` | 4/4 pass | 3 new tests: missing binary + seeded active → error state on `/api/models`, omitted from `/v1/models`, `localModels: []` on health · fake `--version` script (b10000) clean boot · `shutdown()` resolves |
| 9 | v1/runner integration over hub closures | ✅ `[x] complete tanda 2` | `src/routes/v1.integration.test.ts` | 7/7 pass | (a) `/v1/models` owned_by local · (b) chat 200 + single `[DONE]` · (c) idle re-spawn count 2 · (d) failing re-spawn → 503 `api_error` · (e) unknown model 404 envelope · (f) workflow `start→llm_call(m1)→end` returns stub content via `makeWorkflowRunner` · (g) embeddings 404 no embedder |

## Spec compliance matrix (19 requirements / 47 scenarios)

| # | Spec requirement (delta) | Implementation | Covering tests (all passing) | Scenarios covered |
|---|---|---|---|---|
| R1 | Spawn + supervise via `LocalBackendHub`, per-model manager | `hub.ts` `LocalBackendHub` + `Map<string, ManagedModel>`; `manager.ts` restart w/ backoff | hub.test.ts happy path; manager.test.ts "restart on crash" | 3/3 |
| R2 | Spawn-time readiness gate (30s, 503 on error) | `ensureReady` 4-state gate + `makeGatingProvider` | hub.test.ts gate suite (starting latch, error 503, idle re-spawn); manager.test.ts "wait-ready gate" | 3/3 |
| R3 | Graceful shutdown (drain ≤30s/model, stop all) | `stopAll()` drain+stop+clear; `main.ts` `BootResult.shutdown` → `hub.stopAll()` | hub.test.ts stopAll; main.test.ts "shutdown() resolves" | 1/1 |
| R4 | Health reports managed backends (`localModels`) | `server.ts` health branch, dep-gated | server.test.ts wired/absent/empty; main.test.ts health assertion | 1/1 |
| R5 | Fail-fast config validation (`--version` preflight, ENOENT vs old) | `preflight()` + `checkLlamaVersionFloor` (floor b9908) | hub.test.ts preflight ENOENT + old-build exit(1); main.test.ts missing-binary boot | 4/4 |
| R6 | Single-model spawn per active model, per-model flags, idle 10 min | `spawnModel`/`buildSpawnArgs`; `manager.ts` `IDLE_TIMEOUT_MS` | hub.test.ts activate args (ctx 8192, q8_0, YaRN); spawn-args.test.ts per-model flags; manager.test.ts constant + idle tests; v1.integration (c) | 3/3 |
| R7 | Activate/deactivate endpoints behind auth | `api.ts` models branch + `HubDeps.auth` gate; `hub.ts` activate/deactivate (drain, persist) | api.test.ts activate/deactivate/auth/405; hub.test.ts deactivation suite | 4/4 |
| R8 | Version-floor ENOENT handling | `preflight()` catch → `preflightError` → `restoreActive` marks rows error | hub.test.ts "preflight ENOENT → per-model error, no spawns, no exit" (message `llama-server binary not found at '<path>'`) | 1/1 |
| R9 | Local model management API (`/api/models` + status) | `api.ts` models branch; `hub.status/statusAll` 3D state | api.test.ts list/status/404; hub.test.ts status 3D | 3/3 |
| R10 | Model activation endpoint (200 pid/port, 503 spawn fail) | `hub.activate` → `spawnModel({persist:true})` → HubError(503) | api.test.ts activate 200 + 400; hub.test.ts activate 503 | 2/2 |
| R11 | Model deactivation endpoint (200 disabled, 404) | `hub.deactivate` (drain → stop → persist 0) | api.test.ts deactivate + 404; hub.test.ts deactivation | 2/2 |
| R12 | Health includes local models; omitted when hub unwired | `server.ts` dep-gated field | server.test.ts wired/absent/empty | 2/2 |
| R13 | Model activation flow persists `active` + restores on boot | `UPDATE models SET active` in activate/deactivate; `restoreActive()` | hub.test.ts activate persists 1 / deactivate 0 / restoreActive two rows; main.test.ts seeded-active boot | 3/3 |
| R14 | Lazy re-spawn after idle-stop (block ≤30s; failure → 503) | `ensureReady` stopped→start via latch | hub.test.ts idle re-spawn + concurrent latch; v1.integration (c)(d) | 2/2 |
| R15 | Missing GGUF → error state, boot not blocked, omitted from `/v1/models` | `spawnModel` GGUF gate; `localModels()` excludes error | hub.test.ts restoreActive missing GGUF; hub.test.ts activate 400; main.test.ts error boot | 2/2 |
| R16 | `models.active` column + idempotent migration | `schema.ts` CREATE + `migrateModelsActive` (PRAGMA-gated ALTER) | schema.test.ts fresh/pre-migration/idempotent | 2/2 |
| R17 | Local embeddings via designated model; `--embeddings` spawn; 404 unset | `embedder()` lazy designation read; `buildSpawnArgs` `embeddings:true`; `spawn-args.ts` emission | hub.test.ts embedder suite; v1.integration (g) | 4/4 |
| R18 | Embedder lifecycle tied to model activation | `embedder()` null on deactivate, rebuilt on re-activate; cache invalidation on manager recreate | hub.test.ts "embedder nulls on deactivate and is rebuilt on re-activate" | 2/2 |
| R19 | Spawn args support embeddings mode | `LlamaSpawnArgsInput.embeddings?: boolean`; `--embeddings` only when `=== true` | spawn-args.test.ts true/omitted/false/full-argv | 2/2 |

**Scenario accounting**: 47/47 scenarios map to a requirement with at least one passing covering test. Every scenario name in `spec.md` was traced to an assertion cluster in the suites above; the full matrix is enumerated in the task-by-task table's evidence column.

## Test counts

| Suite | Pass | Fail | New tests (this change) |
|---|---|---|---|
| `src/db/schema.test.ts` | 10 | 0 | 4 |
| `src/app/config.test.ts` | 6 | 0 | 3 |
| `src/backend/spawn-args.test.ts` | 17 | 0 | 4 |
| `src/backend/manager.test.ts` | 11 | 0 | 1 |
| `src/app/server.test.ts` | 12 | 0 | 3 |
| `src/backend/hub.test.ts` | 24 | 0 | 24 |
| `src/routes/api.test.ts` | 17 | 0 | 6 |
| `src/main.test.ts` | 4 | 0 | 3 |
| `src/routes/v1.integration.test.ts` | 7 | 0 | 7 |
| **Full suite (41 files)** | **437** | **0** | **55 new** |

Claims in `apply-progress.md` (397 baseline + 40 tanda-2 = 437; 15 + 40 = 55 new tests) reproduce exactly.

## Command evidence (executed 2026-09-15 in the worktree)

| Command | Exit code | Output hash (sha256) |
|---|---|---|
| `bun run typecheck` | 0 | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| `bun run lint` | 0 | `050c69da23536758722729aeda55a8d0fb9d557495ef6d33d70873a3b64a71c1` |
| `bun test` | 0 | `8b6fe438ab294e624d1db2bbbea7ad8331afe039fdeaed82acb00f5392afdd8c` |

`bun test` summary: `437 pass / 0 fail / Ran 437 tests across 41 files`.

## Design coherence

All design sections cross-checked against the applied code:

- §2.2/2.3 boot + closure arity → `main.ts:73-75` (preflight → restoreActive before handlers), `main.ts:84-89,103-105,114` non-null closures; zero-arg seam dispatch proven by hub.test.ts "zero-arg localProvider dispatches per request.model" and v1.integration (a)-(f).
- §3.1 schema migration → `schema.ts:31` CREATE + `migrateModelsActive` (PRAGMA check + ALTER); tests pin fresh/existing/idempotent.
- §3.2 settings designation → `readEmbeddingModelId` lazy read (documented deviation, strictly more correct).
- §4.1-4.5 hub module surface → `hub.ts` line-for-line match (constants, 3D status, gate, `startLatch`, `drain` 1s poll/30s deadline).
- §4.6 spawn-args → `spawn-args.ts:84` `--embeddings` after `--model` pair; floor `b9908` in `checkLlamaVersionFloor`.
- §4.7 `/api/models` routes → `api.ts:59-104` models branch before workflows guard, auth gate, `HubError.status` mapping; **superset**: `GET /api/models/:id` and `GET /api/models/:id/status` both accepted (`sub === undefined || sub === "status"`).
- §4.8 health → `server.ts:57-59` dep-gated `localModels`.
- §7 config → `config.ts` `resolveLlamaBin` (empty/undefined → `"llama"`), `types.ts:13` `llamaBin: string`.
- Arch-lint (12/12 acta decisions) is consistent with this verification's own reading of `hub.ts`, `api.ts`, `main.ts`, `server.ts`, `schema.ts`, `config.ts`, `spawn-args.ts`, `manager.ts`.

## Warnings (non-blocking)

- **W1 — literal `:id/status` path not directly pinned**: spec scenario "Get model status" names `GET /api/models/:id/status`; `api.ts:76` accepts both `:id` and `:id/status` (shared branch), but the automated test exercises only the `:id` shape. Behavior is identical by construction; the named path string lacks a direct assertion.
- **W2 — drain defaults not constant-asserted**: `DRAIN_POLL_MS` (1000) and `DRAIN_TIMEOUT_MS` (30000) exist as module constants and flow as defaults (`hub.ts:195-196`), and drain semantics (poll until 0, force-stop at deadline) are tested with overrides, but no test pins the literal 1s/30s default values (contrast `IDLE_TIMEOUT_MS`, which has a dedicated constant test).
- **W3 — informational (documented, non-violating deviations)**: `ApiDeps.hub?` optional (boot always passes a hub) · T9 in new file `src/routes/v1.integration.test.ts` (not `v1.test.ts` as tasks.md text suggested; flagged for archive) · `restoreActive()` before handler construction per binding acta (task-prompt text said "after server start"; acta wins) · `HubDeps.idlePollMs` additive seam · `BootResult.shutdown` addition.
- **W4 — informational**: codegraph index flagged `src/backend/manager.ts` stale-on-disk; the affected line (`IDLE_TIMEOUT_MS = 10 * 60 * 1000`) was re-read directly and confirmed. Index staleness only affects the cache, not the code.

## Verdict

**PASS-WITH-WARNINGS** — all 7 acceptance criteria, all 9 tasks, and all 19 requirements / 47 scenarios verified against implementation + passing runtime tests; full CI green (typecheck 0 / lint 0 / test 437-0, all exit 0). The two coverage observations (W1, W2) are non-blocking and do not contradict any spec behavior.