# Tasks: Multi-Provider Pipelines

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~950-1200 authored add+del (no goldens) |
| 400-line budget risk | High |
| 1500-line budget risk | Medium — under ceiling |
| Chained PRs recommended | No |
| Delivery strategy | single-pr |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Deps bump | PR 1 | `bun test` | N/A — suite green | Revert package.json/bun.lock |
| 2 | Config + interpolation | PR 1 | `bun test src/config/` | N/A — unit | Revert `src/config/*` |
| 3 | Adapter + contract tests | PR 1 | `bun test src/providers/openai-compatible.test.ts` | N/A — fake model | Delete adapter + test |
| 4 | Boot/routes wiring | PR 1 | `bun test src/routes/models.test.ts` | N/A — covered by unit 5 | Revert wiring files |
| 5 | Integration tests | PR 1 | `bun test src/routes/external-routing.test.ts` | Bun.serve + mock server | Delete test files |

## Phase 1: Foundation — deps + config

- [x] 1.1 `package.json`: add `ai@7.0.93`, `@ai-sdk/openai-compatible@3.0.44`, zod `^3.25.76` (lock pins 3.25.76); `bun install`. Verify: `bun run typecheck && bun test`.
- [x] 1.2 RED `src/config/schema.test.ts`: strict schema (unknown key), missing baseURL/models → zod error, `providers` default `{}`.
- [x] 1.3 GREEN `src/config/schema.ts`: `externalProviderSchema` `.strict()` + `providers: z.record(...).default({})` + exported types.
- [x] 1.4 RED `src/config/env.test.ts`: `${ENV}` resolves in apiKey/headers; unset var fails naming the variable verbatim.
- [x] 1.5 GREEN: `interpolateProviderSecrets` (`src/config/load.ts`) called post-parse in `loadGatewayConfig` (`src/config/index.ts`); defaults assert `providers: {}`.

## Phase 2: Adapter

- [x] 2.1 RED `src/providers/openai-compatible.test.ts` (fake LanguageModelV4, no network): non-stream wire shape (tool_calls stringified, finish_reason, usage); stream raw passthrough + fallback synthesis + terminal; error → throw (status 429/404/5xx); abort → clean stop; samplers top-level via providerOptions; maxRetries:0 + abortSignal forwarded.
- [x] 2.2 GREEN `src/providers/openai-compatible.ts`: `makeOpenAICompatibleProvider`, `providerOptionsFrom`, `translateSDKError`, `toFinishReason`; chat via `generateText` (envelope reconstruction); chatStream via `streamText({maxRetries:0, abortSignal, include:{rawChunks:true}})` + `includeUsage:true`.

## Phase 3: Wiring — routes + boot

- [x] 3.1 `src/server.ts`: `externalModels: Map<string,string>` in ServerDeps; pass to models/chat/completions deps.
- [x] 3.2 `src/routes/chat.ts`: external dispatch before backendAvailable gate — non-stream `provider.chat(body, model)` + id/model/created rewrite; stream → `buildStreamBody` (unchanged); `modelExists` + externals → 404 model_not_found.
- [x] 3.3 `src/routes/completions.ts`: same dispatch, reusing chat-payload conversion.
- [x] 3.4 `src/routes/models.ts`: external entries `{ id, object, created, owned_by: providerName }` (no meta).
- [x] 3.5 `src/index.ts`: external adapters appended after llama-server + externalModels map; rebuild on applyService reload (ADR-7); no noteActivity (ADR-8).
- [x] 3.6 `src/middleware/errors.ts`: verify err.status mapping (429/404/5xx); adjust only if tests expose a gap.
- [x] 3.7 `config.example.yaml`: `providers` example block.

## Phase 4: Integration tests

- [x] 4.1 `src/routes/external-routing.test.ts`: /v1/models lists external + llama + gateway/*; streaming (one terminal + `[DONE]`); non-stream JSON; unknown → 404 model_not_found.
- [x] 4.2 `src/orchestrator/graph-engine.test.ts`: external final chain node (one terminal chunk + `[DONE]`); node.provider/defaultProvider resolution; no-provider → llama path unchanged.

## Phase 5: Full verification

- [x] 5.1 Full gate: `bun run typecheck && bun run lint && bun test` (existing suites unchanged) + binary streaming smoke.

## Phase 6: Verify remediation (5 CRITICALs — failed_evidence_revision sha256:29c2af51)

- [x] 6.1 CRITICAL-1: TDD Cycle Evidence table (17 tasks) added to merged apply-progress (Engram topic `sdd/multi-provider-pipelines/apply-progress`).
- [x] 6.2 CRITICAL-2: 5xx translation tests — `src/providers/openai-compatible.test.ts`: `translateSDKError` 502/503 unit + adapter-path 503 (S3.3).
- [x] 6.3 CRITICAL-3: Wire auth test — `src/routes/external-routing.test.ts` `the wire request carries Authorization: Bearer plus the configured static headers (S5.1)`.
- [x] 6.4 CRITICAL-4: No-apiKey wire test — `src/routes/external-routing.test.ts` `a provider without apiKey sends NO Authorization header on the wire (S5.2)`.
- [x] 6.5 CRITICAL-5: Chain defaultProvider normalization — `src/config/index.test.ts` (4 tests, config-load leg of pipeline-orchestration S2).
- [x] 6.6 Remediation gate: `bun run typecheck && bun run lint && bun test` — 431 pass / 0 fail (421 baseline + 10 additive), build green.
- [x] 6.7 Verify-admission S4.2: "Standard parameters map directly" — `src/providers/openai-compatible.test.ts` `maps standard parameters directly to SDK call settings (S4.2)`: temperature/top_p/max_tokens/stop → SDK `temperature`/`topP`/`maxOutputTokens`/`stopSequences` via `calls.options[0]` capture (string-stop normalization triangulated). Final gate: 432 pass / 0 fail.

## Constraints / Risks

- Frozen: Provider seam, graph-engine (prod), buildStreamBody, llama-server fetch, proxy, manager, dashboard — no edits; 4.2 touches graph-engine tests only (resolution already reads `n.provider`; llama-server stays first map entry).
- Overshoot: >1500 authored → orchestrator requests `size:exception` per preflight.