# Pre-Experience: wire-local-backend

Close retrospective — persisted between changelog and archive (after changelog, before the
archive move). Fail-open phase: store unavailability degrades to a warning, never blocks.

- **Change**: wire-local-backend
- **Date**: 2026-09-15
- **Worktree**: `/home/andy/.agent_worktrees/llm-proxy/wire-local-backend` (HEAD `d7e6d08`)
- **Store mode**: hybrid (this file + Engram mirror at topic `sdd/wire-local-backend/pre-experience`)
- **Status**: `success` (all failures persisted; no store degradation)

---

## Session failure log

Each entry records WHAT failed, WHERE (artifact/phase/location), and the CORRECTION taken
(or explicitly deferred). "none" would be reported truthfully if nothing had failed — it did not.

### F1 — Schema provenance testing gap (CLOSED — corrective round 1, commit `d7e6d08`)

- **WHAT**: Removing `active INTEGER NOT NULL DEFAULT 0` from the `MODELS_TABLE` CREATE was
  INVISIBLE to the suite (`10 pass / 0 fail` on the break). `migrateModelsActive` unconditionally
  self-heals any DB missing the column — including fresh DBs — producing a byte-identical
  end-state. The spec-letter guarantee ("fresh databases SHALL have this column in the CREATE
  statement") was not observable by any runtime test.
- **WHERE**: `src/db/schema.test.ts` (missing provenance test) · `src/db/schema.ts`
  (`MODELS_TABLE` + `migrateModelsActive`) · spec R16. Found by hard-verify adversarial
  break-testing, surface 2 → verdict `testing-error` → return-edge to Tasks.
- **CORRECTION**: Added "fresh DB: MODELS_TABLE CREATE statement pins active column provenance":
  `expect(MODELS_TABLE).toMatch(/active\s+INTEGER NOT NULL DEFAULT 0/)`. Chosen over the acta's
  literal `includes(...)` because the DDL writes 8 spaces (`active        INTEGER`), not 1.
  Option 2 (assert `sqlite_master.sql`) was empirically REJECTED: SQLite rewrites
  `sqlite_master.sql` on `ALTER TABLE ADD COLUMN`, so stored SQL cannot distinguish CREATE
  provenance from ALTER provenance. Break-test soundness proven: before 10/0 (invisible), after
  10/1 (caught), revert 11/0. Full suite 437 → 438.

### F2 — Spawn-args test count drift: "18" vs "17" (ASSERTED AUTHORITATIVE HERE — 17)

- **WHAT**: The same per-file count drifted across THREE artifacts and TWO phases, and was
  eventually INVERTED: verify-report claims `18/18`; hard-verify round 1 measured 17 and
  flagged it; hard-verify re-run confirmed 17; hard-gate.md:56 then inverted the direction
  ("verify-report counts 17; actual file has 18").
- **WHERE**: `verify-report.md` (claims 18) · `hard-verify.md` (round 1 + re-run: 17, correct) ·
  `hard-gate.md:56` (inverted, wrong).
- **CORRECTION**: No correction was previously persisted. This phase establishes the
  authoritative count by direct execution: `bun test src/backend/spawn-args.test.ts` →
  **17 pass / 0 fail / 58 expect calls**, and a `test(` scan = 17. Verify-report's "18" and
  hard-gate's inversion are both bookkeeping errors; the archive step must not carry them
  forward. Lesson: per-file/per-suite counts must be taken from a live test run at the time of
  writing, never hand-carried between artifacts. (No code change needed — the full-suite hash
  `8b6fe438...` was authoritative all along.)

### F3 — Lint artifact typo `--emissions` (DEFERRED — cosmetic)

- **WHAT**: `arch-lint.md:20` reads "`--emissions` pushed"; the code, design, and tests all use
  `--embeddings`.
- **WHERE**: `openspec/changes/wire-local-backend/arch-lint.md:20` · authoritative text at
  `src/backend/spawn-args.ts:84` (`args.push("--embeddings")`), `hub.ts:527`, spawn-args tests.
- **CORRECTION**: None — cosmetic narrative typo in a verified artifact; flag for the archive
  step to fix the artifact text. Zero behavioral impact (verified against source).

### F4 — Carried non-blocking review findings, R3 set (DEFERRED — out of scope, re-confirmed non-blocking)

Origin: native F4/RDD review-lens (review-reliability); re-confirmed non-blocking by the hard
gate. No correction taken in this change; they are candidate follow-up work.

- **R3-SPAWN-LATCH-GAP**: `startLatch` is only created in `ensureReady`, not at activation-time
  `spawnModel` — a request arriving during activation can trigger a second spawn.
- **R3-ACTIVATE-NOT-IDEMPOTENT**: activation race during the `starting` state.
- **R3-DEACTIVATE-WINDOW**: servable window between drain completion and stop — a request can
  slip in during drain+stop.
- **R3-EMBEDDER-STALE-CACHE**: embedder cache is never reset after deactivate+reactivate.

### F5 — Process lessons (INFORMATIONAL)

- **Review-consent relay**: the F4 review-consent relay required the exact v3 envelope to
  complete; shape drift caused a retry loop. Process-level, no code impact.
- **`sdd-attempt` acquire**: the acquire step REQUIRES the untracked-selection declaration
  (same inventory sha256 as the review); omitting it fails acquisition.
- **Gate artifacts post-review**: `hard-gate.md` was created as a NEW untracked artifact after
  the F4 review — it was NOT in the F4 review candidate inventory (correct: it is a gate
  artifact, not a review change), but this class of post-review artifact must be registered so
  future reviews/gates include it.
- **Worktree env gap**: worktree `node_modules` was missing `yaml`/`typescript`/`eslint`
  (never `bun install`ed). `bun install` fixed a pre-existing environment gap; not caused by
  this change.

---

## Skill proposals (presented to the user — nothing auto-created)

The human decides whether any candidate is created. Name, trigger, origin lesson:

1. **`verify-report-count-accuracy`** — Trigger: writing verify-report / hard-verify /
   hard-gate (any artifact that states per-file or per-suite test counts). Content rule:
   counts must come from a live test run at the moment of writing, with raw output embedded;
   never hand-carried from a prior artifact. Origin: F2 — the same "18/17" number drifted
   through three artifacts and was inverted by the hard gate. Scope: **project** (SDD pipeline
   discipline in this repo).
2. **`gate-artifact-registration`** — Trigger: creating a gate artifact (e.g. hard-gate.md)
   after a review round, or closing an SDD attempt whose ledger holds an artifact inventory.
   Content rule: new gate/review artifacts must be declared in the artifact inventory so the
   ledger and subsequent reviews/gates include them. Origin: F5 — hard-gate.md landed post-F4
   outside the F4 review candidate inventory (correct as a gate artifact, but unregistered
   artifact classes drift). Scope: **project**.
3. **`ddl-provenance-pinning`** — Trigger: writing schema/migration tests where a self-healing
   migration could mask a CREATE-statement regression; validating a DDL provenance fix.
   Content rule: assert the DDL constant (regex-tolerant of whitespace), break-test the
   regression, and beware `sqlite_master` — ALTER rewrites it, so stored SQL cannot prove
   CREATE provenance. Origin: F1 — `migrateModelsActive` made the CREATE regression invisible
   (10/0), and the naive literal `includes` + `sqlite_master` fix were both traps. Scope:
   **project** (reusable across this repo's schema work).

---

## Risks

- F2 count drift persisted in committed artifacts (verify-report, hard-gate) — archive must
  not propagate either wrong number; authoritative count is 17 (this file).
- F3 typo in arch-lint.md narrative to fix at archive.
- F4 carried findings are deferred follow-ups, not blockers; they should be tracked as work
  items post-close.
- Shared phase contract `skills/_shared/sdd-phase-common.md` not found in worktree or main
  repo — executed per the phase definition in this skill; reported as a warning.