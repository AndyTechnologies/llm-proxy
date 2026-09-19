# Tasks: wire-local-backend

TDD breakdown of the `wire-local-backend` change into 9 testable work units.
Consumes `spec.md` (delta specs), `design.md` (binding shape), `arch-plan.md`
(12 binding decisions), and `proposal.md` (scope + acceptance criteria).

Worktree: `/home/andy/.agent_worktrees/llm-proxy/wire-local-backend`
Gate: `bun run typecheck && bun run lint && bun test` must stay green after
every task.

---

## Task 1 — Add `models.active` column with idempotent ALTER <!-- [x] complete tanda 1 -->
- [x] complete tanda 1

- **id**: 1
- **title**: Add `active` column migration and `embedding_model` settings convention
- **spec**: local-model-catalog "Active column in SQLite models table" (fresh DB has column; existing DB gets migration); embeddings-rag "Local embeddings" (settings row `embedding_model` designation mechanism — no schema change, convention + fixture only).
- **design**: §3.1 (column in `MODELS_TABLE` + PRAGMA-checked ALTER), §3.2 (settings row read contract for the hub; no DDL).
- **files**:
  - modified: `src/db/schema.ts` — `MODELS_TABLE` gains `active INTEGER NOT NULL DEFAULT 0`; `applySchema` runs the idempotent migration (`PRAGMA table_info(models)` → `ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0` when absent).
  - modified: `src/db/schema.test.ts` — new migration tests.
- **test**: `src/db/schema.test.ts` asserts (a) fresh DB: `PRAGMA table_info(models)` includes `active` with `notnull=1` and `dflt_value=0`; (b) existing DB: a `models` table created *without* `active` (pre-migration shape) gets the column after `applySchema` and existing rows read `active=0`; (c) idempotency: running `applySchema` twice is a no-op (no error, column unchanged). Plus one fixture-style test: the `settings` table accepts an `embedding_model` row via `INSERT OR REPLACE` and reads back the value (the hub consumes it at construction, Task 4).
- **dependency**: none (foundation).
- **risk**: low — read-only PRAGMA + single atomic ALTER in WAL mode; migration test covers fresh/existing/idempotent.
- **commands**:
  - Start: `bun test src/db/schema.test.ts` (write the failing migration tests first — TDD red).
  - Verify: `bun test src/db/schema.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 2 — Add `llamaBin` to app config from new env var <!-- [x] complete tanda 1 -->
- [x] complete tanda 1

- **id**: 2
- **title**: Add `WEAVELLM_LLAMA_BIN` → `llamaBin` config
- **spec**: backend-management "Fail-fast config validation at startup" (binary path validated at boot); proposal §5. Binding arch-plan Decision 10.
- **design**: §7 (config delta: `AppEnv.WEAVELLM_LLAMA_BIN?: string`, `AppConfig.llamaBin: string`, resolve with empty-string fallback to `"llama"`).
- **files**:
  - modified: `src/app/config.ts` — `AppEnv` field + `resolveAppConfig` resolution (mirror the `resolvePort` empty-string fallback pattern).
  - modified: `src/app/types.ts` — `AppConfig.llamaBin: string`.
  - modified: `src/app/config.test.ts` — new tests.
- **test**: `src/app/config.test.ts` asserts (a) default: `resolveAppConfig({})` → `llamaBin === "llama"`; (b) custom: `WEAVELLM_LLAMA_BIN: "/opt/llama/bin/llama-server"` → propagated verbatim; (c) empty string: `WEAVELLM_LLAMA_BIN: ""` → falls back to `"llama"`.
- **dependency**: none (foundation).
- **risk**: low — additive field, no existing behavior touched.
- **commands**:
  - Start: `bun test src/app/config.test.ts` (red first).
  - Verify: `bun test src/app/config.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 3 — Support `--embeddings` in spawn args <!-- [x] complete tanda 1 -->
- [x] complete tanda 1

- **id**: 3
- **title**: Add `embeddings?: boolean` spawn flag
- **spec**: embeddings-rag "Spawn args support embeddings mode" (flag present when true; absent when omitted/false).
- **design**: §4.6 (`LlamaSpawnArgsInput.embeddings?: boolean`; `buildLlamaSpawnArgs` pushes `--embeddings` after the `--model` pair when `=== true`; deterministic order).
- **files**:
  - modified: `src/backend/spawn-args.ts` — interface field + arg emission.
  - modified: `src/backend/spawn-args.test.ts` — new tests (flag present, omitted, false); existing arg-order assertions stay green (flag must not disturb the current order).
