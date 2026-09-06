# Research — multi-provider-pipelines

- **artifact**: `gentle-ai.sdd-research/v1`
- **change**: multi-provider-pipelines
- **revision**: 2 (supersedes revision 1, blocked by empty tool grants in runner config; nothing was emitted)
- **outcome**: done (uncertainties documented below)
- **date**: 2026-09-05
- **executor**: research-executor (SDD research phase)

## Admission and observed grants

Routine discipline: this research phase uses the same skill lifecycle as every
other run — loading the skill, its co-located `research-lifecycle.md` and
`web-search` shared skill, mapping runtime capabilities to grants, then
gathering, claiming, and persisting.

Observed runtime capabilities (declared at session start and verified by
probe at first use):

| Capability | Tools observed | Used for evidence |
| --- | --- | --- |
| `documentation` | `context7_resolve-library-id`, `context7_query-docs` | SDK/API documentation (ai-sdk.dev, via context7 library `/websites/ai-sdk_dev`) |
| `open-web` | `donsetch_web_fetch` (WebFetch), `donsetch_web_search` (WebSearch) | npm registry metadata, GitHub source files (`api.github.com`, `raw.githubusercontent.com`), llama.cpp docs, Bun issue tracker |

Not granted: `donsetch_web_crawl`. Disallowed for evidence claims.

Mapped tool names: `WebFetch -> donsetch_web_fetch`, `WebSearch -> donsetch_web_search`, `@context7 -> context7_resolve-library-id + context7_query-docs`. Located context7 library: `/websites/ai-sdk_dev` (the `@ai-sdk/openai-compatible` package has no dedicated context7 library; docs reached via the Vercel AI SDK site library).

Fail-closed: one transient DNS failure on a fetch was retried once and
succeeded (per web-search version-gated retry rule); nothing fabricated or
inferred from model knowledge without a captured source. When a claim could
not be sourced directly, it is recorded under Uncertainty rather than stated
as fact.

## Questions

The research answers, per lane:

1. **createOpenAICompatible API**: exact function signature and options; current stable version of `@ai-sdk/openai-compatible`; required `ai` version; breaking changes in recent majors.
2. **Auth**: `apiKey` as string vs function; placeholder keys for llama-server; dynamic custom headers; header providers.
3. **Custom/proprietary params (min_p, typical_p, top_k, repeat_penalty)**: how the adapter passes llama.cpp samplers through `providerOptions`; actual wire shape of the request.
4. **Typed errors**: `APICallError.statusCode`/`retryAfter`; `TooManyRequestsError` for 429; default retry behavior (`maxRetries`); how 429 reaches callers.
5. **Streaming**: `streamText` vs `generateText`; stream parts consumed by the gateway (finish reason, usage, raw chunks with tool calls); OpenAI wire SSE not re-emitted by the SDK (boundary for `buildStreamBody`).
6. **Abort/cancel**: cancel in-flight streams; signal forwarding; cleanup hook.
7. **Tools / structured output**: Zod schema conversion; OpenAI wire serialization of tools; llama.cpp function-calling support.
8. **Telemetry**: per-call toggle name in v7; OTel registration API (`@ai-sdk/otel`).
9. **Bun runtime**: ESM-only constraint, Node version engines, known Bun+streamText production issues.

## Product choices (separate — not authoritative, not evidence)

These are framing options for the design phase, not research claims:

- **P1 — Versions**: adopt `ai@7` + `@ai-sdk/openai-compatible@3` (latest stable tracks) if the Zod peer-range bump is accepted; otherwise pin the ai-v6 track (`ai@6` + `openai-compatible@2`) and verify its own peer range before committing (not checked in this research).
- **P2 — 429 handling**: because the SDK auto-retries 429/5xx by default, the gateway's `on_429` chain logic must either set `maxRetries: 0` on calls where the chain must observe the first 429, or detect retry exhaustion via `RetryError` / `TooManyRequestsError` / `StreamProviderError.statusCode === 429`.
- **P3 — providerOptions key**: use the provider `name` (e.g. `llama`) or `openaiCompatible` as the providerOptions key for samplers — NOT the deprecated `openai-compatible` key.
- **P4 — Boundary**: keep `buildStreamBody` as the external SSE output boundary; the SDK runs only as the typed upstream transport (adapter below the existing `Provider` seam).
- **P5 — Dynamic auth**: prefer per-call `headers` or the chat config `headers()` function for dynamic API keys; `fetch` middleware as last resort.

