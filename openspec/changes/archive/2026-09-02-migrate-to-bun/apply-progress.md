# Apply Progress — migrate-to-bun (P0 + S1)

**Change**: migrate-to-bun
**Batch**: P0 (chained-PR slice 1 of 5) — first batch (no prior apply-progress existed)
**Mode**: Strict TDD (bun:test, `bun test`)
**Store**: hybrid (OpenSpec file + Engram `sdd/migrate-to-bun/apply-progress`)
**Chain strategy**: feature-branch-chain (user override; tracker `migrate-to-bun`, PR #1 targets tracker)
**Date**: 2026-09-01

## Status

P0 tasks **6/6 complete**. P0 parity gate **PASSED** (Express 5 on Bun 1.4.0, archived smoke matrix identical). Ready for S1.

## Task Completion

| Task | Status | Notes |
|------|--------|-------|
| P0.1 bun install + lockfile swap + dep removal | ✅ | `bun.lock` (migrated from pnpm), `pnpm-lock.yaml`+`pnpm-workspace.yaml` deleted; removed dotenv/js-yaml/tsx/@types/node/@types/js-yaml; added `@types/bun`; `engines` → `bun >=1.4`. Remaining `@types/node` in bun.lock are transitive (required by `@types/express` and `bun-types` for node-compat typing) — direct dep removed. |
| P0.2 scripts | ✅ | `dev: bun run --watch src/index.ts`; `build: bun build src/index.ts --outdir dist`; `start: bun run src/index.ts`; `test: bun test`; `typecheck: tsc --noEmit` and `lint: eslint .` kept. |
| P0.3 RED test suite | ✅ | `src/config/load.test.ts` — 13 bun:test cases. CORRECTION (deviation): see below — `mock.module("bun")` replaced by injected `LoaderDeps` fakes. All 13 tests written before GREEN implementation. |
| P0.4 GREEN Bun-native load | ✅ | `src/config/load.ts` → `Bun.file(path).text()` + `Bun.YAML.parse` (NOT `Bun.file().yaml()` — does not exist, ADR-5), JSON via `JSON.parse`; `src/config/index.ts` drops `dotenv/config`, honors `CONFIG_FILE`, zod unchanged, same error strings; `src/index.ts` awaits the now-async loader. |
| P0.5 REFACTOR | ✅ | Error strings extracted as `ERR_CONFIG_NOT_OBJECT` / `ERR_CONFIG_NOT_FOUND` / `ERR_UNSUPPORTED_EXT` constants; `tsc --noEmit` exit 0; tests still green. |
| P0.6 P0 parity gate | ✅ PASSED | Express 5 on Bun: boot order, /health, /v1/models, chat+completions non-stream, 404/400/401 shapes, single [DONE] SSE, SIGTERM drain. Full evidence below. |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| P0.3–P0.5 (config-load) | `src/config/load.test.ts` | Unit | N/A (new suite — runner bootstrapped this batch) | ✅ Written first: 13 cases referencing async Bun-native API (initial run: 0 pass / 12 fail for load; suite grew to 13 with DI pivot) | ✅ `bun test src/config/load.test.ts` → 13 pass / 0 fail | ✅ 2+ cases per behavior: .yaml/.yml/.json, scalar+null rejection (2), missing+unsupported-ext (2), CONFIG_FILE/default/explicit (3), zod fail/pass (2) | ✅ Error constants extracted; tests re-run 13/13; tsc 0 |
| P0.6 parity gate | runtime harness (bash) | E2E/Integration | N/A (new) | N/A (verification gate, not unit behavior) | ✅ See Work Unit Evidence | N/A | N/A |

## Work Unit Evidence

| Work unit | Focused test command + exact result | Runtime harness + exact result | Rollback boundary |
|-----------|------------------------------------|-------------------------------|-------------------|
| WU1 — Bun bootstrap (P0.1–P0.2) | `bunx tsc --noEmit` → exit 0 | `bun install` → migrated lockfile, 142 packages, `Removed: 5`; `bun --version` 1.4.0 | revert `package.json` + `bun.lock`; restore `pnpm-lock.yaml` + `pnpm-workspace.yaml` |
| WU2 — config load (P0.3–P0.5) | `bun test src/config/load.test.ts` → `13 pass / 0 fail` (14 expect) | `bun run src/index.ts` boots with Bun-native loader (config loaded: 6 chains; see parity) | revert `src/config/load.ts`, `src/config/index.ts`, `src/index.ts` await, `src/config/load.test.ts` |
| WU3 — lint gate (eslint TS parser) | `bunx eslint .` → exit 0 (previously failed parsing every .ts) | `bunx tsc --noEmit` exit 0 with `@types/bun` | revert `eslint.config.js` + the 2 stale inline-directive removals + typescript-eslint devDeps |
| WU4 — P0 parity gate (P0.6) | `bun test src/config/load.test.ts` + `tsc --noEmit` + `eslint .` all green before gate | See parity evidence below (live gateway + real llama-server router mode) | n/a (no code); evidence in `/tmp/opencode/parity/` |

## P0 Parity Gate Evidence (live, 2026-09-01)

Runtime: `bun src/index.ts`, real llama-server router mode (pid 74943), 4 GGUF models, config `llm-proxy.config.yaml`; auth instance `:8091` autoStart:false. Gateway pid 74916. Logs `gateway.log`, `gateway-sse.log`, `gateway-auth.log` + JSON captures in `/tmp/opencode/parity/`.

| Smoke | Result (Bun) | Archived parity |
|-------|--------------|-----------------|
| Boot order | line 32 `[manager] backend ready: pid=74943` BEFORE line 39 `[gateway] OpenAI-compatible API listening` | ✅ identical |
| GET /health | `{"status":"ok","chains":[6],"defaultChain":"orchestrator","backend":{"state":"running","pid":74943,"models":["SmolLM3-3B","Llama3.2-3B-Instruct","Qwen2.5-Coder-3B-Instruct","Phi-4-Mini-Instruct"]}}` | ✅ shape identical (archived report abbreviated models as `[4]`; code always emitted the names array — `Object.keys(config.models)`, verified at archived commit too) |
| GET /v1/models | `object:"list"`, 10 entries: 6 `gateway/*` (`owned_by:"gateway"`) + 4 real (`owned_by:"llama-server"`) | ✅ identical |
| POST /v1/chat/completions non-stream | `object:"chat.completion"`, content **"OLIVE"** (same word as archived run), `finish_reason:"stop"`, usage present, model Llama3.2-3B-Instruct | ✅ identical incl. content |
| POST /v1/completions non-stream | `object:"text_completion"`, `choices[0].text`, model SmolLM3-3B | ✅ identical |
| 404 unknown chain (`gateway/nope`) | HTTP 404 `{"error":{"message":"Chain \"nope\" not found","type":"invalid_request_error","param":"model","code":"model_not_found"}}` | ✅ byte-identical |
| 404 unknown real model (`No-Such-Model`) | HTTP 404 `{"error":{"message":"Model \"No-Such-Model\" not found","type":"invalid_request_error","param":"model","code":"model_not_found"}}` | ✅ byte-identical |
| 400 validation (temperature:"hot") | HTTP 400 `{"error":{"message":"Expected number, received string","type":"invalid_request_error","param":null,"code":"validation_error"}}` | ✅ identical |
| 400 validation (missing messages) | HTTP 400 `{"error":{"message":"Required","type":"invalid_request_error","param":null,"code":"validation_error"}}` | ✅ identical |
| 401 auth (missing token) | HTTP 401 `{"error":{"message":"Unauthorized","type":"authentication_error","param":null,"code":null}}` | ✅ identical |
| 401 auth (wrong token) | HTTP 401 same shape | ✅ identical |
| 401 auth (valid token) | HTTP 200 `{"object":"list","data":[]}` (autoStart:false instance) | ✅ passes |
| SSE single [DONE] | stream SmolLM3-3B max_tokens:8 → **exactly 1** `data: [DONE]`, one terminal chunk `finish_reason:"length"`, 9 data frames | ✅ identical (single [DONE]) |
| SIGTERM drain | `[gateway] shutting down (SIGTERM)` → `[manager] stopping backend (pid=74943)` → `backend stopped` → clean exit, no orphans | ✅ identical |

**Gate verdict: PASS.** Express 5 remains intact on Bun; no hard compat failure. Phase B fallback not needed.

## Deviations from Design / Tasks

1. **`mock.module("bun")` does not work** (tasks P0.3 literal instruction). Runtime-verified in Bun 1.4.0: `mock.module("bun", ...)` cannot intercept the builtin `bun` module — neither registered in-file (before/after import) nor via `--preload`, neither spread-replacement nor full-replacement; the real module is always served (all 5 experiment variants failed). Followed the design's own ADR-3 DI philosophy instead: `loadRawConfig(configPath, deps?)` / `loadGatewayConfig(configPath?, deps?)` with `LoaderDeps = { file, yamlParse }` defaulting to real Bun. Tests inject fakes. All spec scenarios covered; assertion-level intent of P0.3 preserved.
2. **eslint gate was broken pre-existing**: `eslint.config.js` had no TS parser → every `.ts` file was a parse error (28 errors + 2 warnings, incl. files untouched by this change). Since a working lint gate is a P0 deliverable, added `@typescript-eslint` (parser+plugin+meta 8.69, compatible with eslint 10), `argsIgnorePattern: "^_"` honoring the codebase's own `_`-prefix convention, kept `noInlineConfig` + `reportUnusedDisableDirectives`, and ignored generated `dist/`. Removed 2 stale inline `eslint-disable` comments (they conflicted with `noInlineConfig`). Gate now exits 0.
3. `bunfig.toml`: **not needed** — `bun test` works from workspace root with zero config (P0.4 "if needed" branch not triggered).
4. `dist/` contains stale Node-built JS from the pre-migration `tsc` build; not rebuilt in P0 (parity ran from source via `bun src/index.ts`). S3 rebuilds it via `bun build --outdir dist`.

## API Facts Confirmed (runtime)

- `Bun.file(path).yaml()` does NOT exist in Bun 1.4.0 (ADR-5) — used `Bun.YAML.parse(await Bun.file(path).text())`.
- `mock.module("bun")` cannot mock the builtin module (new fact, see deviations).
- `Bun.spawn` Subprocess has no `onExit` — supervision will use the `exited` Promise in S1; nothing introduced now.
- Bun spawn stdout is `Uint8Array` — decode before text matching (S1).

## Commits (feature-branch-chain, branch `feat/migrate-to-bun-p0`)

- `439c7ec` build(bun): bootstrap Bun as package manager and scripts
- `325f73f` feat(config): Bun-native config loading with unit tests
- `7f68589` build(lint): enable TypeScript parsing in the eslint gate

Tracker branch `migrate-to-bun` created from master HEAD `e7019bd`; P0 work branch `feat/migrate-to-bun-p0` (PR #1 target = `migrate-to-bun`).

**Shipped**: issue [#12](https://github.com/AndyTechnologies/llm-proxy/issues/12) (status:approved, type:feature) → PR [#13](https://github.com/AndyTechnologies/llm-proxy/pull/13) `build(bun): P0 slice — Bun bootstrap, native config loading, P0 parity gate` (base `migrate-to-bun`, head `feat/migrate-to-bun-p0`).

## Gates

**Build gate (retro):** `bun build src/index.ts --target=bun --outdir dist` must exit 0 in every slice. Fix `--target=bun` landed in S3; S1/S2 gates didn't run build. All future slice gates include build.

| Gate | Command | Result |
|------|---------|--------|
| Unit | `bun test src/config/load.test.ts` | 13 pass / 0 fail |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |
| Parity | `/tmp/opencode/parity/parity.sh` + `sse-probe.sh` | PASS (see table) |

## Issues Found

- **None blocking.** Two dev notes: (1) archived verify-report abbreviates `/health` models as `[4]` — actual shape is the names array (documented above, pre-existing, unchanged); (2) `engines.node` → `engines.bun` is a package-manager contract change for the migration — intended.

## Next

S1 (manager → Bun.spawn) — do NOT start in this batch per P0 slice boundary. Orchestrator to launch `sdd-apply` S1 slice next.

---

# S1 Batch — Manager → Bun.spawn (this batch)

**Batch**: S1 (chained-PR slice 2 of 5)
**Mode**: Strict TDD (bun:test, `bun test`)
**Store**: hybrid (this file + Engram `sdd/migrate-to-bun/apply-progress`)
**Chain strategy**: feature-branch-chain (tracker `migrate-to-bun`; PR #1 = `feat/migrate-to-bun-p0` → tracker, OPEN as #13; this PR #2 = `feat/migrate-to-bun-s1` → `feat/migrate-to-bun-p0`)
**Date**: 2026-09-02

## Status

S1 tasks **6/6 complete**. Gates: `bun test` **39 pass / 0 fail** (4 files), `tsc --noEmit` exit 0, `eslint .` exit 0. Real-spawn supervision smoke **PASSED** (dynamic port, health 200, clean SIGTERM, no orphans). Ready for S2a.

## Task Completion

| Task | Status | Notes |
|------|--------|-------|
| S1.1 RED `manager.test.ts` (13 tests) | ✅ | DI stubs `spawnFn`/`now`/`sleep` per ADR-3 (`mock.module("bun")` verified unusable for the builtin bun module — same fact as P0.3). Contract: `exited` Promise only (Bun Subprocess has no onExit), Uint8Array decode before regex, REAL in-process `Bun.serve({port:0})` health endpoint, temp executable-bin fixture (chmod 755) so real `validateBackendConfig` passes hermetically, fake clock. RED vs old impl: 12 fail / 3 errors. |
| S1.2 GREEN `manager.ts` | ✅ | `Bun.spawn` via injected `spawnFn`; `defaultSpawn` casts Subprocess→SpawnedProc (piped streams non-null); sync-throw catch → `spawn error` + state error + rethrow (posix_spawn ENOENT throws synchronously — runtime-verified); `supervise()` awaits `exited` (guard `intentionallyStopped`/`starting`), restart cap + exponential backoff (resets to 1000 on success), 4KB stderr tail with `flushStderr()` (50ms bounded race) before composing diagnostics; port-collision re-check after health 200; SIGTERM→stopTimeoutMs→SIGKILL race via `exited`+sleep; error strings byte-for-byte vs 62ef773 baseline. |
| S1.3 RED `validation.test.ts` (8 tests) | ✅ | `resolveBinary(binary, whichFn = Bun.which)` seam; absolute-exists / absolute-missing / PATH miss / PATH hit / validate-integrity. RED: 2 fails proved old impl ignores the seam (real `which(1)` resolved the actual binary). |
| S1.4 GREEN `validation.ts` | ✅ | `execFileSync("which")` subprocess → `Bun.which()` (native, zero child processes). Same error strings byte-for-byte. |
| S1.5 RED + GREEN `preset.test.ts` (5) + `preset.ts` | ✅ | Sync `fs.writeFileSync` → async `Bun.file().write()`; `fs.mkdirSync` recursive kept; `renderPresetIni` unchanged; manager `start()` now awaits the write. RED via Promise-contract/await tests against old sync write. |
| S1.6 smoke + gates | ✅ PASSED | Real llama-server (CPU-forced, SmolLM3-3B-Q4_K_M, dynamic port 0): port detected from STDERR URL-form banner → running → `GET /health` 200 → clean SIGTERM stop, no SIGKILL needed, no orphans. Gates all green. |

## TDD Cycle Evidence (S1)

| Task | Test File | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-----|-------|-------------|----------|
| S1.1–S1.3 manager lifecycle | `manager.test.ts` (13) | ✅ written first; 12 fail / 3 errors vs old impl | ✅ 13/13 (incl. stderr-banner regression test) | 2+ cases per behavior; REAL health server; port-collision flips child dead INSIDE the 200 handler; approval-style tests documented | none in-batch (conservative; refactor budget in verify) |
| S1.3–S1.4 which seam | `validation.test.ts` (8) | ✅ PATH-hit/miss tests fail vs old impl (seam ignored) | ✅ 8/8 | absolute ×2 + PATH ×2 + validate ×3 | n/a |
| S1.5 preset async write | `preset.test.ts` (5) | ✅ Promise/await contract fails vs sync write | ✅ 5/5 | render approval ×3; write returns filePath + content + mkdir | n/a |
| S1.6 regression (stderr banner) | `manager.test.ts` "URL-form banner on stderr" | ✅ discovered by smoke FIRST, then test written → RED | ✅ | smoke IS the triangulation (real llama.cpp) | n/a |

## Work Unit Evidence (S1)

| Work unit | Focused test command + exact result | Runtime harness + exact result | Rollback boundary |
|-----------|------------------------------------|-------------------------------|-------------------|
| WU5 — manager (S1.1–S1.2, S1.6 regression) | `bun test src/backend/manager.test.ts` → **13 pass / 0 fail** (37 expect) | `/tmp/opencode/s1-smoke.ts` (real llama): dynamic port **38665** parsed from stderr banner, ready in 30.0s (portParseTimeoutMs fixed wait — default 5s in prod), `/health` **200**, `stop()` SIGTERM → `backend stopped` (no SIGKILL), `SMOKE_EXIT=0`, no orphans | revert `manager.ts` + `manager.test.ts` + the `await writePresetIni` in `start()` |
| WU6 — validation (S1.3–S1.4) | `bun test src/backend/validation.test.ts` → **8 pass / 0 fail** | implicit in smoke (`resolveBinary` absolute path) + manager tests spawn argv | revert `validation.ts` + `validation.test.ts` |
| WU7 — preset (S1.5) | `bun test src/backend/preset.test.ts` → **5 pass / 0 fail** | smoke regenerated `.llm-proxy/models.ini` (1 model) via the async write | revert `preset.ts` + `preset.test.ts` |

## New API Facts (S1, runtime-verified this batch)

- **llama.cpp banner is stream/shape-dependent**: this build logs `listening on http://127.0.0.1:<port>` (URL form) on **stderr** (srv logger); older builds print `listening on 127.0.0.1:<port>` on stdout. `detectPort` reads BOTH streams and matches `listening\s+on\s+.*:(\d+)`. (Caught by the S1.6 smoke against the real binary.)
- `Bun.spawn` throws **synchronously** on posix_spawn ENOENT (v1.4.0) — wrap the spawn call; there is no 'error' event.
- `exited` resolves the exit code; signal deaths leave `exitCode: null` + `signalCode` set; `killed` becomes true only AFTER the process actually exits.
- Piped stdout/stderr streams close asynchronously AFTER exit — "last stderr" diagnostics race with the exit signal; bounded `flushStderr` (50ms) before composing errors.

## Deviations from Design / Tasks (S1)

1. **`spawnFn` signature** — design.md sketches `spawnFn?: typeof spawn` yet defines its own `SpawnedProc` with non-null streams; internally inconsistent. Adopted `SpawnFn = (cmd, args, opts: { env }) => SpawnedProc`; `defaultSpawn` casts the Subprocess (piped streams are non-null). Documented in the manager docblock.
2. **tasks.md S1.1 literal `mock.module("bun")`** — unusable for the bun builtin (P0.3 fact). DI per ADR-3, same correction pattern as P0.3.
3. **Restart-during-"starting" dead-end preserved** (pre-existing quirk, NOT a regression): a child that dies while `state === "starting"` is handled only by `waitForReady`; a subsequent supervse chain is not re-attached. Matches old Node behavior.
4. **Backoff resets to 1000 on every successful ready** — observable "restarting in 1000ms (backoff)" per crash cycle. Pre-existing semantics, preserved byte-for-byte.
5. **Dynamic-port boot pays the fixed `portParseTimeoutMs` sleep** even when the banner arrives in ~66ms (pre-existing design; default 5s). Not changed in S1 to preserve behavior; candidate for S2/S3 polish.

## Commits (S1 batch, branch `feat/migrate-to-bun-s1`, base `feat/migrate-to-bun-p0`)

- `33baf10` feat(backend): Bun.which() fail-fast binary resolution with injectable seam
- `afa24fb` feat(backend): async preset INI write via Bun.file().write()
- `89d859e` feat(backend): Bun.spawn manager with exited-based supervision and DI

**Shipped**: PR [#14](https://github.com/AndyTechnologies/llm-proxy/pull/14) `feat(backend): S1 slice — Bun.spawn manager, Bun.which validation, async preset write` (base `feat/migrate-to-bun-p0`, head `feat/migrate-to-bun-s1`, one label `type:feature`, diff 1019+/91- = the 6 S1 files only; "Part of #12" — no closing keyword, tracker closes when the final slice lands).

## Gates (S1)

| Gate | Command | Result |
|------|---------|--------|
| Unit | `bun test` | 39 pass / 0 fail (load 13, manager 13, validation 8, preset 5) |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |
| Smoke | `CUDA_VISIBLE_DEVICES="" bun run /tmp/opencode/s1-smoke.ts` | PASS (dynamic port, health 200, clean stop) |

## Issues Found (S1)

- **Smoke-caught bug (fixed in-batch)**: `detectPort` only watched stdout with a non-URL regex; real llama.cpp logs the URL-form banner to stderr. Fixed (both streams + URL-tolerant regex) with a regression test — RED via smoke → GREEN.
- Non-blocking note: llama.cpp *server tools* warning is expected (router mode + `--tools all`); defaults unchanged from P0.

## Next

S2a (middleware/engine/server + models route, non-SSE) — next slice per chain order. Orchestrator to launch `sdd-apply` S2a slice.

---

# S2a Batch — Middleware/Engine/Server + models route (this batch)

**Batch**: S2a (chained-PR slice 3 of 5)
**Mode**: Strict TDD (`bun test`, `tsc --noEmit`, `eslint .`)
**Store**: hybrid (this file + Engram `sdd/migrate-to-bun/apply-progress`)
**Chain strategy**: feature-branch-chain (tracker `migrate-to-bun`; PR #3 = `feat/migrate-to-bun-s2a` → `feat/migrate-to-bun-s1`)
**Date**: 2026-09-02

## Status

S2a tasks **3/3 complete** (S2.1, S2.2 + models, S2.3). Gates: `bun test` **66 pass / 0 fail** (9 files), `tsc --noEmit` exit 0, `eslint .` exit 0. SSE chat/completions intentionally NOT migrated (S2b boundary); chat.ts/completions.ts keep the Express `res.write` path via `teeToExpress` bridge. Ready for S2b.

## Task Completion

| Task | Status | Notes |
|------|--------|-------|
| S2.1 RED `errors.test.ts` + GREEN middleware | ✅ | `src/middleware/errors.test.ts` (11 tests) → `errors.ts` rewritten: `errorHandler(err, fallbackStatus)` plain fn returning `Response` with OpenAI envelope; `securityHeaders()` exported (manual headers replace helmet); `createPassthroughProxy(getManager, timeout)` returns `(req: Request) => Promise<Response>` — hop-by-hop stripped (exported `forwardHeaders`), upstream errors normalized to 502/503 OpenAI envelope, 200 streamed through via `new Response(upstream.body)`. `src/middleware/proxy.test.ts` (7 tests) covers hop-by-hop stripping (unit on `forwardHeaders` + live upstream), 502 connect-refused, 503 empty baseUrl, upstream 400 re-envelope, 200 passthrough stream. `src/middleware/auth.ts` rewritten: `authorize(req)`/`authGuard(req): Response \| null` (opt-in Bearer, 401 when set/missing). |
| S2.2 RED `engine.test.ts` + GREEN `engine.ts` | ✅ | `engine.ts`: `buildStreamBody()` returns `ReadableStream<Uint8Array>` (pure SSE builder, exported); `teeToExpress()` bridge streams the ReadableStream into the still-Express `res` so chat.ts/completions.ts (SSE, S2b) keep working unchanged. `engine.test.ts` (5 tests): single [DONE], one terminal chunk, frames. |
| S2.3 GREEN `server.ts` + models/health fetch handlers | ✅ | `createApp(deps)` → Bun.serve fetch handler: CORS preflight, authGuard, GET /health (aggregate: backend state, pid, models, chains), GET /v1/models (combined gateway/* + real), SSE routes → 501 (S2b), unknown → 404, errors → `errorHandler`. `models.ts` → `createModelsHandler({chains, manager}) => (req) => Response`. `health.ts` → `createHealthHandler({config, chains, manager}) => (req) => Response`. `index.ts` wires `Bun.serve({port, hostname, fetch: app})` + graceful SIGTERM/SIGINT drain via `server.stop(timeout)`. |

## TDD Cycle Evidence (S2a)

| Task | Test File | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-----|-------|-------------|----------|
| S2.1 errors/proxy | `errors.test.ts` (11) + `proxy.test.ts` (7) | ✅ written first (tests for fallbackStatus/security/envelope + hop-by-hop/502/503/200) | ✅ `bun test src/middleware/errors.test.ts src/middleware/proxy.test.ts` → 18 pass / 0 fail | 2+ cases per behavior; live upstream for 200-stream + error-normalization; unit (forwardHeaders) for hop-by-hop to avoid transport-injected `connection` header flakiness | exported `forwardHeaders`/`securityHeaders` for deterministic unit coverage |
| S2.2 engine stream | `orchestrator/engine.test.ts` (5) | ✅ written first | ✅ 5/5 | single [DONE], terminal chunk, frame decodes | `buildStreamBody`/`teeToExpress` exported |
| S2.3 server + models/health | `routes/models.test.ts` (2) + `routes/health.test.ts` (2) | ✅ written first (list shape 2+2, empty state, aggregate) | ✅ 4/4 | combined gateway+real list, empty chains/backend, aggregate shape | n/a |

## Work Unit Evidence (S2a)

| Work unit | Focused test command + exact result | Runtime harness + exact result | Rollback boundary |
|-----------|------------------------------------|-------------------------------|-------------------|
| WU8 — errors+auth (S2.1) | `bun test src/middleware/errors.test.ts src/middleware/proxy.test.ts` → **18 pass / 0 fail** (48 expect) | proxy live-upstream tests exercise real in-process `Bun.serve` fixtures | revert `errors.ts` + `errors.test.ts` + `proxy.ts` + `proxy.test.ts` + `auth.ts` |
| WU9 — engine stream (S2.2) | `bun test src/orchestrator/engine.test.ts` → **5 pass / 0 fail** | `teeToExpress` bridge integrity verified by full suite (chat/completions still compile + older engine tests green) | revert `engine.ts` + `engine.test.ts` |
| WU10 — server+models+health (S2.3) | `bun test src/routes/models.test.ts src/routes/health.test.ts` → **4 pass / 0 fail** | `bun run src/index.ts` boots under Bun.serve (health+models fetch handlers), graceful SIGTERM drain exits 0 | revert `server.ts` + `models.ts` + `health.ts` + `index.ts` + their tests |

## Deviations from Design / Tasks (S2a)

1. **`createPassthroughProxy` signature changed** (S2.1): old Express form `(baseUrlHttp, timeout, next)` → new `(getManager: () => LlamaServeManager, timeout)` returning a pure `(req: Request) => Promise<Response>`. `baseUrl` is read dynamically from the manager (keeps SSRF guard, matches design DI). chat.ts/completions.ts were minimally adapted to wrap the new fetch-based proxy (build a `Request` from the Express req, pipe the returned stream into `res`) — this is API adaptation, NOT SSE conversion (S2b).
2. **SSE routes intentionally 501 in the S2a Bun.serve handler** — chat/completions SDK streaming is migrated in S2b. chat.ts/completions.ts keep the Express `res.write` path via `teeToExpress`, so behavior is preserved end-to-end once S2b wires them in. Documented in server.ts + index.ts docblocks.
3. **Hop-by-hop test on live upstream** — Bun.serve injects transport-level `connection: keep-alive` on the upstream request regardless of what the gateway forwards, so the live integration assertion checks only `te`/`upgrade` (not `connection`); the deterministic unit test on the exported `forwardHeaders` asserts full hop-by-hop stripping (incl. `connection`/`keep-alive`/`content-length`/`host`).

## New API Facts (S2a, runtime-verified this batch)

- `new Response(upstream.body as ReadableStream)` is the Bun-native passthrough; hop-by-hop + `content-length` must be stripped from upstream response headers manually (Bun does NOT drop them for you in a manual `new Response`).
- Bun.serve re-injects `connection: keep-alive` on outbound HTTP/1.1 upstream requests — a forwarder cannot remove it from the wire, so assertions on forwarded `connection` must target the pure header-filter function, not the live upstream request.
- `Bun.serve({ fetch })` handler must return `Response | Promise<Response>`; Express `res` objects cannot be returned from it.

## Commits (S2a batch, branch `feat/migrate-to-bun-s2a`, base `feat/migrate-to-bun-s1`)

- `refactor(middleware): pure-fn errorHandler + securityHeaders; fetch-based passthrough proxy + authGuard` (S2.1)
- `feat(engine): buildStreamBody ReadableStream + teeToExpress bridge for Express SSE routes` (S2.2)
- `refactor(server): createApp → Bun.serve fetch handler; models/health fetch handlers; index.ts Bun.serve + drain` (S2.3)

## Gates (S2a)

| Gate | Command | Result |
|------|---------|--------|
| Unit | `bun test` | 66 pass / 0 fail (config 13, manager 13, validation 8, preset 5, errors 11, engine 5, proxy 7, health 2, models 2) |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |

## Issues Found (S2a)

- **None blocking.** Note: `chat.ts`/`completions.ts` required minimal API adaptation (proxy signature + a `Request` construction + `fromWeb`→`pipe(res)` bridge) purely to keep compiling against the new proxy; full register as Bun.serve SSE is S2b.
- Line budget: S2a scope (errors+auth+proxy+engine+server+models+health+index) is larger than the ~450 forecast but stays within the 1500-line auto-chain budget; the chained S2b slice absorbs chat/completions SSE + stream tests.

## Next

S2b (SSE chat/completions + stream tests + open question S2.6) — next slice per chain order. Orchestrator to launch `sdd-apply` S2b slice.
---

# S2b Batch — SSE chat/completions + stream tests + open question (this batch)

**Batch**: S2b (chained-PR slice 4 of 5)
**Mode**: Strict TDD (`bun test`, `tsc --noEmit`, `eslint .`)
**Store**: hybrid (this file + Engram `sdd/migrate-to-bun/apply-progress`)
**Chain strategy**: feature-branch-chain (tracker `migrate-to-bun`; PR #4 = `feat/migrate-to-bun-s2b` → `feat/migrate-to-bun-s2a`)
**Date**: 2026-09-02

## Status

S2b tasks **4/4 complete** (S2.4, S2.5, S2.6, S2.7). Gates: `bun test` **70 pass / 0 fail** (10 files, +4 stream tests), `tsc --noEmit` exit 0, `eslint .` exit 0. Live SSE parity smoke (real llama-server) **PASSED**: single [DONE] + terminal chunk, client abort releases slot + gateway stays healthy, silent stream survives >10s, clean SIGTERM. **Commits ARE materialized in git** (see below). Ready for S3.

## Task Completion

| Task | Status | Notes |
|------|--------|-------|
| S2.4 GREEN chat/completions fetch handlers + engine Response | ✅ | `chat.ts`/`completions.ts` → fetch handlers `(req: Request) => Promise<Response>` returning SSE `Response` via `runChain`/passthrough. `engine.ts` `runChain` now returns `Response` (SSE stream for streaming chains, JSON otherwise); `teeToExpress` removed (Express bridge no longer needed); `buildStreamBody` reused unchanged. `server.ts` dispatcher applies `server.timeout(req,0)` on the two SSE routes (ADR-2, per-request only) before dispatch. |
| S2.5 RED `src/routes/stream.test.ts` | ✅ | Bun.serve fixture mounting `createApp` + real dispatch. 4 tests: silent stream survives idleTimeout (fixture idleTimeout=1s, silence=1.5s — the >10s spec mapped to a fast deterministic equivalent; mechanism identical), exact-one [DONE] + terminal chunk, client abort cancels upstream generator, zod→400 non-stream. |
| S2.6 Open question — passthrough SSE coverage | ✅ RESOLVED | `server.timeout(req,0)` covers passthrough SSE because it is applied at the stream-route dispatcher BEFORE the chain-or-passthrough handler runs. Runtime-probed: default 10s idle kills a 16s-silent stream; `server.timeout(req,0)` lets it survive. Live smoke confirmed a real passthrough streamed over 10s. Verdict recorded in design.md + here. |
| S2.7 Gates + SSE parity smoke | ✅ | Full `bun test` 70/0 + `tsc --noEmit` 0 + `eslint .` 0. Live smoke vs external real llama-server (see evidence). |

## TDD Cycle Evidence (S2b)

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| S2.4 chat/completions fetch handlers | `src/routes/stream.test.ts` (4) | Integration (Bun.serve) | ✅ full suite 66/0 before edits | ✅ written first; all 4 fail vs 501 stub | ✅ Green after `server.ts` dispatch + handlers + `runChain` Response | ✅ 4 distinct behaviors: silence-survival, single-[DONE], abort, zod-400 | ✅ `runChain` sig simplified; `teeToExpress` deleted; helper constants extracted |
| S2.5 stream fixture | `src/routes/stream.test.ts` | Integration | N/A (new) | ✅ RED (4 fail) | ✅ 4/4 | ✅ 4 scenarios incl. non-trivial abort | n/a |
| S2.6 passthrough timeout probe | runtime probe `/tmp/opencode/bun-idle-probe3.ts` | E2E | n/a | n/a (runtime question, not unit) | ✅ confirmed | ✅ 16s failed w/o override / survived w/ override | n/a |

## Work Unit Evidence (S2b)

| Work unit | Focused test command + exact result | Runtime harness + exact result | Rollback boundary |
|-----------|------------------------------------|-------------------------------|-------------------|
| WU11 — engine Response + chat/completions handlers | `bun test src/routes/stream.test.ts` → **4 pass / 0 fail**; full `bun test` → **70 pass / 0 fail** | `/tmp/opencode/s2b-smoke.ts` (real llama-server): single [DONE] ✓, client abort releases slot + /health 200 ✓, SSE stream survives >10s ✓, clean SIGTERM ✓ → PASS | revert `engine.ts` (runChain→Response), `chat.ts`, `completions.ts`, `server.ts` dispatch, + `stream.test.ts` |
| WU12 — S2.6 passthrough timeout | `/tmp/opencode/bun-idle-probe3.ts` → per-req 0 survived 16s silence; default idle killed at ~12s | live smoke >10s passthrough stream ✓ | no code (runtime verdict only) |

## New API Facts / Verdicts (S2b, runtime-verified)

- **Bun.serve default `idleTimeout` is 10s and WILL kill a silent stream** past ~10s ("Bun.serve() timed out a request after 10 seconds" + socket closed). **`server.timeout(req, 0)` in the fetch handler disables it per-request** (confirmed: 16s silence survived only with the override). The fetch handler's 2nd arg is the `Server`; `timeout(req: Request, seconds: number): void` accepts the Request.
- **Official Bun SSE pattern** (`bun-types/docs/guides/http/sse.mdx`): call `server.timeout(req, 0)` in fetch for SSE — matches our implementation.
- `Bun.serve` `idleTimeout` must be `<= 255` seconds (255-max, ≥1). A 0/global value is not accepted; use `server.timeout(req,0)` per-request instead (which is exactly what we do).
- Removing `teeToExpress` is safe: it was the S2a bridge for the Express `res`; no other callers (verified by codegraph blast radius — 1 caller in engine.ts only).

## Deviations from Design / Tasks (S2b)

1. **`>10s` silent probe mapped to a fast deterministic fixture** (tasks S2.5 literal ">10 seconds"): the unit fixture uses a SHORT `idleTimeout` (1s) + 1.5s silence. This triggers the identical kill mechanism (default idle kills the silent stream) in ~1.5s instead of 10s+, keeping the suite fast. The full >10s behavior is additionally verified by the live smoke. Rationale documented in stream.test.ts.
2. **`runChain` signature changed** (S2.4): dropped the `res: Response` (Express) param, now returns `Response` directly. `teeToExpress` deleted (design.md S2.2 noted it as S2a interlude; S2b removes it). `buildStreamBody` and its invariants (single [DONE], terminal chunk, abort→cancel) are unchanged and reused.
3. **SSE headers moved to engine.ts constants** (`SSE_HEADERS`), replacing the old Express `res.setHeader` block — same set (text/event-stream, no-cache, keep-alive, X-Accel-Buffering).
4. **Passthrough body re-serialized from parsed JSON** in chat/completions handlers: the body is read once via `req.json()` for zod validation, then re-serialized for the passthrough `Request`. This is a byte-level reserialize (not byte-identical to the raw body) but is behavior-preserving — zod already validated known fields and openai extras pass through the schema (not `.strict()`). The passthrough proxy header/content handling is unchanged.

## Commits (S2b batch, branch `feat/migrate-to-bun-s2b`, base `feat/migrate-to-bun-s2a`)

These commits ARE materialized in `git log` (verified at end of batch):

- `feat(engine): runChain returns Response (SSE/JSON); remove teeToExpress bridge` 
- `feat(routes): chat/completions → fetch handlers returning Response; zod→400`
- `feat(server): dispatch chat/completions SSE with server.timeout(req,0) per-request (ADR-2)`
- `test(routes): Bun.serve SSE stream integration tests (silence-survival, single-[DONE], abort)`

## Gates (S2b)

| Gate | Command | Result |
|------|---------|--------|
| Unit | `bun test` | 70 pass / 0 fail (config 13, manager 13, validation 8, preset 5, errors 11, engine 5, proxy 7, health 2, models 2, stream 4) |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint .` | exit 0 |
| Smoke | `/tmp/opencode/s2b-smoke.ts` vs real llama-server | PASS (single [DONE], abort→slot release, >10s silent survival, clean drain) |

## Issues Found (S2b)

- **None blocking.** Two notes: (1) Bun CLI `idleTimeout` max is 255 and 0 is not a valid global — per-request `server.timeout(req,0)` is the correct mechanism (we use it); (2) the passthrough body is re-serialized from the zod-parsed JSON rather than byte-forwarded verbatim (see deviations #4) — behavior preserved, noted for reviewer.

## Next

S3 (binary/Docker/health JSON logs/drain) — final slice per chain order. Orchestrator to launch `sdd-apply` S3 slice.

---

# S3 Batch — Binary / Docker / Health JSON Logs / Drain (this batch, FINAL)

**Batch**: S3 (chained-PR slice 5 of 5 — final)
**Mode**: Strict TDD (`bun test`, `tsc --noEmit`, `eslint .`)
**Store**: hybrid (this file + Engram `sdd/migrate-to-bun/apply-progress`)
**Chain strategy**: feature-branch-chain (tracker `migrate-to-bun`; PR #5 = `feat/migrate-to-bun-s3` → `feat/migrate-to-bun-s2b`)
**Date**: 2026-09-02

## Status

S3 tasks **5/5 complete** — the implementation cycle is DONE. Gates: `bun test` **80 pass / 0 fail** (11 files, +10 tests), `tsc --noEmit` exit 0, `eslint .` exit 0. Compiled binary boots against a REAL external llama-server and drains cleanly on SIGTERM with **no orphan** (live E2E smoke). Docker REMOVED by maintainer decision (2026-09-02): cross-compile deferred to GitHub Actions. Ready for `sdd-verify`.

## Task Completion

| Task | Status | Notes |
|------|--------|-------|
| S3.1 RED health tests | ✅ | Extended `src/routes/health.test.ts` (+7 tests: /health/live 200 ×2, /health/ready 200-running + 503-starting/stopped/error ×4, legacy aggregate preserved ×1); new `src/utils/logger.test.ts` (+3 tests for `logJson` level+message). RED confirmed: 6 health tests failed, logger missing. |
| S3.2 GREEN index.ts + health.ts | ✅ | `routes/health.ts` now dispatches by pathname: `/health` (legacy aggregate, preserved), `/health/live` (200 `{status:"alive"}` always), `/health/ready` (200 iff state==="running" else 503 `{status:"unavailable","backend":{state}}`). `src/server.ts` routes the three paths to the handler. `src/utils/logger.ts` pure `logJson(level,message,extra)`. `src/index.ts` all startup/shutdown/fatal logs → JSON via `log()`. Drain unchanged: `server.stop(false)` with 3s bounded `server.stop(true)` force-close window. |
| S3.3 ~~Dockerfile~~ | ✅ REMOVED | REMOVED by maintainer decision 2026-09-02: Docker eliminated entirely (no Dockerfile, no .dockerignore); cross-compile deferred to GitHub Actions. `build:binary` (`bun --compile`) is the local compilation path. No action needed. |
| S3.4 compiled binary | ✅ | Added `build:binary` script (`bun build src/index.ts --compile --outfile dist/llm-proxy`) — 82MB self-contained executable, builds in ~0.5s, exit 0. Binary boots against real external llama-server and serves /health/live (live smoke). |
| S3.5 E2E drain | ✅ | Live supervised smoke (compiled binary + real llama-server, CPU): /health/live 200, /health/ready → 200 at running, /health aggregate reports running+pid, SIGTERM → gateway exits 0 AND the managed llama-server child is reaped (no orphan). Deterministic autoStart:false smoke: /health/ready → 503 while stopped, JSON logs valid, clean SIGTERM exit 0. |

## TDD Cycle Evidence (S3)

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|-----------|-----|-------|-------------|----------|
| S3.1–S3.2 health live/ready + logger | `routes/health.test.ts` (+7), `utils/logger.test.ts` (+3) | Unit | ✅ full suite 70/0 before edits | ✅ written first; health 6 fail (live/ready not dispatched), logger module missing | ✅ 12/12 after GREEN (health live/ready + legacy + logger) | ✅ 4 readiness states (starting/stopped/error/running) triangularized; logger 3 levels + extra fields | ✅ pure `logJson`; health dispatch extracted to `aggregateBody`; `req(path)` helper |
| S3.2 build fix (`--target=bun`) | dist build repro (not a unit) | Build gate | n/a | ✅ current `build` FAILED ("Browser build cannot import Bun builtin") | ✅ `--target=bun` → dist/index.js 170KB, exit 0 | ✅ both `build` and `build:binary` compile | n/a |
| S3.4–S3.5 binary + drain | E2E smokes `/tmp/opencode/s3-binary-drain-smoke.ts`, `/tmp/opencode/s3-live-smoke.ts` | E2E | n/a | n/a (runtime harness) | ✅ both PASS (see Work Unit Evidence) | ✅ autoStart:false + autoStart:true real backend | n/a |

## Work Unit Evidence (S3)

| Work unit | Focused test command + exact result | Runtime harness + exact result | Rollback boundary |
|-----------|------------------------------------|-------------------------------|-------------------|
| WU13 — health live/ready + JSON logs (S3.1–S3.2) | `bun test src/routes/health.test.ts src/utils/logger.test.ts` → **12 pass / 0 fail**; full `bun test` → **80 pass / 0 fail** | `bun run src/index.ts` boots; `/health/live` 200, `/health/ready` 503 (stopped) / 200 (running) live | revert `health.ts` + `health.test.ts` + `server.ts` (health dispatch) + `logger.ts` + `logger.test.ts` + `index.ts` log lines |
| WU14 — ~~Docker~~ + build fix (S3.3, partial S3.4) | `bun build src/index.ts --target=bun --outdir dist` → bundled 32 modules, exit 0 | n/a — Docker REMOVED by maintainer decision 2026-09-02 (cross-compile deferred to GitHub Actions). Build gate fixed in S3 (`--target=bun`). | revert package.json scripts only (Dockerfile/.dockerignore already deleted) |
| WU15 — binary + drain E2E (S3.4–S3.5) | `bun test` → **80 pass / 0 fail** after ops commits | `s3-live-smoke.ts` (real llama, CPU): /health/ready 200@running, liveness 200, aggregate reports pid, SIGTERM → exit 0, llama-server child REAPED (no orphan) → **PASS**; `s3-binary-drain-smoke.ts` (autoStart:false): /health/ready 503@stopped, JSON logs valid, SIGTERM exit 0 → **PASS** | revert package.json only (binary not committed; dist/ gitignored; Dockerfile/.dockerignore already deleted) |

## New API Facts / Verdicts (S3, runtime-verified)

- **`bun build --compile` (no --target) succeeds** and defaults to a Bun target — 82MB self-contained native binary; `--outfile` controls path. Plain `bun build --outdir dist` (browser-ish default target) **rejects the `bun` builtin imports** (manager.ts `import { spawn } from "bun"`) with "Browser build cannot import Bun builtin `bun`. When bundling for Bun, set target to 'bun'". Fix: `--target=bun`. **This means the pre-existing `build` script has been broken since S1** (when `Bun.spawn` was introduced) — S2/S2b gates (`bun test`/`tsc`/`eslint`) never exercised `build`. Fixed in S3.
- **Gateway blocks Bun.serve until backend ready** — `index.ts` does `await manager.start()` BEFORE `Bun.serve`. Consequence: the `starting` 503 on `/health/ready` is NOT observable live (the listener isn't up yet when state is `starting`); the 503 gating is reachable for `stopped`/`error` live, and `starting`/`stopped`/`error` are covered by unit tests. This is intentional per design ADR ("traffic never hits an unready upstream").
- `server.stop(true)` is the bounded force-close mechanism; the 3s window in `shutdown()` is the "hung connection force-closed" guarantee (Req 5). Drain lifecycle verified live; the specific hung-connection edge reuses Bun's documented force-close.
- `pgrep -f 'llama | llama-server'` cannot be used for a clean orphan check in autoStart:false (pre-existing llama may be running) — the live supervised smoke captures the managed pid and asserts it is gone after SIGTERM (definitive no-orphan proof).

## Deviations from Design / Tasks (S3)

1. **`build` script fixed with `--target=bun`** (S3.2 finding, not a tasks item): the pre-existing `build` (P0.2) failed since S1 because `--outdir dist` defaults to a browser target that rejects the `bun` builtin. Added `--target=bun` so `build` actually produces `dist/index.js`. Also added `build:binary` (the `--compile` path) as a separate script, per the tasks NOTE, without breaking `build`.
2. **Readiness `starting` 503 not live-reachable** — see API Fact above. This is a consequence of the design (gateway serves only once backend ready), not a code deviation; the branch is unit-tested and live-reachable for stopped/error.
3. **Docker REMOVED by maintainer decision** (2026-09-02): Dockerfile + .dockerignore deleted; cross-compile deferred to GitHub Actions. The compiled-binary deliverable (S3.4) IS verified. Build gate `--target=bun` is the local compilation path.

## Commits (S3 batch, branch `feat/migrate-to-bun-s3`, base `feat/migrate-to-bun-s2b`)

These commits ARE materialized in `git log` (verified at end of batch):

- `d9f60b9` feat(health): JSON logs + /health/live + /health/ready endpoints
- `254dcdb` build(docker): multi-arch Dockerfile + dockerignore; build:binary and --target=bun fix

## Gates (S3)

| Gate | Command | Result |
|------|---------|--------|
| Unit | `bun test` | 80 pass / 0 fail (config 13, manager 13, validation 8, preset 5, errors 11, engine 5, proxy 7, health 9, models 2, stream 4, logger 3) |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Lint | `bunx eslint . --fix` | exit 0 |
| Build (regular) | `bun build src/index.ts --target=bun --outdir dist` | bundled 32 modules, exit 0 |
| Binary (S3.4) | `bun build src/index.ts --compile --outfile dist/llm-proxy` | exit 0, 82MB binary |
| E2E smoke (S3.5) | `/tmp/opencode/s3-live-smoke.ts` + `s3-binary-drain-smoke.ts` | PASS (health/ready 200@running, /health/live 200, SIGTERM drain exit 0, no orphan; 503@stopped + JSON logs + clean drain in deterministic run) |

## Issues Found (S3)

- **`build` script was broken since S1** (pre-existing, fixed in S3): `bun build --outdir dist` rejected the `bun` builtin until `--target=bun` was added. Not caught by S1/S2 gates (they ran `bun test`/`tsc`/`eslint`, not `build`). This is a real packaging gap fixed here.
- **Docker REMOVED** (2026-09-02): maintainer decision — Docker eliminated entirely (no Dockerfile/.dockerignore); cross-compile deferred to GitHub Actions. `build:binary` (`bun --compile`) is the local compilation path.

## Next

**Implementation DONE — all S3 tasks complete.** Orchestrator to launch `sdd-verify` (final phase). The implementation cycle ends at S3.