- **test**: `src/backend/spawn-args.test.ts` asserts (a) `{ modelPath, embeddings: true }` → args include `--embeddings` immediately after the `--model <path>` pair; (b) `embeddings` omitted → absent; (c) `embeddings: false` → absent; (d) existing flags (`--ctx-size`, `--cache-type-k`, `--port 0 --host 127.0.0.1`) unchanged with the new field set.
- **dependency**: none (foundation).
- **risk**: low — pure function, single append.
- **commands**:
  - Start: `bun test src/backend/spawn-args.test.ts` (red first).
  - Verify: `bun test src/backend/spawn-args.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 4 — Implement `LocalBackendHub` lifecycle orchestrator <!-- [x] complete tanda 2 -->
- [x] complete tanda 2

- **id**: 4
- **title**: Implement LocalBackendHub core module
- **spec**: backend-management (spawn+supervise via hub, readiness gate, 10-min idle-stop, preflight fail-fast ENOENT-vs-old, 503 propagation, in-flight drain on deactivation, per-model manager map); local-model-catalog (activation flow, lazy re-spawn, missing GGUF error state, `active` persistence, restore at boot); embeddings-rag (embedder lifecycle, `--embeddings` spawn for the designated model). Binding decisions D1, D3–D8.
- **design**: §2.1 (facade/proxy/factory), §2.3 (closure-arity: `localProvider(modelId?: string)` dispatching per `request.model` — zero-arg seam calls are the runtime reality), §3.3 (write paths), §4.1–4.5 (module spec), §5 (request flows), §6 (error table incl. 503-vs-502 distinction).
- **files**:
  - new: `src/backend/hub.ts` — `ModelStatus`, `HubError`, `HubDeps`, `ManagedModel`, `LocalBackendHub` (`preflight`, `restoreActive`, `activate`, `deactivate`, `status`, `statusAll`, `localProvider`, `localModels`, `embedder`, `stopAll`), `HUB_IDLE_TIMEOUT_MS = 10 * 60 * 1000`, `DRAIN_POLL_MS = 1000`, `DRAIN_TIMEOUT_MS = 30_000`, `DEFAULT_REQUEST_TIMEOUT_MS = 300_000`, binary-unavailable helper. `ensureReady` implements the four-state gate with `startLatch` serialization; `spawnModel` shared by `activate()`/`restoreActive()`.
  - modified: `src/backend/manager.ts` — `IDLE_TIMEOUT_MS` 5 min → 10 min (binding Decision 6); `watchIdle`/`noteRequest` unchanged (already consume `idleTimeoutMs`).
  - modified: `src/backend/manager.test.ts` — update the constant assertion (`IDLE_TIMEOUT_MS === 10 * 60 * 1000`) and any timer tests that referenced 5 min.
- **test**: behavior proof is the Task 5 matrix (`hub.test.ts`); within this task the gate is `bun run typecheck` (module + fakes compile, no `any`) and the updated `manager.test.ts` (10-min idle constant + idle behavior with the new default). Keep the `chatStream` `this` capture correct (self-binding arrow) — the Task 5 streaming tests depend on it.
- **dependency**: Task 1 (schema: `active` column semantics + `settings` reads), Task 3 (type-level `embeddings` field in `LlamaSpawnArgsInput`).
- **risk**: high — largest module; concurrency semantics (startLatch re-spawn race, drain deadline, manager state transitions) must match design §4.3/§4.2 exactly.
- **commands**:
  - Start: `bun run typecheck` (baseline) — implement `hub.ts`, fold in the `manager.ts` constant change + `manager.test.ts` updates.
  - Verify: `bun test src/backend/manager.test.ts` && `bun run typecheck`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 5 — Test LocalBackendHub orchestration with fakes <!-- [x] complete tanda 2 -->
- [x] complete tanda 2

- **id**: 5
- **title**: Write hub unit test matrix
- **spec**: scenario coverage for backend-management (activate happy/idempotent/404, spawn failure 503, readiness gate 4 states, drain + 30s timeout, preflight ENOENT vs fail-fast, restart), local-model-catalog (missing GGUF non-blocking, lazy re-spawn), embeddings-rag (embedder null→non-null→null, gate-through). Binding decisions D1, D3–D8 proof.
- **design**: §8.1 (fake table: seeded `SpawnedProc`/`now`/`sleep`/`healthCheck`/`exit` sentinel/`:memory:` db), §8.2 (full matrix).
- **files**:
  - new: `src/backend/hub.test.ts` — fake `SpawnFn` (scripted stdout chunks: `listening on 127.0.0.1:PORT`, then settle; `{code:"ENOENT"}` throw for preflight), deterministic `now`, no-op `sleep`, scripted `healthCheck`, sentinel `exit`, `":memory:"` `Database` seeded via `applySchema`.
  - assertion clusters (from design §8.2): activate happy path (args: GGUF/ctx/KV; `active=1` persisted; `{state,pid,port}`), activate idempotent (spawnFn called once), activate missing GGUF (`HubError(400)` naming the file, no spawn, no DB write), activate spawn failure (`HubError(503)`, `lastError` set), activate unknown id (`HubError(404)`); deactivate zero in-flight / with drain / drain-timeout force-stop / unknown 404; preflight ENOENT (per-model error, no spawn, no exit) / old-binary (sentinel exit(1)) / current (proceeds); restoreActive two models (spawn count + `localModels()`), missing GGUF at restore (errors map, omitted from `localModels()`); wrapper idle re-spawn (stopped → `start()` → success), wrapper error → `status === 503`, wrapper starting → joins latch until health flips; concurrent stopped hits → one spawn (latch serialization); `localModels()` filters error, keeps stopped; embedder null→non-null→null (settings designation + deactivate + re-activate); embed-through-gate lazy re-spawn; `stopAll()` drains + stops + empties map.
- **test**: the matrix itself is the deliverable (`bun test src/backend/hub.test.ts` green, all rows).
- **dependency**: Task 4 (module under test).
- **risk**: medium — fake harness fidelity (port-parse chunk ordering, latch races, drain clock) is the main failure mode; mirror `manager.test.ts` fake patterns.
- **commands**:
  - Start: `bun test src/backend/hub.test.ts` (red: file absent/matrix unwritten).
  - Verify: `bun test src/backend/hub.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 6 — Wire `/api/models` management routes behind auth <!-- [x] complete tanda 2 -->