## Sources

| ID | Class | Title | Publisher | URL | Accessed | Excerpt |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | open-web | npm registry package metadata: @ai-sdk/openai-compatible | npm | https://registry.npmjs.org/@ai-sdk/openai-compatible | 2026-09-05 | latest: 3.0.44 (2026-09-04); dependencies @ai-sdk/provider 4.0.10, @ai-sdk/provider-utils 5.0.36 |
| S2 | open-web | npm dist-tags: ai | npm | https://registry.npmjs.org/-/package/ai/dist-tags | 2026-09-05 | latest 7.0.93, ai-v6: 6.0.277, ai-v5: 5.0.253 |
| S3 | open-web | npm dist-tags: @ai-sdk/openai-compatible | npm | https://registry.npmjs.org/-/package/@ai-sdk/openai-compatible/dist-tags | 2026-09-05 | latest 3.0.44, ai-v6: 2.0.74, ai-v5: 1.0.53 |
| S4 | documentation | OpenAI Compatible Providers | Vercel AI SDK (context7 docs) | https://ai-sdk.dev/providers/openai-compatible-providers | 2026-09-05 | createOpenAICompatible options: name, baseURL, apiKey, headers, queryParams, fetch, includeUsage, supportsStructuredOutputs, supportedUrls, transformRequestBody, metadataExtractor; providerOptions passthrough under camelCase key |
| S5 | documentation | streamText reference | Vercel AI SDK | https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text | 2026-09-05 | result: stream (parts incl. text-delta, finish, error, raw, abort), finishReason, rawFinishReason, usage, textStream |
| S6 | documentation | Generating Text | Vercel AI SDK | https://ai-sdk.dev/docs/ai-sdk-core/generating-text | 2026-09-05 | generateText result: text, tool results, finishReason, usage; fullStream incl. tool-call / tool-result parts |
| S7 | documentation | Migration Guide 5.0 | Vercel AI SDK | https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0 | 2026-09-05 | tool() inputSchema replaces parameters; tool-input-* stream parts |
| S8 | documentation | Tools and Tool Calling | Vercel AI SDK | https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling | 2026-09-05 | abortSignal forwarded to tool execution; errors surface as stream parts |
| S9 | documentation | Error Handling | Vercel AI SDK | https://ai-sdk.dev/docs/ai-sdk-core/error-handling | 2026-09-05 | onAbort callback; 'abort' stream part; StreamProviderError (message, type, code, statusCode, isRetryable, data, cause) |
| S10 | documentation | Stopping Streams | Vercel AI SDK | https://ai-sdk.dev/docs/advanced/stopping-streams | 2026-09-05 | abortSignal: pass req.signal; onAbort persists partial steps |
| S11 | documentation | zodSchema reference | Vercel AI SDK | https://ai-sdk.dev/docs/reference/ai-sdk-core/zod-schema | 2026-09-05 | zodSchema(schema, { useReferences }) converts Zod to JSON schema |
| S12 | documentation | Generating Structured Data | Vercel AI SDK | https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data | 2026-09-05 | output.object with tools; stopWhen isStepCount |
| S13 | documentation | Error references (NoSuchModelError, RetryError, NoObjectGeneratedError, TypeValidationError, StreamProviderError) | Vercel AI SDK | https://ai-sdk.dev/docs/ai-errors/ai-no-such-model-error (and sibling pages) | 2026-09-05 | NoSuchModelError: modelId + modelType + isInstance; RetryError.isInstance; NoObjectGeneratedError.isInstance; TypeValidationError; StreamProviderError fields |
| S14 | documentation | Reranking (RequestOptions) | Vercel AI SDK | https://ai-sdk.dev/docs/ai-sdk-core/reranking | 2026-09-05 | maxRetries: default 2 (3 attempts total), 0 disables |
| S15 | documentation | AI SDK Core Settings | Vercel AI SDK | https://ai-sdk.dev/docs/ai-sdk-core/settings | 2026-09-05 | RequestOptions: maxRetries default 2; abortSignal; timeout { totalMs, stepMs, firstChunkMs, chunkMs, toolMs, tools }; per-call headers |
| S16 | documentation | Migration Guide 7.0 | Vercel AI SDK | https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0 | 2026-09-05 | v7 ESM-only (CJS removed); system→instructions; fullStream→stream; experimental_telemetry→telemetry; includeRawChunks→include.rawChunks; OTel moved to @ai-sdk/otel (registerTelemetry(new OpenTelemetry())) |
| S17 | documentation | Telemetry | Vercel AI SDK | https://ai-sdk.dev/docs/ai-sdk-core/telemetry | 2026-09-05 | @ai-sdk/otel registration at startup; per-call telemetry flag |
| S18 | documentation | Migration Guide 6.0 | Vercel AI SDK | https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0 | 2026-09-05 | npx @ai-sdk/codemod v6 |
| S19 | documentation | Observability guides (Confident AI / Respan) | Vercel AI SDK | https://ai-sdk.dev/providers/observability/confident-ai (and respan) | 2026-09-05 | registerTelemetry with OpenAI-compatible providers; LegacyOpenTelemetry for legacy integrations; experimental_telemetry + telemetry v7 renames |
| S20 | open-web | openai-compatible-chat-language-model.ts (source, v3 line) | vercel/ai (GitHub raw) | https://raw.githubusercontent.com/vercel/ai/main/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts | 2026-09-05 | providerOptions: 'openai-compatible' deprecated (warning "Use 'openaiCompatible' instead"); 'openaiCompatible' + provider name + camelCase keys spread top-level into body minus reserved schema keys (user, reasoningEffort, textVerbosity, strictJsonSchema); topK → "unsupported feature" warning; stream_options include_usage only when includeUsage; combineHeaders(config.headers?.(), options.headers); config.headers is a function () => Record<string, string \| undefined> |
| S21 | open-web | openai-compatible-provider.ts (source) | vercel/ai (GitHub raw) | https://raw.githubusercontent.com/vercel/ai/main/packages/openai-compatible/src/openai-compatible-provider.ts | 2026-09-05 | OpenAICompatibleProviderSettings: baseURL (required string), name (required string), apiKey?: string static, headers?: Record<string,string> static, queryParams, fetch middleware, includeUsage, supportsStructuredOutputs, transformRequestBody, metadataExtractor, supportedUrls, convertUsage; Authorization Bearer prepended before custom headers; UA suffix 'ai-sdk/openai-compatible/<version>'; ProviderV4 |
| S22 | open-web | openai-compatible-prepare-tools.ts (source) | vercel/ai (GitHub raw) | https://raw.githubusercontent.com/vercel/ai/main/packages/openai-compatible/src/chat/openai-compatible-prepare-tools.ts | 2026-09-05 | tools → {type:'function', function:{name, description, parameters: inputSchema, strict?}}; toolChoice auto | none | required | {type:'function', function:{name}}; provider-defined tools → unsupported warning |
| S23 | open-web | package.json of @ai-sdk/openai-compatible (source) | vercel/ai (GitHub raw) | https://raw.githubusercontent.com/vercel/ai/main/packages/openai-compatible/package.json | 2026-09-05 | "type": "module"; "engines": { "node": ">=22" }; peerDependencies zod ^3.25.76 \|\| ^4.1.8; ESM exports only |
| S24 | open-web | llama.cpp issue #4429 (chat completions samplers) | ggml-org/llama.cpp (GitHub API) | https://api.github.com/repos/ggml-org/llama.cpp/issues/4429 | 2026-09-05 | curl to /v1/chat/completions body: temperature, min_p, top_k, top_p, repeat_penalty, grammar as top-level fields; auto-closed stale 2024-04-03 (historical evidence only) |
| S25 | open-web | llama-server README (server docs, master) | ggml-org/llama.cpp (GitHub raw) | https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md | 2026-09-05 | /v1/chat/completions: "See OpenAI Chat Completions API documentation. llama.cpp /completion-specific features such as mirostat are also supported"; response_format json_object + json_schema; OpenAI-style function calling (requires --jinja; parse_tool_calls, parallel_tool_calls); usage object (prompt/completion/total tokens, cached details); /completion samplers defaults: temperature 0.8, top_k 40, top_p 0.95, min_p 0.05, typical_p 1.0, repeat_penalty (1.0/1.1 in different tables); CLI defaults top-k 40, top-p .95, min-p .05, typical 1.0 |
| S26 | open-web | bun issue #25630 (streamText production build) | oven-sh/bun (GitHub API) | https://api.github.com/repos/oven-sh/bun/issues/25630 | 2026-09-05 | Bun 1.3.1 production build + ai SDK streamText → mid-stream network error; works in dev mode and Node.js; open as of 2026-01-01; reported with ai ^6.0.0-beta, @ai-sdk/openai 3.0.0-beta.106 |
| S27 | documentation | AI SDK foundations: tools (schema types) | Vercel AI SDK | https://ai-sdk.dev/docs/foundations/tools | 2026-09-05 | schemas: Zod (v3/v4), Valibot, JSON Schema |
| S28 | open-web | llama.cpp README (master) | ggml-org/llama.cpp (GitHub raw) | https://raw.githubusercontent.com/ggml-org/llama.cpp/master/README.md | 2026-09-05 | llama serve starts OpenAI-compatible API server; docs links point to tools/server/README.md |
| S29 | open-web | llama.cpp discussion #9660 (sampler CLI defaults) | ggml-org/llama.cpp (GitHub API) | https://api.github.com/repos/ggml-org/llama.cpp/discussions/9660 | 2026-09-05 | CLI sampler defaults context (top-k 40, top-p .95, min-p .05, typical 1.0) |
| S30 | open-web | llama.cpp server reference (third-party mirror) | strandsagents.com | https://www.strandsagents.com/technologies/llm/llama-cpp/server-reference-options/ | 2026-09-05 | server completion params incl. repeat_penalty, top_k, min_p, typical_p, tfs_z, mirostat, grammar, json_schema, cache_prompt (cross-check only) |
| S31 | documentation | Custom Providers (error mapping) | Vercel AI SDK | https://ai-sdk.dev/providers/community-providers/custom-providers | 2026-09-05 | 429 → TooManyRequestsError (retryAfter); 5xx → APICallError isRetryable: true; APICallError ctor example (statusCode, statusText, isRetryable, cause) |
| S32 | open-web | npm registry package metadata: ai | npm | https://registry.npmjs.org/ai | 2026-09-05 | ai 7.0.93 dependencies: @ai-sdk/gateway 4.0.75, @ai-sdk/provider 4.0.10, @ai-sdk/provider-utils 5.0.36 |
| S33 | documentation | Migration Guide 4.0 (isInstance) | Vercel AI SDK | https://ai-sdk.dev/docs/migration-guides/migration-guide-4-0 | 2026-09-05 | static error checks (isAPICallError etc.) replaced by Error.isInstance; toJSON removed |

