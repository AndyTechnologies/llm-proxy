```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:6c5e8b5883f01134530cdb507ca95b8c8ee01697bcf09e7cb17fe5057e2129be
verdict: pass
blockers: 0
critical_findings: 0
requirements: 9/9
scenarios: 24/24
test_command: bun test
test_exit_code: 0
test_output_hash: sha256:9463f5b100287a321f4eea20e0a66a51dae59a33030fe2296e5846edf6daa431
build_command: bun run build
build_exit_code: 0
build_output_hash: sha256:255fa27033ff2d57985146a8434db408167b4b22a42c85aac3bdb1ca2e35722d
```

## Verification Report

**Change**: multi-provider-pipelines
**Version**: N/A
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 24 |
| Tasks complete | 24 |
| Tasks incomplete | 0 |

### Build & Tests Execution
**Build**: ✅ Passed
```text
bun run build
$ bun build src/index.ts --target=bun --outdir dist
Bundled 132 modules in 104ms

  index.js  1.0 MB  (entry point)

(exit 0)
```

**Tests**: ✅ 432 passed / ❌ 0 failed / ⚠️ 0 skipped
```text
bun test
 432 pass
 0 fail
 1079 expect() calls
Ran 432 tests across 40 files. [6.38s]
```

**Typecheck**: ✅ `bun run typecheck` (tsc --noEmit) exit 0
**Lint**: ✅ `bun run lint` (eslint .) exit 0
**Coverage**: ➖ Not available — no coverage tool configured (`package.json` has no coverage script).

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| OpenAI-compatible provider adapter | Non-streaming external round-trip | `src/routes/external-routing.test.ts > external non-streaming request returns OpenAI-shaped JSON with rewritten id/model` | ✅ COMPLIANT |
| OpenAI-compatible provider adapter | Streaming external round-trip | `src/routes/external-routing.test.ts > external streaming ends with one terminal chunk and exactly one [DONE]` | ✅ COMPLIANT |
| OpenAI-compatible provider adapter | Tool calls survive the adapter | `src/providers/openai-compatible.test.ts > passes through tool_calls and maps the tool-calls finish reason` + `synthesizes tool_calls deltas from SDK tool-call parts` | ✅ COMPLIANT |
| Retries disabled for 429 observability | First 429 is surfaced, not retried | `src/providers/openai-compatible.test.ts > maps a 429 APICallError ... without retrying` + `maps a streamed error part ... without retrying` (both assert `calls.generate/stream === 1`) | ✅ COMPLIANT |
| SDK error translation | 429 maps to status 429 | `src/providers/openai-compatible.test.ts > maps a 429 APICallError to Error & { status: 429 }` | ✅ COMPLIANT |
| SDK error translation | Unknown model maps to status 404 | `src/providers/openai-compatible.test.ts > maps NoSuchModelError to Error & { status: 404 }` + `src/routes/external-routing.test.ts > unknown model returns 404` | ✅ COMPLIANT |
| SDK error translation | Upstream 5xx maps to its status | `src/providers/openai-compatible.test.ts > maps a 5xx APICallError to Error & { status: <statusCode> }` (503 adapter-path) + `translateSDKError` 502/503 unit + 500 fallback | ✅ COMPLIANT |
| Sampler pass-through via providerOptions | Samplers land top-level in the request body | `src/providers/openai-compatible.test.ts > routes non-reserved request keys into providerOptions under the provider name` + `providerOptionsFrom` (top_k/min_p/tools/tool_choice/n) | ✅ COMPLIANT |
| Sampler pass-through via providerOptions | Standard parameters map directly | `src/providers/openai-compatible.test.ts > maps standard parameters directly to SDK call settings (S4.2)` — asserts `calls.options[0]` carries `temperature: 0.7`, `topP: 0.9`, `maxOutputTokens: 10`, `stopSequences: ["END"]` + string-stop normalization triangulation (`calls.options[1]`) | ✅ COMPLIANT |
| Static authentication | Bearer auth is sent with static headers | `src/routes/external-routing.test.ts > the wire request carries Authorization: Bearer plus the configured static headers (S5.1)` | ✅ COMPLIANT |
| Static authentication | No apiKey means no Authorization header | `src/routes/external-routing.test.ts > a provider without apiKey sends NO Authorization header on the wire (S5.2)` | ✅ COMPLIANT |
| Abort forwarding | Client disconnect aborts the external upstream | `src/providers/openai-compatible.test.ts > aborting the signal cleanly stops the stream` + `forwards the abort signal to the model call` | ✅ COMPLIANT |
| External providers config section | Config without providers behaves unchanged | `src/config/defaults.test.ts` (7 tests) + `providers: z.record(...).default({})` (`src/config/schema.ts:252`) | ✅ COMPLIANT |
| External providers config section | Valid providers section is typed | `src/config/schema.test.ts` (15 tests, incl. externalProviderSchema) | ✅ COMPLIANT |
| External providers config section | Invalid provider entry fails validation | `src/config/schema.test.ts > missing baseURL/models → zod error, strict mode rejects unknown keys` | ✅ COMPLIANT |
| External providers config section | Env interpolation resolves at load | `src/config/env.test.ts` (9 tests, apiKey/headers `${VAR}`) | ✅ COMPLIANT |
| External providers config section | Unset env reference fails load | `src/config/env.test.ts > fail-closed naming the variable` + `src/config/load.ts:92` (`env var ${name} is not set`) | ✅ COMPLIANT |
| External model listing and unknown-model 404 | Models list includes external models | `src/routes/external-routing.test.ts > /v1/models lists external + llama + gateway/*` + `src/routes/models.test.ts` (owned_by = providerName, `models.ts:101-106`) | ✅ COMPLIANT |
| External model listing and unknown-model 404 | Unknown model returns typed 404 | `src/routes/external-routing.test.ts > unknown model returns 404 with code model_not_found` | ✅ COMPLIANT |
| External model listing and unknown-model 404 | External model request is served | `src/routes/external-routing.test.ts > external model is served even when the managed backend is unavailable` | ✅ COMPLIANT |
| Named-provider targeting on llm_call | Node targets a configured external provider | `src/orchestrator/graph-engine.test.ts > node.provider resolves to the named external provider for non-streaming steps` (`calls.chat === ["openai"]`) | ✅ COMPLIANT |
| Named-provider targeting on llm_call | Chain default resolves the external provider | `src/config/index.test.ts` (NEW, 4 tests: defaultProvider → external-a; chain.provider precedence; llama-server fallback; explicit node provider kept) — pins `src/config/index.ts:35` `chain.provider ?? chain.defaultProvider ?? "llama-server"` | ✅ COMPLIANT |
| Named-provider targeting on llm_call | No provider configured keeps the local path | `src/orchestrator/graph-engine.test.ts > a node without provider falls back to the first map entry (llama path unchanged)` (`calls.chat === ["llama-server"]`, content `out-llama-server`) | ✅ COMPLIANT |
| Named-provider targeting on llm_call | External final node streams over the same contract | `src/orchestrator/graph-engine.test.ts > an external final chain node streams through the named provider with one [DONE]` (`calls.stream === ["openai"]`, 1 DONE) + `external-routing.test.ts > streaming` | ✅ COMPLIANT |

