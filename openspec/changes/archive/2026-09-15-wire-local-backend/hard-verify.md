```yaml
schema: gentle-ai.hard-verify/v1
change: wire-local-backend
date: 2026-09-15
worktree: /home/andy/.agent_worktrees/llm-proxy/wire-local-backend
mode: adversarial-break-testing
verdict: testing-error
surfaces_exercised: 2 / 5
breaks_caught: 1 / 2
unexercised: [surface-3-spawn-args-embeddings, surface-4-hub-latch-503, surface-5-binary-config]
return_edge: true
tree_clean: true
baseline_hash: sha256:8b6fe438ab294e624d1db2bbbea7ad8331afe039fdeaed82acb00f5392afdd8c
```

# Hard Verify: wire-local-backend — Adversarial Break Testing

**Change**: wire-local-backend
**Date**: 2026-09-15
**Protocol**: run ≥1 isolated revertible break per surface; if ANY break is NOT caught by its focused test suite, STOP immediately and produce a gaps acta.
**Mode**: adversarial break-testing (hard-verify opt-in)

---

## Executive Summary

Two sensitive surfaces were broken and tested against their focused suites. Surface 1 (auth gate) was **caught** — soundness proven. Surface 2 (active column in CREATE statement) was **NOT caught** because `migrateModelsActive` unconditionally self-heals any DB that lacks the column, including fresh DBs; no test anywhere pins the CREATE statement text or column provenance. This is a testing gap: the requirement letter ("SHALL have this column in the CREATE statement") is not observable by any runtime test. Per the protocol, the run halts here with **verdict testing-error** and **return-edge to Tasks**.

| Surface | Target file | Targeted test suite | Break | Caught? |
|---------|-------------|---------------------|-------|---------|
| 1 — Auth gate on `/api/models` | `src/routes/api.ts` | `src/routes/api.test.ts` | Removed gate block (lines 62-65) | ✅ YES — `16 pass, 1 fail` (401 assertion fails) |
| 2 — `active` column in CREATE | `src/db/schema.ts` | `src/db/schema.test.ts` | Removed `active` line from `MODELS_TABLE` CREATE; kept `migrateModelsActive` | ❌ NO — `10 pass, 0 fail` (migration self-heals fresh DBs) |
| 3 — Spawn args `--embeddings` | `src/backend/spawn-args.ts` | `src/backend/spawn-args.test.ts` | — | NOT EXERCISED (protocol halted after surface 2) |
| 4 — Hub latch / 503 | `src/backend/hub.ts` | `src/backend/hub.test.ts` | — | NOT EXERCISED (protocol halted after surface 2) |
| 5 — `resolveLlamaBin` default | `src/app/config.ts` | `src/app/config.test.ts` | — | NOT EXERCISED (protocol halted after surface 2) |

**Baseline**: `bun test src/routes/api.test.ts src/db/schema.test.ts src/backend/spawn-args.test.ts src/backend/hub.test.ts src/app/config.test.ts` → `74/74 pass, 0 fail, 213 expect() calls`

---

## Surface 1 — Auth gate on `/api/models` (CAUGHT ✅)

### Break applied

```typescript
// BEFORE (api.ts lines 60-65):
      const hub = deps.hub;
      if (hub === undefined) return jsonResponse({ error: "not_found" }, 404);
      if (deps.auth !== undefined) {
        const ok = await deps.auth(req);
        if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
      }

// AFTER (removed the 4-line auth gate block):
      const hub = deps.hub;
      if (hub === undefined) return jsonResponse({ error: "not_found" }, 404);
```

### Test output

```text
(bun test src/routes/api.test.ts)
317 |       expect((await deny(new Request("http://x/api/models"))).status).toBe(401);
error: expect(received).toBe(expected)
Expected: 401
Received: 200

 16 pass
 1 fail
 46 expect() calls
Ran 17 tests across 1 file.
```

### Verdict

**Soundness proven.** The auth gate test directly asserts that a `deny` handler (auth → false) returns 401 on `GET /api/models`. Removing the gate changes the response to 200, immediately caught by the assertion. Break reverted — file restored to HEAD byte-identically.

---

## Surface 2 — `active` column in MODELS_TABLE CREATE (NOT CAUGHT ❌ — TESTING GAP)

### Break applied

```sql
-- BEFORE (schema.ts line 31, inside MODELS_TABLE CREATE):
  active        INTEGER NOT NULL DEFAULT 0,

-- AFTER: removed this line entirely; migrateModelsActive() kept intact.
```

