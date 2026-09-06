# Archive Report: context-aware-selector

**Archived**: 2026-09-04
**Change**: context-aware-selector
**Artifacts Read**: proposal.md, design.md, tasks.md, verify-report.md, specs/gguf-metadata/spec.md, specs/dashboard-api/spec.md, specs/dashboard-ui/spec.md

## Summary

| Field | Value |
|-------|-------|
| Verdict | PASS |
| Tests | 284 pass, 0 fail (678 assertions) |
| Typecheck | clean (tsc --noEmit) |
| Lint | clean (eslint) |
| Requirements | 5 / 5 completed |
| Scenarios | 16 / 16 completed |
| Tasks | 9 / 10 (manual verification deferred) |

## Spec Compliance

### gguf-metadata (NEW — 3 requirements, 6 scenarios)

| Requirement | Status |
|-------------|--------|
| GGUF header parsing | COMPLIANT |
| Context length extraction | COMPLIANT |
| Graceful fallback on parse failure | COMPLIANT |

### dashboard-api (MODIFIED — 1 requirement updated)

| Requirement | Status | Change |
|-------------|--------|--------|
| Model list endpoint | COMPLIANT | Added `ggufContextLength` and `hardwareMaxCtx` fields; added 3 new scenarios (GGUF context, hardware max, parse failure) |

### dashboard-ui (MODIFIED — 1 requirement updated)

| Requirement | Status | Change |
|-------------|--------|--------|
| Execution and model inspection | COMPLIANT | Added GGUF metadata rendering, dynamic context filtering, unsafe range indicator, fallback behavior (3 new scenarios) |

## Files

### Created

| File | Purpose |
|------|---------|
| `src/utils/gguf.ts` | GGUF binary header parser (`parseGgufHeader`, `hardwareMaxCtx`) |
| `src/utils/gguf.test.ts` | 20 unit tests for GGUF parsing and hardware heuristic |

### Modified

| File | Change |
|------|--------|
| `src/index.ts` | Wired `parseGgufHeader()` and `hardwareMaxCtx()` into `modelDetails()` |
| `src/dashboard/router.ts` | Updated `DashboardRouterDeps.modelDetails` return type; added GGUF fields to response |
| `src/dashboard/router.test.ts` | Extended `ModelSummary` fixture and assertions for new fields |
| `src/ui/app.js` | Replaced hardcoded `CONTEXT_STANDARDS` with dynamic filtering; added `ctx-unsafe` CSS class |
| `src/dashboard/server-dispatch.test.ts` | Updated dispatch test fixtures |
| `e2e/e2e-server.ts` | Updated e2e test server |

## Spec Sync

| Domain | Action | Details |
|--------|--------|---------|
| gguf-metadata | Created | 3 requirements, 6 scenarios — new spec synced to `openspec/specs/gguf-metadata/spec.md` |
| dashboard-api | Updated | Model list endpoint requirement updated with `ggufContextLength` and `hardwareMaxCtx` fields and 3 new scenarios |
| dashboard-ui | Updated | Execution and model inspection requirement updated with GGUF metadata, dynamic filtering, and 3 new scenarios |

## Known Deferrals

- **Task 4.4**: Manual server verification with a real `.gguf` model was deferred. Automated tests validate logic; runtime integration with real GGUF files remains unverified. This is a verification task, not an implementation task — no code change required.