- [x] complete tanda 2

- **id**: 6
- **title**: Add /api/models route group to ApiDeps
- **spec**: dashboard-api "Local model management API" (list with 3D state, status, unknown 404), "Model activation endpoint" (200 with pid/port; 503 on spawn failure), "Model deactivation endpoint" (200 disabled; unknown 404); backend-management "Activate and deactivate endpoints" (all management endpoints behind the existing auth gate).
- **design**: §4.7 (`ApiDeps.hub: LocalBackendHub` + `auth?: (req) => Promise<boolean>`; `parts[1] === "models"` branch before the `workflows` guard; whole branch gated → 401; `HubError.status` maps straight to the response; the existing `/api/workflows` surface keeps its current ungated behavior).
- **files**:
  - modified: `src/routes/api.ts` — `ApiDeps` gains `hub` + `auth`; `makeApiHandler` gains the `/api/models` branch (GET list → `statusAll()`, GET `:id/status` → 200|404, POST `:id/activate` → 200|`HubError` status (400/404/503), POST `:id/deactivate` → 200|404); auth gate applied to the models branch only.
  - modified: `src/routes/api.test.ts` — new suite sections; the existing `/api/workflows` tests must stay green untouched.
- **test**: `src/routes/api.test.ts` builds a real `LocalBackendHub` over a `":memory:"` db with fake `spawnFn`/`healthCheck`/`sleep` (reusing the Task 5 harness shape) and asserts: GET `/api/models` → 200 array of `ModelStatus` with `id`/`state` (mixed active/disabled/error); GET `:id/status` → 200 `{id, state, pid?, port?}`; GET unknown `:id/status` → 404 envelope; POST `:id/activate` → 200 `{state:"active", pid, port}`; POST activate on spawn failure → 503; POST activate unknown → 404; POST `:id/deactivate` → 200 `{state:"disabled"}`; POST deactivate unknown → 404; auth enabled → 401 on the models branch; auth absent → admitted; `/api/workflows` behavior unchanged.
- **dependency**: Task 4 (hub type + shape), Task 5 (hub fake harness validated before the routes reuse it).
- **risk**: medium — auth-gate branching + `HubError` status mapping are the subtle spots; keep the workflows branch byte-identical.
- **commands**:
  - Start: `bun test src/routes/api.test.ts` (red: new sections fail against the current handler).
  - Verify: `bun test src/routes/api.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 7 — Add optional `localModels` to `/api/health` <!-- [x] complete tanda 1 -->
- [x] complete tanda 1

- **id**: 7
- **title**: Extend health endpoint with localModels field
- **spec**: dashboard-api "Health endpoint includes local models" (field present listing active+healthy ids; field absent when the hub is not wired).
- **design**: §4.8 (`ServerDeps.localModels?: () => string[]`; health branch conditionally attaches `body.localModels = deps.localModels()`; field only when the dep is defined).
- **files**:
  - modified: `src/app/server.ts` — `ServerDeps` field + `buildFetchHandler` health branch.
  - modified: `src/app/server.test.ts` — new tests.
- **test**: `src/app/server.test.ts` asserts (a) `buildFetchHandler({..., localModels: () => ["m1"]})` → `GET /api/health` returns `{status:"ok", localModels:["m1"]}`; (b) without `localModels` → `{status:"ok"}` with no `localModels` key (legacy shape preserved); (c) empty list → `localModels: []` present (hub wired, no healthy models).
- **dependency**: none (self-contained additive field; boot wiring in Task 8 consumes it).
- **risk**: low — additive optional field; legacy response shape untouched when the dep is absent.
- **commands**:
  - Start: `bun test src/app/server.test.ts` (red first).
  - Verify: `bun test src/app/server.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 8 — Wire hub into boot (preflight → restoreActive → non-null closures) <!-- [x] complete tanda 2 -->