### Test output

```text
(bun test src/db/schema.test.ts)
 10 pass
 0 fail
 17 expect() calls
Ran 10 tests across 1 file.
```

### Root cause analysis

**`migrateModelsActive` unconditionally self-heals.** After `applySchema` executes all ten CREATEs, `migrateModelsActive` runs:

```typescript
function migrateModelsActive(db: WeaveLlmDatabase): void {
  const cols = db.query("PRAGMA table_info(models)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "active")) {
    db.exec("ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0");
  }
}
```

The PRAGMA check is unconditional — it fires for *any* DB where the column is absent, including a fresh `:memory:` DB. So removing the column from the CREATE statement triggers the migration path on every fresh DB, producing a column with identical properties (`INTEGER NOT NULL DEFAULT 0`, `notnull=1`).

No test anywhere pins the CREATE statement text or inspects `sqlite_master.sql`:
- `schema.test.ts` "fresh DB" test queries `PRAGMA table_info(models)` → finds `active` via migration. ✅ (pass)
- `schema.test.ts` "pre-migration" test creates a legacy table, then `applySchema` → migration adds. ✅ (pass)
- `schema.test.ts` "idempotent" test → second run is no-op. ✅ (pass)
- `hub.test.ts`, `main.test.ts`, `api.test.ts` all create DBs via `applySchema` → migration heals. ✅ (pass)

**Grep evidence** (no test reads `MODELS_TABLE` or `sqlite_master` SQL):
```
src/db/schema.ts:
  Line 19: export const MODELS_TABLE = ...  (definition)
  Line 39: PRAGMA table_info(models)        (migration check)
  Line 42: ALTER TABLE ... active ...        (migration ALTER)
  Line 128: db.exec(MODELS_TABLE);           (applySchema)

src/db/schema.test.ts:
  Lines 24,77,106,130: PRAGMA table_info(models)  (post-applySchema column checks)
```

### Impact

**Severity: Low (behavioral), Medium (spec-letter compliance)**

- **No observable behavioral difference.** The column is present with the same type/constraints/default via migration on every DB path. All SQL (`UPDATE models SET active = ...`, `SELECT active FROM models WHERE active = 1`, etc.) works identically.
- **Spec-letter violation.** The requirement states: "Fresh databases SHALL have this column in the CREATE statement." This is not a scenario-level THEN clause — it's an implementation-mandate about DDL provenance. The tests cover the scenario observable (column present + correct default) but not the provenance.
- **Minor DDL artifact.** Fresh DBs now run `ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0` on every first boot — a full table rewrite in SQLite. For a models table (typically <100 rows), this is invisible in practice but diverges from the design intent.
- **If the migration were also removed**, the test suite WOULD catch it: `PRAGMA table_info(models)` → `active` undefined → `.toBeDefined()` fails. The gap is specifically: CREATE provenance vs ALTER provenance — both produce the same observable end-state.

### Recommended fix (choose one)

1. **Pin the constant directly:** Add a test that asserts `MODELS_TABLE.includes("active INTEGER NOT NULL DEFAULT 0")` — zero-cost, pins the DDL as specified.
2. **Pin via `sqlite_master`:** In the "fresh DB" test, query `SELECT sql FROM sqlite_master WHERE name='models'` and assert it contains `active INTEGER NOT NULL DEFAULT 0` — proves the column is in the CREATE, not just the ALTER.
3. **Accept and relax spec:** If the migration-only path is considered correct (defense-in-depth), update the spec to say "the `models` table SHALL include `active INTEGER NOT NULL DEFAULT 0` (present in the CREATE or added by `migrateModelsActive` on existing/fresh DBs)" — this aligns the spec with the current (arguably superior) behavior.

---

## Surfaces 3, 4, 5 — NOT EXERCISED

Per the break-testing protocol, any uncaught break terminates the adversarial pass and returns control to Tasks. Surfaces 3–5 were not broken or tested in this run.

**High-level coverage assessment** (from verify-report, source review — NOT empirically verified by this run):

