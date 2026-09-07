# Archive Report — svelte-ui

**Change**: svelte-ui (Svelte UI Re-platform)
**Archived**: 2026-09-07 → `openspec/changes/archive/2026-09-07-svelte-ui/`
**Artifact store**: openspec
**Branch at close**: `svelte-ui/pr3`, HEAD `fdb3f02`

## Status

**ARCHIVED** — SDD cycle complete. Implementation verified, delta spec synced to the
main spec store, change folder moved to archive with byte-identical readback.

## Summary

Re-platformed the static `/ui` SPA (`src/ui/`: 2,325-line imperative `app.js`) to a
compiled Svelte 5 CSR SPA (`src/ui-svelte/`, Vite build-only, devDeps-only) served by
the Bun backend: per-segment traversal-guarded asset resolution with `/ui/*` fallback,
hashed asset subdirectories, embedded `--asset dist/ui` binary with disk fallback and
`UI_DIR` override. Parity retained across five views with Rioplatense copy; editor
gained bounded undo/redo, connection handling (24 px hit radius, self-edge reject),
executions list-level with step retry, models/backend lifecycle panel, trace logging
with debug/verbose mode, and full 8-event SSE coverage with throttled refresh.
Legacy `src/ui/*` deleted (commit `6898c5f`) after verification; references updated
(README, `src/index.ts`, `src/server.ts`).

## Tasks Reconcile (Task Completion Gate)

- Persisted tasks artifact read: `openspec/changes/{svelte-ui}/tasks.md` (pre-move) and
  `openspec/changes/archive/2026-09-07-svelte-ui/tasks.md` (post-move).
- **22/22 tasks `[x]`, 0 unchecked** — gate PASSED, no stale-checkbox reconciliation
  required. Task 4.4 (gate + legacy `src/ui/*` delete) completed in commit `6898c5f`;
  its note "Verify re-run is the next step" is satisfied by `verify-report.md`
  (the verify re-run persisted at `06:53` on the archived folder).

## Verification Reconcile

`verify-report.md` (schema `gentle-ai.verify-result/v1`, evidence-revision
`sha256:a02ad80f…`, verdict **PASS WITH WARNINGS**) is an intermediate snapshot taken
at HEAD `0ba2a1c`. Final state per the orchestrator's final-state facts (highest
rank after the tasks artifact) and the apply-progress committed state:

| Verify finding | Final state at close |
|---|---|
| CRITICAL | None (0). Archive is not blocked. |
| WARNING-1 — apply-progress test-count drift (792→716) | **RESOLVED** in commit `fdb3f02` (HEAD at close). The suite reports **716 pass / 1807 expects / 0 fail** (58 files) after the legacy `src/ui/*` deletion removed the 76-case JS `graph-model.test.js` suite — covered by the TS port oracle (`src/ui-svelte/lib/graph-model.test.ts`, 76 pass / 144 expects). apply-progress.md already records the corrected figures (lines 9–11, 2026-09-06). |
| WARNING-2 — e2e harness `fakeManager()` lacks `modelContext` | **PRE-EXISTING, non-blocking, no spec violation.** `e2e/e2e-server.ts:70-81` stubs status/start/stop only, so `/v1/models` 500s inside the harness; dates from wiring `a344fe2`/`9376366` and is covered by unit tests (`src/routes/models.test.ts`). All 17 e2e tests pass. Carried forward by task 2.4's harness rewrite; does not block archive. |
| SUGGESTION-1 / SUGGESTION-2 | Non-blocking a11y/guard-policy suggestions; no action required for archive. |

Final-state gate on HEAD `fdb3f02` (orchestrator final-state facts):
typecheck clean, lint clean, `bun test` 716 pass / 0 fail (1807 expects),
`bun run test:e2e` 17 pass / 0 fail, `bun test ./scripts/binary-smoke.test.ts` 6 pass /
0 fail, `bun run build:ui` 32.14 KB gzip ≤ 100 KB, `bun run build:binary` OK.

## Spec Sync (Delta → Main Specs)

Delta: `specs/dashboard-ui/spec.md` (9 requirement blocks: 2 MODIFIED + 7 ADDED).
Target: `openspec/specs/dashboard-ui/spec.md` (existing main spec).

| Section | Action | Result |
|---|---|---|
| MODIFIED: "Compiled SPA serving (was Static SPA serving)" | Replaced `### Requirement: Static SPA serving` | 5 scenarios (was 2) |
| MODIFIED: "Svelte frontend (was Vanilla frontend)" | Replaced `### Requirement: Vanilla frontend` | 2 scenarios (was 1) |
| ADDED ×7 (undo/redo, executions list-level, models lifecycle, trace logging, SSE coverage, bundle/binary, five-view parity) | Appended to main spec Requirements | 7 requirements, 9 scenarios |
| REMOVED | None | — |
| RENAMED | None standalone (both renames carried inside the MODIFIED blocks per delta) | — |

Main spec now **15 requirements / 31 scenarios**; 8 pre-existing requirements outside
the delta preserved unchanged (Accessibility and keyboard navigation, Graph editing and
validation, Condition AST builder, Apply with connection validation, Execution and model
inspection, Dark technical theme — all untouched). Config `rules.archive`
("Warn before merging destructive deltas"): no destructive merge occurred — no
requirements removed, no large-section deletion — so no destructive-merge warning
applies.

## Archive Contents

`openspec/changes/archive/2026-09-07-svelte-ui/`:

- `proposal.md` ✅
- `quest.md` ✅
- `exploration.md` ✅
- `design.md` ✅
- `specs/dashboard-ui/spec.md` ✅ (delta spec, audit trail)
- `tasks.md` ✅ (22/22 `[x]`, 0 unchecked)
- `apply-progress.md` ✅ (Units 1–3, attempt accounting)
- `verify-report.md` ✅ (PASS WITH WARNINGS; snapshot at HEAD `0ba2a1c`)
- `archive-report.md` ✅ (this file; additive-only, excluded from readback)
- `.gentle-ai-instance` ✅

Active `openspec/changes/` no longer contains the change (only `archive/`).

## Archive Readback

Mechanical move (`git mv` attempted → failed: change folder untracked in git per SDD
repo-local mode; plain `mv` fallback used, sanctioned by the sdd-archive skill step 3):

```
$ diff -r "$snapshot_root/source" "$source"   # pre-move integrity, empty
$ diff -r "$snapshot_root/source" "$destination"  # post-move readback, EMPTY (byte-identical)
ARCHIVE MOVE OK: byte-identical readback passed
```

Both `diff -r` runs produced **empty output (no differences)** — the only passing
evidence. No file content passed through the model Read/Write path.

Delivery note (per orchestrator): PRs created in chain — #27 (`pr1`→tracker, draft),
#28 (`pr2`→pr1), #29 (`pr3`→pr2). Not merged; delivery is ordinary repository policy
after archive.

## Risks

None outstanding. WARNING-2 (e2e harness `fakeManager()` missing `modelContext`) is a
pre-existing, non-blocking test-harness gap carried forward; a future harness fix can
add the stub without touching this change's scope. PRs #27–#29 remain unmerged (delivery
step, not an SDD-cycle blocker).

## Next Recommended

`sdd-changelog` — generate the release narrative and semantic-version classification
from this archived change's final artifacts.

## Skill Resolution

`paths-injected` — loaded `sdd-archive/SKILL.md`, `_shared/sdd-phase-common.md`, and
`_shared/openspec-convention.md` from the exact paths provided by the orchestrator.