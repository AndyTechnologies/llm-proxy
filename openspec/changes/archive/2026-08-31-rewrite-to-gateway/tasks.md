# Tasks: Rewrite llm-proxy as an Intelligent LLM Gateway

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2400–3000 (1800–2200 original + ~600–800 backend-management) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 3 chained PRs (completos) + backend-management → nuevo slice PR 4 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Nota ampliación: backend-management (nuevos `src/backend/*`, config `llama`, boot/shutdown, health, provider) añade ~600–800 líneas. NO cambia la recomendación de chained (sigue Yes, stacked-to-main); se integra como nuevo slice PR 4 tras los 3 PRs originales (o dentro de PR 2 si aún no estuviera mergeado).

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | TS bootstrap + config + types + provider adapter | PR 1 | `npx tsc --noEmit` | `npm run dev` → GET /health | revert path, no routes mounted yet |
| 2 | Middleware security/errors + engine/parser + routes | PR 2 | `npx tsc --noEmit` + curl 3 endpoints | curl SSE `/v1/chat/completions` vs llama-server :8080 | revert routes; no pipeline migration yet |
| 3 | Migration of 4 pipelines + example config + cleanup JS | PR 3 | `npx tsc --noEmit` + smoke chains | curl `gateway/thinker` SSE | revert config + delete old JS |
| 4 | Backend management: config + validation + preset + manager + boot | PR 4 | `pnpm typecheck` + `pnpm build` | `pnpm dev` → curl SSE `gateway/thinker` contra backend gestionado (binario verificado `/home/andy/.local/bin/llama`) | revert sección `llama` + `src/backend/`; `autoStart:false` conserva modo externo |

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
- [x] 4.2 Smoke: 3 endpoints stream clean, `[DONE]` terminated; finish_reason assigned (no ReferenceError — proxy-pipeline)
- [x] 4.3 Smoke: unknown chain → 404; validation error → 400; server error → 500 OpenAI shape
- [x] 4.4 Smoke: `gateway/thinker` and `X-Chain-ID` both invoke chain
- [x] 4.5 Smoke: client disconnect aborts upstream (res `close` → AbortController); safety headers present; SSRF (request URL field routed to config host)

## Phase 5: Cleanup / Documentation

- [x] 5.1 Create reference chain example config (`config.example.yaml` or JSON sample)
- [x] 5.2 Delete `index.js`, `server.js`, `pipelines.js`, `prompts.js`, `llama-swap/`, `utils/`; remove `cors` dep
- [x] 5.3 Confirm zero references to `llamaSwap`/llama-swap binary across `src/` + config; update README/scripts

## Phase 6: Backend Management (backend-management capability)

- [x] 6.1 `src/config/schema.ts`: add `llamaConfigSchema` — binary, host, port (0|positive), autoStart, startupTimeoutMs, stopTimeoutMs, requestTimeoutMs, modelsDir, autoload, router {ctx,n,nGpuLayers,flashAttn,cacheTypeK/V,batch,ubatch,tools,parallel}, models `z.record(id → {file,ctx,temp,args})`; remove `llamaServerConfigSchema`; export zod-inferred types. (Req 2,9)
- [x] 6.2 Create `src/backend/validation.ts`: fail-fast at startup — binary resolvable (PATH or abs path), modelsDir exists, each `models[].file` exists (relative → under modelsDir, absolute → direct); one clear actionable error per failure. (Req 8; threat: binary-path + per-model-file authority)
- [x] 6.3 Create `src/backend/preset.ts`: render `config.llama.models` → llama.cpp preset INI (`--models-preset`): one section per id — NOTE: actual format `model = <abs path>`, `ctx-size`, `temp` (CLI arg names; `url = file://` and `ctx_size` rejected by installed binary, verified empirically + via llama.cpp source); write `.llm-proxy/models.ini` (gitignored). Single file owns INI syntax drift (design open question — RESOLVED in favor of CLI-arg-name keys). (Req 3)
- [x] 6.4 Create `src/backend/manager.ts`: `LlamaServeManager` — `start()` = validate → spawn `llama serve` router mode (`--models-dir`, `--models-preset`, autoload flag, router args; `port:0` read back from proc) → poll `GET /health` ≤ startupTimeoutMs, throw actionable error on timeout/early-exit; supervised restart backoff 1s→2s→4s→cap 30s, never after intentional `stop()`; `stop()` = SIGTERM → stopTimeoutMs → SIGKILL (no orphan); `status()` → {state, pid, models, baseUrl}. (Req 1,2,4,6; threat: process supervision)
- [x] 6.5 `src/index.ts` boot: create manager, `await manager.start()` BEFORE `app.listen()` (readiness gate); failure → clear message + `process.exit(1)`; shutdown adds `await manager.stop()` before exit. (Req 5,6)
- [x] 6.6 `src/providers/llama-server.ts`: `baseUrl` from `manager.status().baseUrl` (dynamic port) instead of static `llamaServer.host:port`; real-model list from `manager.status().models` for `/v1/models`; `chat()`/`chatStream()` preserved. (Req 4,10)
- [x] 6.7 `src/routes/health.ts`: extend response with `backend: manager.status()` → {state, pid, models}; drop static `llamaServer` URL field. (Req 7)
- [x] 6.8 Migrate `llm-proxy.config.yaml` + `config.example.yaml`: replace `llamaServer` with `llama` section (binary `/home/andy/.local/bin/llama`, host 127.0.0.1, port 8080, modelsDir `/home/andy/Models`, autoload true, router: nGpuLayers -1, flashAttn on, cacheTypeK/V q4_0, batch 2048, ubatch 512, tools all, parallel 1); 4 models with ctx/temp from old `llama-swap.config.yaml` (SmolLM3-3B 65536/0.1, Llama3.2-3B-Instruct 102400/0.1, Qwen2.5-Coder-3B-Instruct 32768/0.6, Phi-4-Mini-Instruct 32768/0.1) + their GGUF `file` names; add `.llm-proxy/` to `.gitignore`. (Req 9)
- [x] 6.9 Verify: `pnpm typecheck` (tsc strict) and `pnpm build` pass after the expansion.
- [x] 6.10 Smoke boot + fail-fast: `autoStart:true` → manager spawns `llama serve` router mode, readiness gate passes before listen; bad binary path / missing GGUF / never-ready → actionable error + exit(1), no listen (unblocks 4.2–4.5, now executable — binary verified at `/home/andy/.local/bin/llama`). (Req 5,8)
- [x] 6.11 Smoke streaming: SSE clean with `[DONE]` + finish_reason via managed backend. (unblocks 4.2)
- [x] 6.12 Smoke errors: unknown chain → 404, validation → 400, server error → 500, OpenAI `{error}` shape. (unblocks 4.3)
- [x] 6.13 Smoke chains: `gateway/thinker` and `X-Chain-ID` both invoke chain against managed router. (unblocks 4.4)
- [x] 6.14 Smoke security: client disconnect aborts upstream; helmet headers present; SSRF — request `url` field routed to config target, never supplied value. (unblocks 4.5; threat: upstream URL authority)
- [x] 6.15 Smoke supervision: kill child process → auto-restart with backoff and ready resumes; `manager.stop()`/SIGTERM → child gone, no orphan. (Req 1 crash scenario; threat: process supervision)