| Surface | Break design | Expected outcome | Source |
|---------|-------------|------------------|--------|
| 3 — `--embeddings` emission | Remove `if (input.embeddings === true) args.push("--embeddings")` from `spawn-args.ts:84` | **Likely caught** — `spawn-args.test.ts` asserts `args.toContain("--embeddings")` (line 99) and pins full-argv order (line 123: `toEqual([...])` with `--embeddings` at index 2) | Code inspection |
| 4 — Hub `startLatch` serialization | Remove `if (entry.startLatch !== null) return entry.startLatch` from `hub.ts:421` and the `entry.startLatch = latch` assignment | **Likely caught** — `hub.test.ts` "concurrent requests while stopped share ONE re-spawn" asserts spawn count = 2 (1 initial + 1 shared); without the latch, two concurrent requests would call `manager.start()` → count = 3 → FAIL | Code inspection |
| 4b — 503 propagation | Change `unavailable()` to return `Error` without `{status: 503}` | **Likely caught** — `hub.test.ts` "wrapper on backend error → 503 immediately" asserts `rejects.toMatchObject({ status: 503 })` | Code inspection |
| 5 — `resolveLlamaBin` default | Change default from `"llama"` to `""` in `config.ts:25` | **Likely caught** — `config.test.ts` "defaults to 'llama' when unset" asserts `expect(resolveAppConfig({}).llamaBin).toBe("llama")` | Code inspection |

**Note:** These are informed predictions based on source-level review only — they do NOT constitute empirical soundness evidence. If Tasks elects to continue hard-verify after the gap is addressed, these three surfaces should be broken and tested.

---

## Informational: verify-report count discrepancy

The verify-report claims `spawn-args.test.ts` has 18 passing tests; the current tree has **17** (verified by `bun test` count and manual `test()` call scan). The full-suite total in the verify-report (437) includes all 41 files; the discrepancy is confined to the per-file count for `spawn-args.test.ts`. The test_output_hash covers the full suite and is authoritative; the per-file count is a minor bookkeeping mismatch (18 vs 17). Not a blocking finding, but flagging for the archive step.

---

## Evidence envelope

| Artifact | Value |
|----------|-------|
| Baseline suite | `bun test src/routes/api.test.ts src/db/schema.test.ts src/backend/spawn-args.test.ts src/backend/hub.test.ts src/app/config.test.ts` → **74 pass / 0 fail / 213 expect()** |
| Surface 1 break | `bun test src/routes/api.test.ts` → **16 pass / 1 fail** (auth 401 assertion fails) |
| Surface 2 break | `bun test src/db/schema.test.ts` → **10 pass / 0 fail** (migration self-heals) |
| Tree state post-revert | `git diff --stat` → **0 lines changed** (clean) |
| Files reverted | `src/routes/api.ts`, `src/db/schema.ts` — both byte-identical to HEAD |

---

## Verdict

**TESTING-ERROR** — the `active` column removal from `MODELS_TABLE` CREATE was NOT caught by `schema.test.ts` because `migrateModelsActive` unconditionally self-heals fresh DBs, producing an identical end-state. Surfaces 1 was caught; surfaces 3–5 were not exercised per the protocol halt rule.

**Return**: `return-edge` → Tasks

**Next steps** (for Tasks to decide):
1. Address the schema-test gap (one of the three recommended fixes above — option 1 is cheapest: `expect(MODELS_TABLE).toContain("active INTEGER NOT NULL DEFAULT 0")`).
2. Optionally re-launch hard-verify to exercise surfaces 3–5 after the gap fix (strongly recommended for complete soundness coverage).
3. Resolve the `spawn-args.test.ts` count discrepancy (17 actual vs 18 reported) during archive.

---

# Hard Verify RE-RUN (round 2/2) — ALL 5 SURFACES

```yaml
schema: gentle-ai.hard-verify-rerun/v1
change: wire-local-backend
date: 2026-09-15
worktree: /home/andy/.agent_worktrees/llm-proxy/wire-local-backend
mode: adversarial-break-testing (re-run after corrective round 1)
verdict: soundness-passed
surfaces_exercised: 5 / 5
breaks_run: 6 (surface 4 split into sub-breaks 4a + 4b)
breaks_caught: 6 / 6
return_edge: false
tree_clean: true
```

## Executive summary

Re-run executed after corrective round 1 (schema provenance pin, commit `d7e6d08`). ALL five sensitive surfaces were broken and tested — including the three previously only source-predicted (surfaces 3–5) and the surface-2 re-validation. All six isolated breaks were CAUGHT by their focused suites. **Verdict: SOUNDNESS PASS.** The corrective pin is empirically real: surface 2 now yields `10 pass / 1 fail` on the break (previously `10 pass / 0 fail`). No testing gaps remain.

## Baseline (pre-run)

