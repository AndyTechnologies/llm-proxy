# Tasks: Fix LLM Proxy Bugs

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~40 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR (4 work-unit commits) |
| Delivery strategy | auto-chain |
| Chain strategy | N/A — single PR |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: N/A
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Declare `finishReasonRecibido` (Bug 1) | PR 1 | `node --check pipelines.js` | N/A — no test runner; manual smoke `/v1/chat/completions?stream=true` | `pipelines.js` line ~100 only |
| 2 | Restore role normalization (Bug 2) | PR 1 | `node -e` import + call `sanitizePayloadForLlamaCpp` with developer role | N/A — manual smoke | `utils/micro.js` normalization block |
| 3 | Fix catch single terminal (Bug 3) | PR 1 | `node --check pipelines.js` | N/A — force upstream error, verify single terminal chunk | `pipelines.js` catch block |
| 4 | Guard NaN sanitization (Bug 4) | PR 1 | `node -e` call `finiteNumber` edge cases | N/A — manual smoke with bad temperature | `utils/micro.js` helper + sanitize |

## Phase 1: Core Fixes

- [ ] 1.1 **Bug 1** — In `pipelines.js`, add `let finishReasonRecibido = false;` at top of `runPipelineStream` (replacing commented `//let upstreamFinished = false;` ~line 100). Verify: `node --check pipelines.js` passes.
- [ ] 1.2 **Bug 2** — In `utils/micro.js`, uncomment + extend normalization block: map `developer→system` role and flatten array `content` (`{type:"text",text:"..."}` and plain strings) to concatenated string. Verify: `node -e` with `sanitizePayloadForLlamaCpp({messages:[{role:"developer",content:[{type:"text",text:"hello"}]}]})` yields `role:"system"`, `content:"hello"`.
- [ ] 1.3 **Bug 3** — In `pipelines.js` catch block: replace body with single terminal chunk `finish_reason: null` + `error.message` in-band (NOT fake `finish_reason:"stop"`), followed by `[DONE]` and `res.end()`. Remove `errorPayload` block (lines ~193–211). **Design decision**: Alternative B (finish_reason:null + error.message) chosen over design's Alternative A (finish_reason:stop) because the spec requires the client see the error; a fake "stop" loses error visibility. Verify: `node --check pipelines.js` passes.
- [ ] 1.4 **Bug 4** — In `utils/micro.js`, add `finiteNumber(value, fallback, min, max)` helper. Apply ONLY when field is present (`if (payload.x !== undefined)`): `temperature→0.7,0,2`; `top_p→1,0,1`; `max_tokens→2048,1,8192`. **Gatekeeper drift correction**: DO NOT add default when field is absent — preserve current `if (payload.x !== undefined)` guard. Verify: `node -e` with `finiteNumber("abc",0.7,0,2)` returns `0.7`; `finiteNumber(undefined,0.7,0,2)` with absent field → field not in output.

## Phase 2: Verification

- [ ] 2.1 Run `node --check pipelines.js` and `node --check utils/micro.js` — both pass syntax check.
- [ ] 2.2 Verify streaming request completes: `curl -X POST /v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"local","messages":[{"role":"user","content":"hi"}],"stream":true}'` returns `[DONE]` with no ReferenceError.
- [ ] 2.3 Verify catch single terminal: force upstream error mid-stream → exactly one terminal chunk with `finish_reason:null` and error message, no second errorPayload.
- [ ] 2.4 Verify NaN guard: request with `temperature:"abc"` → outbound payload has `temperature:0.7` (finite, not NaN).

## Phase 3: Commit

- [ ] 3.1 Commit as `fix(pipelines): declare finishReasonRecibido in streaming` — file: `pipelines.js` (Bug 1).
- [ ] 3.2 Commit as `fix(micro): restore developer→system normalization` — file: `utils/micro.js` (Bug 2).
- [ ] 3.3 Commit as `fix(pipelines): remove duplicate error payload in catch` — file: `pipelines.js` (Bug 3).
- [ ] 3.4 Commit as `fix(micro): guard sanitization against NaN values` — file: `utils/micro.js` (Bug 4).