**Compliance summary**: 24/24 scenarios compliant (0 PARTIAL, 0 UNTESTED, 0 VIOLATED, 0 FAILING)

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| OpenAI-compatible provider adapter | ✅ Implemented | `src/providers/openai-compatible.ts`: `generateText`/`streamText` from `createOpenAICompatible`, `include: { rawChunks: true }` (L308), abortSignal forwarded (L307), tool-call finish parts mapped via `toFinishReason`, envelope rebuilt in `rebuildEnvelope`. |
| Retries disabled for 429 observability | ✅ Implemented | `maxRetries: 0` on both generate (L276) and stream (L306) (ADR-2); first 429 surfaces with `status: 429` for `on_429` routing. |
| SDK error translation | ✅ Implemented | `translateSDKError`/`errorStatus` walk NoSuchModelError→404, APICallError→`statusCode ?? 500` (L128), StreamProviderError→statusCode/cause walk, RetryError→errors+lastError walk; design maps APICallError to its OWN statusCode (no forced 502 — the spec 502 case is input→output). |
| Sampler pass-through via providerOptions | ✅ Implemented | `providerOptionsFrom` raw-spreads non-reserved keys under `providerOptions[<name>]`; `callSettingsFrom` (L104-123) maps temperature/topP/maxOutputTokens/stopSequences/seed/penalties — now directly asserted by the S4.2 test (task 6.7). |
| Static authentication | ✅ Implemented | Conditional apiKey spread (L259) + headers (L260) into `createOpenAICompatible`; wire behavior pinned by S5.1/S5.2 integration tests. |
| Abort forwarding | ✅ Implemented | `abortSignal` forwarded to the SDK (L307); `abort` part → clean return (L365-367); `isAbortError` catch → clean return (L371). |
| External providers config section | ✅ Implemented | `externalProviderSchema.strict()` (baseURL required, apiKey?, headers?, models[] required); `providers: z.record().default({})` backward compat (schema.ts:252); `${ENV}` interpolation fail-closed naming the variable verbatim (load.ts:92). |
| External model listing and unknown-model 404 | ✅ Implemented | `/v1/models` lists externals with `owned_by` = provider name (no meta) alongside llama + `gateway/*` (models.ts:101-106); unknown model → typed 404 `model_not_found` before backend gate (chat.ts:140-143, completions.ts:142). |
| Named-provider targeting on llm_call | ✅ Implemented | Engine resolution `node.provider` → named map entry, no-provider → first map entry (frozen, tests-only change); chain default normalized at config load (`src/config/index.ts:35-38`) — both legs now covered (graph-engine.test.ts + config/index.test.ts). |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| ADR-1: ai@7.0.93 + @ai-sdk/openai-compatible@3.0.44 | ✅ Yes | Pinned in `package.json` + `bun.lock`; adapter behind frozen `Provider` seam; llama-server untouched. |
| ADR-2: maxRetries: 0 | ✅ Yes | Verified in `openai-compatible.ts` (generate L276 and stream L306). |
| ADR-3: rawChunks included | ✅ Yes | `include: { rawChunks: true }` (L308); verbatim passthrough + fallback synthesis pinned by tests. |
| ADR-4: providerOptions top-level samplers | ✅ Yes | `providerOptionsFrom` + `providerOptions: <name>` merge; tested for top_k/min_p/tools/tool_choice; standard settings asserted via S4.2. |
| ADR-5: zod ^3.25.76 record default | ✅ Yes | `z.record(...).default({})` provides backward compatibility; `defaults.test.ts` asserts `providers: {}`. |
| ADR-6: translateSDKError (status-carrying errors) | ✅ Yes | Verified translation walk; 429/404/5xx/500 now all covered at runtime. |
| ADR-7: externalModels map at boot | ✅ Yes | `src/index.ts:351-363` builds map from `config.providers`, adapters appended after llama-server (stays first). |
| ADR-8: apply-reload rebuild of adapters | ✅ Yes | Reload path rebuilds providers + externalModels map; no `noteActivity` for external providers. |
| Frozen list | ✅ Yes | `src/providers/types.ts`, `src/orchestrator/engine.ts` (buildStreamBody), `src/backend/manager.ts` untouched (git status empty). `graph-engine.ts` prod, `llama-server.ts`, `proxy.ts` and `dashboard/service.ts` carry concurrent F2 diffs WITHOUT external-provider content (fresh grep scan this session: zero matches for external/openai/providerOptions/externalModels/ai-sdk across those four diffs); HEAD `graph-engine.ts` already reads `n.provider` (L244-245) — this change added graph-engine tests only. |

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | "TDD Cycle Evidence" table present in merged apply-progress (Engram obs #282) — per-task RED/GREEN/Refactor-Verify/Evidence rows for all 17 tasks + 7 remediation tasks (incl. 6.7 S4.2). |
| All tasks have tests | ✅ | 24/24 tasks covered: RED test files verified present (openai-compatible.test.ts, external-routing.test.ts, config/index.test.ts NEW, env/schema/defaults.test.ts, graph-engine.test.ts external section); wiring-only tasks covered via integration suites. |
| RED confirmed (tests exist) | ✅ | All change test files exist and contain the named tests; S4.2 test verified at `openai-compatible.test.ts:285` this session. |
| GREEN confirmed (tests pass) | ✅ | 432 pass / 0 fail on full-suite execution (2 consecutive full runs this session); focused re-run of the 6 key files green (76 pass / 0 fail / 199 expects). |
| Triangulation adequate | ✅ | Behaviors triangulated with distinct expected values; S4.2 now triangulated (array stop + string-stop normalization → single-element array). |
| Safety Net for modified files | ✅ | Reported in apply-progress: "65 pass / 0 fail baseline on all touched files before edits"; suite regressions none (432/0 on current tree). |

**TDD Compliance**: 6/6 checks passed

---

### Test Layer Distribution
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 27 | 3 | bun:test (fake LanguageModelV4 injected into real AI SDK pipeline; config load with injected file/yaml seams) |
| Integration | 7 | 1 | bun:test + real Bun.serve wire-mock (real adapter, real HTTP) |
| E2E | 0 | 0 | not available for this change |
| **Total** | **34** | **4** | |

34 additive tests = baseline 398 → 432 (batch 1: 23; remediation 6.2-6.5: 10; 6.7 S4.2: 1). No tests use tools outside the detected capabilities.

---

### Changed File Coverage
Coverage analysis skipped — no coverage tool detected (`package.json` has no coverage script; `bun test` has no `--coverage` support configured in this project). Informational, not blocking.

---

### Assertion Quality
**Assertion quality**: ✅ All assertions verify real behavior

Audit of all change test files (Step 5f): no tautologies; no ghost loops (streaming assertions filter chunk arrays and assert explicit counts before values; the `[DONE]`/terminal counts are asserted outside loops); no type-only assertions used alone (the 502/503 translation tests also assert `message` preservation); abort test's `toEqual([])` has a companion non-abort test asserting non-empty output; wire-auth tests assert real header VALUES captured from the wire mock; config/index.test.ts asserts resolved provider NAME values (real mutation target); the S4.2 test asserts real SDK call-settings values (`temperature: 0.7`, `topP: 0.9`, `maxOutputTokens: 10`, `stopSequences`) captured from the options the SDK handed to the fake model. Mocks are injected seam fakes (model factory, file/yaml deps), not `vi.mock` — healthy ratio (1 fake per file vs multiple value assertions per test).

---

### Quality Metrics
**Linter**: ✅ No errors (`bun run lint`, exit 0)
**Type Checker**: ✅ No errors (`bun run typecheck`, tsc --noEmit, exit 0)

### Issues Found
**CRITICAL**: None

**WARNING**:
1. `/v1/completions` external path has no dedicated integration test (task 3.3 shares the `chat.ts` dispatch code — verified present at `completions.ts:142` and covered by the full-suite green run). WARNING, not escalated: the shared dispatch branch is exercised via the chat path and the route reuses the chat-payload conversion.
2. Verification gate ran against a working tree with concurrent uncommitted changes (`graph-engine.ts` loop support, `llama-server.ts` lifecycle, `proxy.ts` passthrough, dashboard `ui-dark-theme`). Full suite (432) passes on the combined tree; frozen-file violations by THIS change: none (fresh grep scan of those diffs shows zero external-provider content). Recommend committing this change's scope files (or rebasing) before archive so the tree is attributable.
3. Live llama-server streaming smoke not run — requires llama binary + models unavailable in this environment; the external contract is covered by wire-mock integration instead.

**SUGGESTION**:
1. Integration assertion on a top-level body field (e.g. `temperature` or a sampler like `top_k`) in the wire-mock request body to pin the SDK providerOptions/settings merge end-to-end — the S4.2 mapping is now closed at unit level; a wire-level assertion would be belt-and-braces.

### Prior CRITICALs — Resolution Trace (evidence_revision sha256:6c5e8b58…)
| # | Prior CRITICAL | Resolution Evidence | Status |
|---|----------------|---------------------|--------|
| 1 | TDD Cycle Evidence table missing from apply-progress | Table now present in merged apply-progress (Engram obs #282): per-task RED/GREEN/Refactor-Verify/Evidence for 17 tasks + 7 remediation rows. | ✅ RESOLVED |
| 2 | "Upstream 5xx maps to its status" UNTESTED | 4 tests in `src/providers/openai-compatible.test.ts`: adapter-path 503 ("maps a 5xx APICallError"), `translateSDKError` 502 unit, 503 unit, non-status 500 fallback. Design maps APICallError to its own statusCode — no forced 502. | ✅ RESOLVED |
| 3 | "Bearer auth is sent with static headers" UNTESTED | Integration test `external-routing.test.ts > the wire request carries Authorization: Bearer plus the configured static headers (S5.1)` — real adapter, real wire mock, asserts `authorization: Bearer sk-test-123` + `x-static-header` + `x-tenant` values. | ✅ RESOLVED |
| 4 | "No apiKey means no Authorization header" UNTESTED | Integration test `external-routing.test.ts > a provider without apiKey sends NO Authorization header on the wire (S5.2)` — asserts `authorization` is `null` on the wire. | ✅ RESOLVED |
| 5 | "Chain default resolves the external provider" UNTESTED | NEW `src/config/index.test.ts` — 4 tests: defaultProvider→external-a, chain.provider precedence, llama-server fallback, explicit node provider kept. Pins `src/config/index.ts:35`. Mutation-checked real RED per apply evidence. | ✅ RESOLVED |

### Admission-gap closure (previous `fail` envelope, evidence_revision sha256:29c2af51…)
The single incomplete scenario was S4.2 "Standard parameters map directly" (⚠️ PARTIAL): `callSettingsFrom` was code-complete (temperature→temperature, top_p→topP, max_tokens→maxOutputTokens, stop→stopSequences, seed, presence/frequency penalties) but only the RESERVED_KEYS exclusion side was asserted. Task 6.7 added one additive unit test — `openai-compatible.test.ts > maps standard parameters directly to SDK call settings (S4.2)` (L285): asserts `calls.options[0]` carries `temperature: 0.7`, `topP: 0.9`, `maxOutputTokens: 10`, `stopSequences: ["END"]` and triangulates string-stop normalization (`calls.options[1]` single-element array). Verified this session: the test exists, passed in the focused re-run (76 pass / 0 fail across the 6 key files) and in the full suite. S4.2 is now COMPLIANT → 24/24 scenarios, 9/9 requirements, `pass` envelope admitted.

### Verdict
PASS
All 24 spec scenarios have passing covering tests (0 PARTIAL / 0 UNTESTED / 0 FAILING), all 9 requirements are implemented with verified design coherence, all 24 tasks are complete, and the full gate is green on this session's independent execution: `bun run typecheck` exit 0, `bun run lint` exit 0, `bun test` 432 pass / 0 fail / 1079 expects / 40 files (exit 0, output sha256:9463f5b1…), `bun run build` exit 0 (output sha256:255fa270…). `gentle-ai sdd-verify-validate --requirements 9 --scenarios 24` admits the `pass` envelope — archive-ready.