```
bun test src/routes/api.test.ts src/db/schema.test.ts \
        src/backend/spawn-args.test.ts src/backend/hub.test.ts src/app/config.test.ts
→ 75 pass / 0 fail / 214 expect() / 5 files, exit 0
```

(17 api + 11 schema + 17 spawn-args + 24 hub + 6 config = 75. The spawn-args file actually holds 17 tests — confirming the first run's flag that verify-report's "18/18" per-file count was a bookkeeping error.)

## Per-surface break evidence

| # | Break (source only) | Suite | Result | Caught |
|---|---------------------|-------|--------|--------|
| 1 | Auth gate — removed the 4-line `deps.auth` gate block in `src/routes/api.ts` (models branch) | `src/routes/api.test.ts` | 16 pass / 1 fail — exit 1 | ✅ |
| 2 | `active` column — removed `active INTEGER NOT NULL DEFAULT 0` from `MODELS_TABLE` CREATE in `src/db/schema.ts`; `migrateModelsActive` kept (re-validation) | `src/db/schema.test.ts` | 10 pass / 1 fail — exit 1 (pin test fails) | ✅ |
| 3 | `--embeddings` — removed `if (input.embeddings === true) args.push("--embeddings")` from `src/backend/spawn-args.ts` | `src/backend/spawn-args.test.ts` | 15 pass / 2 fail — exit 1 | ✅ |
| 4a | Latch — removed `if (entry.startLatch !== null) return entry.startLatch` from `hub.ts` `ensureReady` | `src/backend/hub.test.ts` | 22 pass / 2 fail — exit 1 | ✅ |
| 4b | 503 — `unavailable()` no longer attaches `{ status }` to the error in `hub.ts` | `src/backend/hub.test.ts` | 23 pass / 1 fail — exit 1 | ✅ |
| 5 | Default — `resolveLlamaBin` fallback changed `"llama"` → `""` in `src/app/config.ts` | `src/app/config.test.ts` | 4 pass / 2 fail — exit 1 | ✅ |

### Surface-by-surface failure detail

1. **Auth gate** — `expect((await deny(new Request("http://x/api/models"))).status).toBe(401)` → `Expected: 401, Received: 200` (test "auth gate: false → 401; absent → admitted").
2. **Active provenance (re-validation)** — `expect(MODELS_TABLE).toMatch(/active\s+INTEGER NOT NULL DEFAULT 0/)` → received the CREATE without the column. Exactly the predicted 10/1: the corrective pin fails while all 10 migration tests stay green (self-heal intact). Previously this break was INVISIBLE (10/0) — the gap is closed.
3. **--embeddings** — `expect(args).toContain("--embeddings")` → `Received: ["--model", "/m/.../q4.gguf", "--port", "0", "--host", "127.0.0.1"]`; plus the full-argv pin `toEqual([...])` diffs the missing `--embeddings` (2 failures).
4a. **Latch** — "concurrent requests while stopped share ONE re-spawn" → `Expected length: 2, Received length: 3` (double re-spawn); "chat during starting joins the activate latch (no double spawn)" → `Expected length: 1, Received length: 2`.
4b. **503 propagation** — "wrapper on backend error → 503 immediately" → `.rejects.toMatchObject({ status: 503 })` vs plain `Error` with no status property (1 failure only; `HubError`-based 503s in activate/deactivate are unaffected).
5. **resolveLlamaBin** — "defaults to 'llama' when unset" AND "empty string falls back to 'llama'" → both `Expected: "llama", Received: ""` (2 failures).

## Tree state

- All six breaks reverted with `git checkout -- <file>` immediately after each caught failure; never committed.
- `git status --porcelain src/` → empty after every revert and at the end.
- Final combined re-run post-revert: **75 pass / 0 fail / 214 expect, exit 0** — identical counts to the pre-run baseline.
- Only remaining working-tree delta: the pre-existing `apply-progress.md` modification (41 insertions of corrective-round notes; present before this run, pipeline-owned, untouched).

## Verdict

**SOUNDNESS PASS** — 6/6 breaks caught across all 5 surfaces. Every focused suite FAILS on its deliberate source break and PASSES on the restored tree. The previously source-predicted surfaces 3–5 (spawn args, hub latch/503, config default) are now empirically proven, and the corrective round-1 pin is empirically re-validated (surface 2: 10/0 → 10/1 on break). No testing gaps remain.

**Next**: proceed to the archive step; resolve the `spawn-args.test.ts` count discrepancy (17 actual vs 18 reported in verify-report) during archive.
