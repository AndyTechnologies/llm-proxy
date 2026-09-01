# Tasks: Rewrite llm-proxy as an Intelligent LLM Gateway

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1800–2200 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 3 chained PRs (foundation → engine/routes → migration/cleanup) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | TS bootstrap + config + types + provider adapter | PR 1 | `npx tsc --noEmit` | `npm run dev` → GET /health | revert path, no routes mounted yet |
| 2 | Middleware security/errors + engine/parser + routes | PR 2 | `npx tsc --noEmit` + curl 3 endpoints | curl SSE `/v1/chat/completions` vs llama-server :8080 | revert routes; no pipeline migration yet |
| 3 | Migration of 4 pipelines + example config + cleanup JS | PR 3 | `npx tsc --noEmit` + smoke chains | curl `gateway/thinker` SSE | revert config + delete old JS |

## Phase 1: Foundation / Infrastructure

- [x] 1.1 Set `package.json` to TS ESM: add deps `express, http-proxy-middleware, helmet, zod, dotenv, js-yaml`; dev `typescript, tsx, @types/express, @types/node`
- [x] 1.2 Create `tsconfig.json` with `strict:true`, `module: NodeNext`, `target: ES2022`; scripts `dev`(tsx), `build`(tsc), `start`
- [x] 1.3 Create empty `src/` tree: `config/`, `types/`, `routes/`, `middleware/`, `orchestrator/`, `providers/`, `utils/`
- [x] 1.4 Create `src/types/openai.ts`: ChatCompletionRequest/Response/Chunk, Completion*, Message, ToolCall, ErrorResponse
- [x] 1.5 Create `src/types/chain.ts` + `src/types/zod.ts`: Chain/Step interfaces; zod schemas (chat, completion, model ref)
- [x] 1.6 Create `src/config/schema.ts`/`load.ts`/`index.ts`: load JSON/YAML, `llamaServer` (:8080) replaces `llamaSwap`, zod-typed config (`llm-proxy.config.yaml`)
- [x] 1.7 Create `src/providers/types.ts` + `src/providers/llama-server.ts`: `Provider` interface; `chat()`, `chatStream()` via fetch with AbortSignal; normalize developer→system, flatten array content, finiteNumber; non-stream + SSE no-buffer

## Phase 2: Core Implementation

- [x] 2.1 Create `src/middleware/auth.ts`: optional Bearer from `BEARER_TOKEN`; 401 `{error:{message,type:"authentication_error"}}` when set
- [x] 2.2 Create `src/middleware/proxy.ts`: http-proxy-middleware for `/v1/*` → `config.llamaServer`; target from config only (SSRF guard); zod strips unknown URL fields
- [x] 2.3 Create `src/middleware/errors.ts`: global handler normalizes to OpenAI shape `{error:{message,type,param,code}}`; guard `res.headersSent`; invariant: exact ONE terminal chunk, no duplicate error payload after finish
- [x] 2.4 Create `src/server.ts`: mount `app.use(helmet())` (gateway-security Req 1), auth, proxy/errors, routes
- [x] 2.5 Create `src/orchestrator/parser.ts`: parse chain config → Step[]; resolve providers; refuse invalid chains at startup
- [x] 2.6 Create `src/orchestrator/engine.ts`: sequential runner; context refeed between steps; `on_429` fallback; `tool_calls_route`; stream only last step via `res.pipe()`; abort on `res.on('close')` (NOT req)
- [x] 2.7 Create `src/utils/ids.ts`/`sanitize.ts`/`extract.ts`: TS ports of `utils/micro.js` (makeCompletionId, extractContent, finiteNumber)

## Phase 3: Integration / Routing

- [x] 3.1 Create `src/routes/chat.ts` + `completions.ts`: normalize payload, resolve model; route provider vs `gateway/<chain>` / `X-Chain-ID`; stream via `res.pipe()` + `[DONE]`
- [x] 3.2 Create `src/routes/models.ts`: GET `/v1/models` lists real models + virtual chains, entries `id: "gateway/<chain>"` with `owned_by: "gateway"` (virtual-model-routing Req 3)
- [x] 3.3 Create `src/routes/health.ts` + `src/index.ts`: boot config→app→listen; SIGINT/TERM shutdown; no llama-swap
- [x] 3.4 Wire engine + proxy + routing: invoke chain via `model` prefix `gateway/<name>` or `X-Chain-ID`; unknown → 404 `{error}`
- [x] 3.5 Migrate 4 pipelines (`orchestrator`, `thinker`, `coder`, `verifier`) in `llm-proxy.config.yaml` to chain schema (steps w/ `on_429`, `tool_calls_route`, `passthrough`) preserving multi-stage reasoning

## Phase 4: Testing / Verification

- [x] 4.1 Verify `npx tsc --noEmit` passes strict TS
- [ ] 4.2 Smoke: 3 endpoints stream clean, `[DONE]` terminated; finish_reason assigned (no ReferenceError — proxy-pipeline)
- [ ] 4.3 Smoke: unknown chain → 404; validation error → 400; server error → 500 OpenAI shape
- [ ] 4.4 Smoke: `gateway/thinker` and `X-Chain-ID` both invoke chain
- [ ] 4.5 Smoke: client disconnect aborts upstream (res `close` → AbortController); safety headers present; SSRF (request URL field routed to config host)

## Phase 5: Cleanup / Documentation

- [x] 5.1 Create reference chain example config (`config.example.yaml` or JSON sample)
- [x] 5.2 Delete `index.js`, `server.js`, `pipelines.js`, `prompts.js`, `llama-swap/`, `utils/`; remove `cors` dep
- [x] 5.3 Confirm zero references to `llamaSwap`/llama-swap binary across `src/` + config; update README/scripts
