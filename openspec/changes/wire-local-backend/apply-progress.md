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