- [x] complete tanda 2

- **id**: 8
- **title**: Integrate hub into main.ts boot path
- **spec**: backend-management "Fail-fast config validation at startup" (preflight runs at boot; ENOENT → per-model error, boot continues; active models restored on boot), "Health and status reporting" (health reports managed backends); dashboard-api health wiring; binding arch-plan Decision 2 (boot order: DB → config → secretStore → registry → `hub.preflight()` → `hub.restoreActive()` → services/v1/api with non-null closures → server → start).
- **design**: §2.2 (boot sequence + closure wiring shape), §4.2 (`preflight`/`restoreActive` call sites), §7 (`config.llamaBin` → `HubDeps.binary`).
- **files**:
  - modified: `src/main.ts` — construct `LocalBackendHub` with `config.llamaBin` (and default `Bun.spawn`-based deps); `await hub.preflight()` then `await hub.restoreActive()` **before** handler construction; `makeRuntimeServices` receives `localProvider: (id) => hub.localProvider(id)`, `localModels: () => hub.localModels()`, `embedder: hub.embedder()`; `makeV1Handler` receives the same closures; `makeApiHandler` receives `hub`; build one `makeAuthGate` instance shared by v1 and api; `createWebServer` receives `localModels: () => hub.localModels()`; remove the stale "local ids do not resolve" comment (main.ts lines ~66–69).
  - modified: `src/main.test.ts` — boot-level tests.