Local observations (codebase context, not external evidence):

- `package.json` (repo): zod ^3.23.8, none of ai / @ai-sdk/* installed; Bun >= 1.4; `"type": "module"`; express ^5.2.1 and helmet ^8.0.0 present but unused vestigial per prior exploration.
- `src/dashboard/agent-config.ts`: already emits a generated code bundle with `npm: "@ai-sdk/openai-compatible"` as a string label (config text, not an installed dependency).

## Claims

| ID | Claim | Sources |
| --- | --- | --- |
| C1 | Current stable @ai-sdk/openai-compatible = 3.0.44 (2026-09-04) | S1, S3 |
| C2 | Version tracks are paired: ai 7.x ↔ openai-compatible 3.x (latest), ai 6.x ↔ 2.x (ai-v6), ai 5.x ↔ 1.x (ai-v5) | S2, S3 |
| C3 | Current stable ai = 7.0.93, deps @ai-sdk/gateway 4.0.75, @ai-sdk/provider 4.0.10, @ai-sdk/provider-utils 5.0.36 | S32, S2 |
| C4 | createOpenAICompatible names its options exactly: baseURL, name, apiKey?, headers?, queryParams?, fetch?, includeUsage?, supportsStructuredOutputs?, supportedUrls?, transformRequestBody?, metadataExtractor?, convertUsage? (no `extractMetadata` option exists — naming corrected) | S21, S4 |
| C5 | Provider implements ProviderV4/LanguageModelV4; adds `ai-sdk/openai-compatible/<version>` UA suffix | S21 |
| C6 | v5→v7 breaking changes: v7 ESM-only, system→instructions, fullStream→stream, experimental_telemetry→telemetry, includeRawChunks→include.rawChunks, CallSettings split, stepCountIs→isStepCount, onFinish→onEnd; OTel moved to @ai-sdk/otel | S16, S18 |
| C7 | @ai-sdk/openai-compatible 3.0.44: type module, engines node >=22, peerDependencies zod ^3.25.76 \|\| ^4.1.8 | S23 |
| C8 | Repo zod ^3.23.8 does NOT satisfy the peer range → adoption requires a zod bump | S23 + local package.json |
| C9 | apiKey is an optional static string; when set, Authorization: Bearer is prepended BEFORE custom headers; no apiKey-as-function, no headerProviders option | S21, S4 |
| C10 | Dynamic auth paths: per-call headers; config.headers as function () => Record<string,string \| undefined> via provider.languageModel(id, config); fetch middleware | S20, S21, S15 |
| C11 | llama-server needs no API key by default (client examples use sk-no-key-required / Bearer no-key); SDK omits Authorization when apiKey is undefined | S25, S21 |
| C12 | providerOptions under the camelCase provider name are spread TOP-LEVEL into the /chat/completions body, minus reserved keys (user, reasoningEffort, textVerbosity, strictJsonSchema) | S20, S4 |
| C13 | Legacy providerOptions key 'openai-compatible' is deprecated with warning "Use 'openaiCompatible' instead"; 'openaiCompatible' and the provider name (camelCase) keys are accepted | S20 |
| C14 | Standard top-level sampling params (temperature, top_p, frequency_penalty, presence_penalty, max_tokens, stop, seed) map directly; topK as a standard param is unsupported (warning "unsupported feature topK") — must go through providerOptions | S20 |
| C15 | llama.cpp /v1/chat/completions accepts /completion-specific sampler body fields (temperature, top_k, top_p, min_p, typical_p, repeat_penalty, presence/frequency penalties, dry_*, xtc_*, mirostat*, grammar, json_schema, seed) — "llama.cpp /completion-specific features such as mirostat are also supported" | S25, S24 |
| C16 | llama.cpp defaults: temperature 0.8, top_k 40, top_p 0.95, min_p 0.05, typical_p 1.0; repeat_penalty 1.0 (CLI table) vs 1.1 (completion docs) — inconsistent across tables | S25, S29 |
| C17 | APICallError: statusCode, statusText, isRetryable, cause; check via Error.isInstance | S13, S31, S33 |
| C18 | 429 → TooManyRequestsError (with retryAfter); 5xx → APICallError isRetryable: true | S31, S13 |
| C19 | NoSuchModelError: modelId + modelType; NoSuchModelError.isInstance | S13 |
| C20 | maxRetries default 2 (3 attempts total), 0 disables; SDK auto-retries 429/5xx | S14, S15 |
| C21 | Streaming errors surface as stream parts ('error', 'tool-error') and StreamProviderError carries statusCode/isRetryable | S9, S13 |
| C22 | streamText result: stream (parts incl. text-delta, reasoning-*, tool-call/tool-result, finish, error, raw, abort), finishReason, rawFinishReason, usage {inputTokens, outputTokens, totalTokens}, textStream; generateText for non-interactive | S5, S6 |
| C23 | Raw provider chunks via include.rawChunks → include: {rawChunks: true} in v7; raw stream parts; the SDK does NOT re-emit OpenAI wire SSE → buildStreamBody stays the output boundary | S16, S20 |
| C24 | includeUsage: true → stream_options: {include_usage: true} in the request so streaming responses carry usage | S20, S4 |
| C25 | Abort: abortSignal (call-level, AbortSignal.timeout works; req.signal forwarding); 'abort' stream part emitted; onAbort receives step snapshot; onEnd bypassed | S9, S10, S15 |
| C26 | abortSignal is forwarded to tool execution | S8 |
| C27 | Tools serialize to OpenAI wire: {type:'function', function:{name, description, parameters: inputSchema, strict?}}; toolChoice auto | none | required | {type:'function', function:{name}} | S22 |
| C28 | zodSchema(schema, {useReferences}) → JSON schema; tool() inputSchema (v5+); valid schemas: Zod v3/v4, Valibot, JSON Schema | S11, S7, S27 |
| C29 | llama.cpp: OpenAI-style function calling on /v1/chat/completions (requires --jinja; parse_tool_calls + parallel_tool_calls options; docs/function-calling.md); response_format supports json_object and json_schema | S25 |
| C30 | v7 telemetry: OTel moved to @ai-sdk/otel (registerTelemetry(new OpenTelemetry({...})) at startup); per-call flag renamed experimental_telemetry → telemetry | S16, S17, S19 |
| C31 | ai SDK v7 is ESM-only (CJS removed); works under Bun via its Node-API surface; no dedicated Bun getting-started in official docs (nodejs guide exists) | S16 |
| C32 | Known open issue: Bun production build + streamText → mid-stream network errors, absent in dev mode and Node.js; reported on Bun 1.3.1 with ai ^6.0.0-beta; open as of 2026-01-01 → risk for bun build --target=bun production | S26 |
| C33 | Provider requires node >=22 (S23); repo requires Bun >=1.4 — Bun implements the required APIs, with C32 as caveat | S23 + local package.json |

## Contradictions and uncertainty

- **`extractMetadata` vs `metadataExtractor`**: lane 1 premise named the option `extractMetadata`; the current API and source both name it `metadataExtractor` (C4). The premise was corrected, not confirmed.
- **repeat_penalty default**: llama-server README shows 1.0 in the CLI table and 1.1 in the /completion option list — internal inconsistency, both tables authoritative for their own section; the adapter should be explicit when setting it.
- **Issue #4429 staleness**: the Dec 2023 issue confirming samplers-in-chat-completions was auto-closed STALE by github-actions (2024-04-03). It is treated as historical evidence only; current upstream support is better evidenced by S25's explicit statement that /completion-specific features such as mirostat are supported in /v1/chat/completions.
- **`AbortError` export**: not verified as a claimable exported class from `ai` in the fetched docs (S9 documents 'abort' stream part and onAbort, not the AbortError class). Abort capability itself is fully sourced (C25/C26).
- **Migration guide 7-0 "Minimum Node.js Version" section**: could not be captured (site soft-404 on re-fetch). Engines for the provider package (node >=22, S23) stand; top-level `ai` package engines field was not captured from npm (registry excerpt omits it).
- **ai-v6 track peer deps (openai-compatible 2.x)**: not checked; only relevant if P1 falls back to the ai-v6 track.
- **`ai` 7.0.93 engines field**: not independently sourced beyond S32's dependency list; noted for completeness.

## Freshness

All sources accessed 2026-09-05. Registry metadata serialized up to 2026-09-04 (latest releases). Docs site reflects the v7 line (current stable). llama.cpp sources are from `master` (rolling, unreleased) — vendor behavior may differ in the released llama-server the repo pins; the research assumes default sampler behavior is stable across recent releases. Bun issue #25630 was last active 2026-01-01 and remains open — re-verify at design time if production builds are in scope.