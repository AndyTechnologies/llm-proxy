# Architecture Conformance: wire-local-backend

**Date**: 2026-09-15
**Lint scope**: Post-apply independent review — axes 1 (boundaries), 2 (acta), 3 (principles)
**Full suite**: 437/437 pass, 1115 expect calls

---

## Axis 2 — Architecture-Plan Acta (title-by-title)

| # | Acta Decision | Verdict | Rationale |
|---|---|---|---|
| 1 | Hub Module — `Map<string, ManagedModel>` facade | ✅ Incorporated | `hub.ts:159` class `LocalBackendHub` owns `Map<string, ManagedModel>` (line 175); exposes all 8 closures/methods. Design §4.1 and implementation match. |
| 2 | Boot Wiring — preflight → restoreActive → non-null closures | ✅ Incorporated | `main.ts:73-75` hub created, `preflight()` then `restoreActive()` run before handler construction (line 82+). Non-null closures flow to `makeRuntimeServices` (line 84-86), `makeV1Handler` (line 103-105), `createWebServer` (line 114). `hub` in `ApiDeps` (line 98). |
| 3 | Version-Floor Semantics — ENOENT per-model error; old → global fail-fast | ✅ Incorporated | `preflight()` (hub.ts:207): ENOENT caught by `binaryUnavailableMessage` → `preflightError` set → `restoreActive` marks all active rows error (line 232) → boot continues. Old/unparseable → `this.exit(1)` (line 221). Three outcomes match spec exactly. |
| 4 | Activation Flow — verify GGUF → manager → start → {state, pid, port} | ✅ Incorporated | `activate()` (hub.ts:243): DB lookup → 404; `existsSync` GGUF gate; idempotent running; `spawnModel` with `{persist:true}` → manager.start() → `UPDATE SET active=1` (last) → `{state:"active", pid, port}`. Matches spec scenarios. |
| 5 | Readiness-Gating Wrapper — stop→start, starting→await, error→503, running→fast | ✅ Incorporated | `makeGatingProvider` (hub.ts:541) + `ensureReady` (hub.ts:414): four-state gate with `startLatch` serialization. `noteRequest()` resets idle timer. `catch` sets `lastError` + `{status:503}`. Latch prevents double-spawn. Verified by hub.test.ts (idle re-spawn, concurrent stopped, error 503, starting latch). |
| 6 | Idle-Stop 10 min configurable | ✅ Incorporated | `IDLE_TIMEOUT_MS` in manager.ts:23 = `10 * 60 * 1000`. `HUB_IDLE_TIMEOUT_MS` in hub.ts:91 = same. `HubDeps.idleTimeoutMs` flows to every manager. Verified by hub.test.ts idle-stop tests. |
| 7 | In-Flight Drain — poll noteActivity, 30s safety timeout | ✅ Incorporated | `drain()` (hub.ts:562): polls `entry.inFlight` every `drainPollMs` (1s default) until 0 or 30s deadline, then force stop. `noteActivity` closure increments/decrements `inFlight`. Verified by hub.test.ts (drain happy, drain timeout). |
| 8 | Embedder — settings row → `--embeddings` spawn; 404 when unset | ✅ Incorporated | `embedder()` (hub.ts:337): reads `settings.embedding_model` lazily → wraps `makeLlamaEmbedder` with `ensureReady` gate → null when not set/missing/error. `buildSpawnArgs` (hub.ts:527): `embeddings: true` when `this.embeddingModelId() === modelId`. `spawn-args.ts:84`: `--embeddings` pushed. Verified by hub.test.ts (embedder lifecycle, --embeddings flag, idle re-spawn through gate). |
| 9 | Schema — `active INTEGER NOT NULL DEFAULT 0` + idempotent ALTER | ✅ Incorporated | `schema.ts:31`: `active INTEGER NOT NULL DEFAULT 0` in `MODELS_TABLE` CREATE. `migrateModelsActive` (line 37): PRAGMA check + ALTER. Fresh DB + migration + idempotent verified by schema.test.ts (4 tests). |
| 10 | Config — `WEAVELLM_LLAMA_BIN` → `llamaBin` | ✅ Incorporated | `config.ts:12`: `AppEnv.WEAVELLM_LLAMA_BIN?`. `types.ts:13`: `AppConfig.llamaBin: string`. `resolveLlamaBin` (config.ts:24): empty/undefined → `"llama"`. Verified by config.test.ts (3 tests). |
| 11 | Health — `localModels` field | ✅ Incorporated | `server.ts:57-59`: health response adds `localModels` only when `deps.localModels !== undefined`. `ServerDeps.localModels?: () => string[]` (line 30). Verified by server.test.ts (wired, absent, empty). |
| 12 | VRAM Heuristic — EXPLICITLY DEFERRED | ✅ Correctly deferred | No VRAM detection, eviction, or `--n-gpu-layers 0` anywhere in hub.ts. Spawn is unconditional. Matches acta Decision 12. |