- **test**: `src/main.test.ts` adds: (a) boot with `WEAVELLM_LLAMA_BIN` pointing at a non-existent path + a seeded `models` row (`active=1`) → boot succeeds, `GET /api/models` reports the model in `error` state with the "binary not found" message, `/v1/models` omits it, `/api/health` includes the `localModels` field (hub wired); (b) boot with `WEAVELLM_LLAMA_BIN` pointing at a temp executable script that prints a valid build tag (`b10000`) and no active models → clean boot (preflight passes, restore is a no-op); (c) existing workflow CRUD + gateway run + wss tests stay green (regression proof that the non-null closures did not break the chain/v1 paths). DB seeding uses the `db` handle returned by `boot()`.
- **dependency**: Task 1 (active column + schema), Task 2 (config `llamaBin`), Task 4 (hub module), Task 6 (`ApiDeps.hub`), Task 7 (`ServerDeps.localModels`).
- **risk**: medium — boot ordering regressions and the real-boot test constraints (no real llama-server; ENOENT-path and fake-`--version`-script tests are the safe seams); the stale-comment removal must land here or typecheck/lint review flags it.
- **commands**:
  - Start: `bun test src/main.test.ts` (red: new boot tests fail against the null-closure boot).
  - Verify: `bun test src/main.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Task 9 — Prove the local chat path end-to-end through v1 and the runner <!-- [x] complete tanda 2 -->
- [x] complete tanda 2

- **id**: 9
- **title**: Add v1/runner integration tests over hub closures
- **spec**: backend-management "Request during spawn blocks on readiness" (request blocks then proceeds), "Spawn failure enters error state" (503); local-model-catalog "Lazy re-spawn after idle-stop" (request after idle-stop re-spawns; re-spawn failure → 503); proposal acceptance criteria 2 (`/v1/models` includes activated local models) and 3 (`POST /v1/chat/completions` with a local model ID returns a valid completion).
- **design**: §2.3 (closure-arity: zero-arg `localProvider()` seam call returns the per-request wrapper; `localModels()` membership gates), §5.2/5.3 (chat flow via wrapper gate → backend forward; idle re-spawn), §8.2 (CI gate: `bun test` stays green with the new coverage).
- **files**:
  - modified: `src/routes/v1.test.ts` — new describe block wiring a real `LocalBackendHub` (fake `spawnFn` emitting a `listening on 127.0.0.1:<port>` line for a stub port, fake `healthCheck` true) + a local `Bun.serve` stub answering `/v1/chat/completions` (canned completion) and `/health` on the stub port. Build `makeV1Handler` with hub closures (`localProvider: () => hub.localProvider()`, `localModels: () => hub.localModels()`) and `makeRuntimeServices`/`makeWorkflowRunner` with the same closures.
  - optional: tiny shared helper inside the test file for the stub backend (do not add production code for tests).
- **test**: asserts (a) `GET /v1/models` includes the activated local model id (owned_by "local") once `restoreActive`/`activate` ran; (b) `POST /v1/chat/completions` with the local id → 200 with the stub's canned content (non-stream) and the OpenAI-wire SSE shape with exactly one `[DONE]` (stream); (c) idle-stopped manager → request triggers `start()` (spawnFn count increments) then 200; (d) error-state entry → 503 through `providerError`; (e) unknown local id → 404 envelope unchanged; (f) runner: a workflow `llm_call` node targeting the local model returns the stub content via `makeWorkflowRunner` (`localProvider`/`localModels` closures from the hub).
- **dependency**: Task 4 (hub + wrapper semantics), Task 5 (fake harness validated; reuse the seeded-proc pattern).
- **risk**: medium — the stub `Bun.serve` port must match the seeded listening line; stream-shape assertions must respect the existing SSE contract (terminal chunk).
- **commands**:
  - Start: `bun test src/routes/v1.test.ts` (red: no local-model coverage in the current suite).
  - Verify: `bun test src/routes/v1.test.ts`
  - Finish: `bun run typecheck && bun run lint && bun test`

---

## Review Workload Forecast

- **Estimated changed lines**: ~1,400–1,500 (incl. tests). Dominated by `src/backend/hub.ts` (~350–400 new) and `src/backend/hub.test.ts` (~500–550 new); the remaining ~500 spans schema/config/spawn-args/manager deltas, `api.ts` route group (~55) + tests (~120), `server.ts` health (~8) + tests (~30), `main.ts` boot (~30) + tests (~60–80), `v1.test.ts` integration (~80–100).
- **400-line budget risk**: **High** — the change is ~3.5–4× a 400-line review slice in one PR.
- **Chained PRs recommended**: **Yes** — slice along task groups: PR1 Foundations (Tasks 1, 2, 3, 7 + the `manager.ts` constant piece of Task 4, ~250 lines); PR2 Hub core (Task 4 `hub.ts`, ~390 lines — at the budget); PR3 Hub test matrix (Task 5, ~550 lines — split into lifecycle-half and wrapper-half PRs if the reviewer prefers stricter slices); PR4 Wiring + integration (Tasks 6, 8, 9 incl. their tests, ~400 lines).
- **Decision needed before apply**: **Yes** — (1) confirm the chained-PR slice boundaries and merge order above (or the reviewer's preferred alternative); (2) whether `hub.test.ts` (Task 5) ships as one PR or two halves (lifecycle: activate/deactivate/preflight/restore vs wrapper: gate/race/embedder/stopAll); (3) minor: Task 9's stub backend lives inside `v1.test.ts` (recommended) vs a shared test helper file. No code-shape decision is open — arch-plan.md remains the binding acta.