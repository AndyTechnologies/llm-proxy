# Tasks: Context-Aware Selector

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~300 (new: ~220, modified: ~80) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | All work in one PR | PR 1 | `bun test src/utils/gguf.test.ts && bun test src/dashboard/router.test.ts` | Manual: `GET /api/ui/models` with real `.gguf` files | `src/utils/gguf.ts` + all wired changes revert together |

## Phase 1: GGUF Parser + Hardware Heuristic

- [x] 1.1 Create `src/utils/gguf.ts` with `GgufParseResult` interface, `parseGgufHeader(filePath)` and `hardwareMaxCtx(bytesPerToken?)` exports — validate magic `0x47475546`, parse version/KV-count at fixed offsets, scan KV pairs for `general.context_length` (UINT32 tag=4) and `architecture` (STRING tag=8), all wrapped in try/catch returning null fields
- [x] 1.2 Create `src/utils/gguf.test.ts` — RED: write failing tests for valid parse, magic rejection, corrupt header fallback, missing context_length, unreadable file, `hardwareMaxCtx` with mocked `os.totalmem()`
- [x] 1.3 Make tests GREEN: implement binary parsing logic, `Bun.file().arrayBuffer()` read, DataView scanning, `os.totalmem()` heuristic (25% reserve, floor to power-of-two), fallback `65536` on `os.totalmem()` failure

## Phase 2: API Enrichment

- [x] 2.1 Modify `src/dashboard/router.ts` — update `DashboardRouterDeps.modelDetails` return type to include `ggufContextLength: number | null` and `hardwareMaxCtx: number`, update the `GET /api/ui/models` response construction (line ~201) to pass these fields through
- [x] 2.2 Modify `src/index.ts` — import `parseGgufHeader` and `hardwareMaxCtx` from `./utils/gguf.js`, import `path` from `node:path`, extend the `modelDetails()` wiring (line ~174) to call both functions per model entry
- [x] 2.3 Modify `src/dashboard/router.test.ts` — update `ModelSummary` interface and `makeDeps` modelDetails fixture to include the two new fields, update assertions for `GET /api/ui/models` to verify `ggufContextLength` and `hardwareMaxCtx` appear in response

## Phase 3: UI Context Selector

- [x] 3.1 Modify `src/ui/app.js` — in `contextEditorHtml(node)` (line ~489), look up `state.models` for the selected model, compute `effectiveMax = min(ggufContextLength, hardwareMaxCtx)` (or fallback to whichever is available), filter `CONTEXT_STANDARDS` to options ≤ `effectiveMax`
- [x] 3.2 Add `ctx-unsafe` CSS class logic — options above `hardwareMaxCtx` but within `ggufMax` get a dimmed/flagged visual treatment in the `<option>` elements
- [x] 3.3 Handle fallback — when `ggufContextLength` is null, use `hardwareMaxCtx` only; when both null, show full `CONTEXT_STANDARDS` (existing behavior preserved)

## Phase 4: Verification

- [x] 4.1 Run `bun test` — all existing tests pass, new `gguf.test.ts` and updated `router.test.ts` pass
- [x] 4.2 Run `bun run typecheck` — no type errors from updated interfaces
- [x] 4.3 Run `bun run lint` — no lint violations
- [ ] 4.4 Manual verification: start dev server with a real `.gguf` model, call `GET /api/ui/models`, confirm `ggufContextLength` and `hardwareMaxCtx` are present and correct
