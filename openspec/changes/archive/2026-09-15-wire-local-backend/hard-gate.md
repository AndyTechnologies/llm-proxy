# Hard Gate Verdict: wire-local-backend

- **Verdict:** `pass`
- **Gate:** adversarial specs-vs-code, fresh eyes, pre-close
- **Worktree:** `/home/andy/.agent_worktrees/llm-proxy/wire-local-backend` (HEAD `d7e6d08`)
- **Evidence revision:** `sha256:dad4f93922ddbf5b7e8aed0428182be25f047cd727967f2f07141d16bb74d3c5`
- **Ledger:** `sdd-attempt` settled `complete` (outcome `passed`, harness disposition `reused`)

## Coverage summary

Spec: **19 requirements / 47 scenarios** (backend-management 8/21, dashboard-api 4/9,
local-model-catalog 4/9, embeddings-rag 3/8), read verbatim from `spec.md`.

All 19 requirements matched to code + test evidence:

| Req | Capability | Code evidence | Test evidence |
|-----|-----------|---------------|---------------|
| R1 | spawn/supervise llama-server | `hub.ts` activate/ensureReady, `manager.ts` start/spawnOnce/`parseListeningPort`, `--port 0` | hub.test #1,#4; manager.test start+args; v1-integration a,d |
| R2 | readiness gate | manager health-poll gate, `hub.ts` startLatch, `localProvider` wrapper awaits | manager.test wait-ready/fail-fast; hub.test #17,#19 |
| R3 | graceful shutdown | `hub.stopAll()` drains in-flight 30s; `main.ts` shutdown → stopAll | hub.test #24; main.test shutdown |
| R4 | health/status reporting | `server.ts` health `localModels`, `api.ts` statusAll | server.test 3 tests; main.test health |
| R5 | fail-fast version preflight | `main.ts` preflight; ENOENT → per-model error, old → exit(1) | hub.test #12,#13; main.test missing-bin |
| R6 | single-model spawn per active | `hub.ts` Map<string, manager>, `spawn-args.ts` per-model flags, idle 10 min configurable | spawn-args.test flags; manager.test idle 10 min + idle kill |
| R7 | activate/deactivate endpoints | `api.ts` routes + `HubError.status` mapping, persisted `active` | api.test activate/deactivate/persist/404/400/405 |
| R8 | ENOENT per-model, not global | `hub.preflight()` | hub.test #12; main.test boot continues |
| R9 | local model management API | `api.ts` models branch + auth gate | api.test list/auth/status |
| R10 | activation endpoint | `api.ts` 200/400/503 mapping | api.test activate; hub.test #4 (503) |
| R11 | deactivation endpoint | `api.ts` | api.test deactivate 200/404 |
| R12 | health includes localModels | `server.ts` conditional field | server.test wired/omitted/empty |
| R13 | activation flow persists state | hub persists `active`, `localModels` filter | hub.test #1; api.test DB row; v1-integration a |
| R14 | lazy re-spawn after idle-stop | `ensureReady` lazy re-spawn | v1-integration c,d |
| R15 | missing GGUF → error state | `restoreActive()`; omitted from `/v1/models` | hub.test #15; main.test error-state |
| R16 | active column in SQLite | `schema.ts` MODELS_TABLE + `migrateModelsActive` idempotent ALTER | schema.test fresh/migration/idempotent/provenance-pin |
| R17 | local embeddings | `hub.embedder()` + `settings.embedding_model` + `--embeddings` | hub.test #21,#22 (embed() gate-through at :622); spawn-args.test; v1-integration g (404) |
| R18 | embedder lifecycle | `embedderCache` invalidation on deactivate/respawn | hub.test #23 |
| R19 | spawn args embeddings mode | `spawn-args.ts` `embeddings?: boolean` → `--embeddings` | spawn-args.test #97–138 (arg order pinned) |

## Invented behavior

None found within the change deltas. Defensive fail-closed extensions consistent with
spec intent (not scope creep): unparseable `--version` output → fail-closed throw;
EADDRINUSE → actionable error; 405 method matrix on management routes.

## CI gate

- `bun run typecheck` → exit 0
- `bun test` → **438 pass / 0 fail / 41 files**, exit 0 (5.60s)

## Non-blocking follow-ups (documented, do not fail gate)

1. `api.ts:76` implements both `/api/models/:id` and `/api/models/:id/status` shapes;
   only the shorthand is directly tested (verify-report W1).
2. Positive `/v1/embeddings` vector path is exercised at hub level
   (`hub.embedder().embed()` gates through the manager); the HTTP-boundary success case
   lacks an E2E assertion (only the 404 path is route-tested).
3. verify-report counts 18 spawn-args tests; actual file has 17 (cosmetic count drift, corrected at archive).
4. Pre-existing RDD/F4 follow-ups re-confirmed non-blocking: activation-time latch gap,
   activate idempotence race, deactivation window, embedder stale-cache window.

## Provenance

- Hard gate ran read-only (`changed_lines: 0`); no worktree bytes modified by the gate.
- Untracked openspec artifacts selected on the ledger (inventory
  `sha256:96a578fad0faa733237254e072c0c97de30c6e41cc29130b966bb5c711d410ba`).
- F4 post-verify review hook and consent strings untouched (T31 byte-stable).