**Axis 2 verdict**: All 12 decisions incorporated — ✅

---

## Axis 1 — Boundaries reviewed

**Boundaries reviewed**: new module boundary (hub facade), DI seams preserved, external access through adapters, module-level separation.

| Concern | Verdict | Rationale |
|---|---|---|
| New module boundary (hub facade) | ✅ Conforms | `LocalBackendHub` is a pure facade: orchestrates lifecycle via `LlamaProcessManager` instances, never re-implements spawn/health logic. Dependencies point inward (manager, DB, adapters). |
| DI seams preserved | ✅ Conforms | `HubDeps` injects all I/O seams (spawnFn, now, sleep, healthCheck, exit, db). No global state; fakes flow through to managers. Existing seams (`makeRuntimeServices`, `makeV1Handler`, `createWebServer`) receive non-null closures — zero changes to their signatures. |
| External access through adapters | ✅ Conforms | `makeLlamaServerProvider` (provider adapter) wraps HTTP calls to the backend. `getModelConfig` (DB adapter) reads model_config. `readEmbeddingModelId` reads settings. All external concerns behind interfaces. |
| Domain isolation | ✅ Conforms | Hub owns orchestration (activate/deactivate/drain/gate); process lifecycle stays in `LlamaProcessManager`; spawn args stay in `buildLlamaSpawnArgs`; routing stays in v1.ts/api.ts. No framework coupling. |
| Zero-change seams preserved | ✅ Conforms | `runner.ts`, `v1.ts`, `registry.ts`, `types.ts`, `embeddings.ts`, `model-config.ts`, `fallback.ts` — all unchanged. The hub plugs into existing DI without modifying downstream consumers. |

**Documented deviations from design** (non-violations):
1. `ApiDeps.hub` made **optional** (`hub?:` instead of `hub:`) — backward compatibility for un-wired test fixtures; boot always passes a hub. Acceptable.
2. `embeddingModelId` reads **lazily per access** instead of once at construction — strictly more correct for runtime designation changes. Acceptable.
3. `HubDeps.idlePollMs` added (additive, optional) — flows into managers for deterministic idle tests. Non-breaking.
4. `BootResult.shutdown` added — required for D7 drain semantics at process exit. Non-breaking.

**Axis 1 verdict**: ✅ No violations. Minimal-change bias respected.

---

## Axis 3 — Architecture principles (ALWAYS, POST-apply)

**Verdict**: `axis_3 pass` (zero blockers; zero warnings)

No relevant findings for this change. The implementation is clean:

- No catalog entry violations detected in the applied code.
- No dogma applies (the hub is a well-scoped facade, not a manufactured boundary).
- Utility duplication (`collectAll`/`settle` in hub.ts vs `collectAll`/`drain` in manager.ts) is within acceptable bounds — self-contained hub utilities that avoid cross-module coupling. Not a A10 (copy/paste) finding because the implementations serve different purposes (preflight capture vs manager lifecycle drain).

---

## Architecture Conformance

**Change**: wire-local-backend

**Overall verdict**: **pass** — all axes green.

The `LocalBackendHub` is a clean facade that wires the already-implemented `LlamaProcessManager` into the runtime boot path without touching any downstream seams. All 12 arch-plan decisions are faithfully implemented. DI seams are preserved and extended (not broken). The no-dogma principle is respected — the hub is a genuine architectural boundary, not manufactured overhead.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `ApiDeps.hub` optional (deviation from design §4.7) | Low | Boot always passes a hub; the optional is only for test backward compat. Documented in apply-progress.md. |
| Lazy `embeddingModelId` read (deviation from design §3.2) | None | Strictly more correct than construction-time caching. Lazy read handles designation changes. |
| `collectAll`/`settle` duplication between hub.ts and manager.ts | None | Self-contained utilities; refactoring into shared helpers would add coupling for no material benefit. Not a A10 finding. |

---

## Artifacts

| File | Action |
|---|---|
| `openspec/changes/wire-local-backend/arch-lint.md` | Create (this file) |
