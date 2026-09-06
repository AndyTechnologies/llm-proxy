# Proposal: Multi-Provider Pipelines

## Intent

Every `llm_call` routes to the managed llama.cpp backend via the single fetch provider `llama-server`. Enable pipelines that also call external OpenAI-compatible APIs: add an optional `providers` config section plus an `@ai-sdk/openai-compatible` adapter BEHIND the existing `Provider` seam (explore #257), targeting providers via the already-schema'd `node.provider`/`chain.defaultProvider` (schema.ts:183,219; resolution at config/index.ts:31-34, graph-engine.ts:272). `Provider`, `runGraphEngine`, `buildStreamBody` stay frozen.

## Scope

### In Scope
- `providers` config section (baseURL + apiKey/headers + exposed models), coexisting with `llama`/`chains` (P4).
- Adapter `src/providers/openai-compatible.ts` implementing `Provider { chat, chatStream }` — OpenAI payload ↔ SDK (`generateText`/`streamText`), wire-shape reconstruction (tool_calls, finish_reason, usage), `abortSignal` forwarded.
- Deps: `ai@7` + `@ai-sdk/openai-compatible@3` + zod `^3.25.76` (C1-C3, C7-C8).
- Error translation → gateway envelope with `err.status` (on_429/tool_calls_route preserved).
- External models in `/v1/models`; 404 `model_not_found`; `${ENV}` interpolation for `apiKey`.

### Out of Scope
- Touching `Provider`, graph-engine, `buildStreamBody`. Migrating llama-server to the SDK. Dynamic auth (`headers()` fn, fetch middleware) + OTel (C10, C30). Dashboard provider-picker UI. Native `@ai-sdk/openai` provider.

## Capabilities

### New Capabilities
- `external-providers`: config section, SDK adapter, auth, error mapping, model validation/listing.

### Modified Capabilities
- `config-load`: `providers` schema validation + env interpolation.
- `gateway-api`: external models in listing; unknown external model → 404.
- `pipeline-orchestration`: named-provider targeting on `llm_call` (local + external).

No delta: graph-engine, gateway-security, backend-management, pipeline-composition, virtual-model-routing.

## Approach

Adapter translates payloads/responses across the seam; llama.cpp samplers via `providerOptions` under the camelCase provider name, spread top-level (C12-C13). Product decisions (non-authoritative):

| Decision | Recommendation | Tradeoff |
|---|---|---|
| Zod | Bump `^3.25.76` — in bun.lock, no v4 (C8) | None |
| Track | v7/3.x (repo ESM, Bun≥1.4 OK) (C2, C31) vs v6 pins | v6 downstream |
| Retries | `maxRetries: 0`; engine owns 429 via on_429; `TooManyRequestsError`→`status:429` (C17-C20) | No transport retry w/o on_429 |
| Bun #25630 | Adopt; binary streaming smoke gate; isolated path enables raw-fetch fallback (C32) | Fallback code |
| Auth | Config `apiKey` (Bearer; C9) + static `headers` + `${ENV}` | No dynamic auth |

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/config/schema.ts` | Modified | `providers` section + interpolation |
| `src/providers/openai-compatible.ts`(+test) | New | Adapter + error translation |
| `src/index.ts`, `src/server.ts` | Modified | Adapt into `providers` map (llama-server default) |
| `src/routes/models.ts`, `chat.ts`, `completions.ts` | Modified | Listing / 404 |
| `src/orchestrator/engine.ts`, `graph-engine.ts` | Unchanged | Boundary + engine frozen |
| `package.json`, `bun.lock`, `config.example.yaml` | Modified | Deps + example block |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bun prod streaming (C32) | Med | Smoke gate + fallback transport |
| Wire fidelity (SDK normalization) | Med | Contract tests; llama-server untouched |
| Error-mapping drift | Med | Per-class tests (429/404/5xx) |
| SDK double-retry 429 | Low | `maxRetries: 0` |

## Rollback Plan

Additive only: `git revert` removes adapter, deps, schema section; configs without `providers` behave identically (schema default `{}`). llama-server path and contract suites untouched by design.

## Dependencies

- `ai@7.0.93`, `@ai-sdk/openai-compatible@3.0.44`, zod `^3.25.76` (C1-C8).
- External provider API keys (user-supplied).

## Success Criteria

- [ ] Contract suites (~8) + 30 test files green; SSE terminal + single `[DONE]` intact.
- [ ] Adapter streaming + non-streaming round-trip (tool_calls, finish_reason, usage).
- [ ] `on_429` fires on first 429; `tool_calls_route` sees OpenAI-shaped tool_calls; `/v1/models` lists external models; unknown → 404.
- [ ] `bun run build:binary` streaming smoke passes (or fallback active).