# Proposal: Fix LLM Proxy Bugs

## Intent

Four confirmed bugs degrade/break the proxy: ReferenceError crashes streaming; disabled role normalization causes llama.cpp grammar failures; catch double-close emits contradictory SSE; NaN sanitization sends invalid params. Fixing restores reliable OpenAI-compatible behavior.

## Scope

### In Scope
- Declare missing `finishReasonRecibido` in `runPipelineStream` (Bug 1)
- Restore `developer→system` role normalization + array-content flattening in `sanitizePayloadForLlamaCpp` (Bug 2)
- Remove duplicate error payload after `enviarChunkFinal()` in catch block (Bug 3)
- Guard sanitization against non-numeric inputs; safe defaults for `temperature`, `top_p`, `max_tokens` (Bug 4)

### Out of Scope
- Introducing a test runner (strict_tdd: false)
- Refactoring pipeline architecture
- Adding endpoints or changing response format

## Capabilities

### New Capabilities
None — bug fixes restoring existing expected behavior.

### Modified Capabilities
None — implementation only; no spec-level requirement changes.

## Approach

Each bug gets its own commit:

1. **Bug 1**: Add `let finishReasonRecibido = null;` at top of `runPipelineStream`, matching the commented `upstreamFinished` pattern (~line 100).
2. **Bug 2**: Uncomment normalization block (lines 62–75); verify array-content flattening handles both `{type:"text",text:"..."}` and plain strings.
3. **Bug 3**: Remove the `errorPayload` write after `enviarChunkFinal()` has sent the terminal chunk.
4. **Bug 4**: Replace `Number(payload.x)` with a guarded helper falling back to safe defaults on `NaN`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `pipelines.js` | Modified | Bugs 1, 3 — variable declaration and catch cleanup |
| `utils/micro.js` | Modified | Bugs 2, 4 — role normalization and NaN-safe sanitization |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Uncommenting normalization changes valid-payload behavior | Low | Normalization only triggers on `developer` role / array content |
| NaN guard changes edge-case behavior | Low | Broken today; working tomorrow |

## Rollback Plan

Each commit is independently revertable via `git revert <commit>`. No cross-commit dependencies.

## Dependencies

- None — fixes are self-contained.

## Success Criteria

- [ ] `node --check pipelines.js` and `node --check utils/micro.js` pass
- [ ] Streaming requests complete without ReferenceError
- [ ] `developer` role requests reach llama.cpp without grammar parse failure
- [ ] Catch-block errors produce a single terminal SSE chunk
- [ ] Non-numeric temperature/top_p/max_tokens produce no NaN in outbound payload

## Commits (Work Units)

| # | Message | Files |
|---|---------|-------|
| 1 | `fix(pipelines): declare finishReasonRecibido in streaming` | `pipelines.js` |
| 2 | `fix(micro): restore developer→system normalization` | `utils/micro.js` |
| 3 | `fix(pipelines): remove duplicate error payload in catch` | `pipelines.js` |
| 4 | `fix(micro): guard sanitization against NaN values` | `utils/micro.js` |

Size: ~40 changed lines — well within 400-line budget, single PR.
