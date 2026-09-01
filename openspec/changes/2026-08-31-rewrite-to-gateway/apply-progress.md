# Apply Progress — rewrite-to-gateway

## ALL PRs COMPLETE (incl. PR4 backend-management slice)

**Strategy**: stacked-to-main, 3 PRs + 1 slice (PR 4 = backend-management)
**Mode**: Standard (strict_tdd false)
**Final status**: 21/21 tasks complete

### PR1: Foundation (branch: rewrite-to-gateway/pr1) — COMPLETE
- [x] 1.1-1.7: TS bootstrap, config, types, provider adapter

### PR2: Core Implementation (branch: rewrite-to-gateway/pr2) — COMPLETE
- [x] 2.1-2.7: middleware, orchestrator, utils
- [x] 3.1-3.4: routes, server, entry point

### PR3: Migration & Cleanup (branch: rewrite-to-gateway/pr3) — COMPLETE
- [x] 3.5: 4 pipelines migrated to chain schema
- [x] 5.1: config.example.yaml
- [x] 5.2: old JS files deleted
- [x] 5.3: zero llamaSwap references in src/

### PR4: Backend Management (branch: rewrite-to-gateway/pr4) — COMPLETE
- [x] 6.1-6.8: config `llama` schema, validation.ts, preset.ts, manager.ts, boot/shutdown, dynamic provider baseUrl, health backend state, config migration + .gitignore
- [x] 6.9-6.15: typecheck/build pass; smokes boot/fail-fast, streaming, errors, chains, security, supervision

### Phase 4 smokes (unblocked by PR4) — COMPLETE
- [x] 4.2-4.5: runtime smoke tests executed against the managed backend

### Verification Evidence (PR4)

| Check | Result |
|-------|--------|
| `pnpm typecheck` (strict) | PASS, 0 errors |
| `pnpm build` | PASS, exit 0 |
| Boot + readiness gate | `[manager] backend ready` BEFORE `listening`; health shows `backend:{state:running,pid,models}` |
| Fail-fast bad binary | `FATAL: llama binary not found at path: ...` + Fix line, exit(1), no listener |
| Fail-fast missing GGUF | `FATAL: GGUF file for model "..." not found` + Fix line, exit(1), no listener |
| SSE streaming (chain + direct) | clean chunks, `finish_reason: stop`, `data: [DONE]` |
| Passthrough non-stream | OpenAI JSON shape with usage; /v1/completions → text_completion |
| Errors | unknown chain → 404 `{error}`; zod → 400; backend down → 500/503 OpenAI shapes |
| Chains | `gateway/thinker` and `X-Chain-ID` both invoke chain (stream + non-stream) |
| Security | client disconnect aborts upstream (backend logs "Connection handling canceled"); helmet headers present; SSRF — target always from manager.status(), never request body |
| Supervision | SIGKILL child → `exited unexpectedly` → restart 1000ms backoff → new pid + ready; SIGTERM → `[manager] backend stopped`, no orphan, ports free |
| External mode | `autoStart:false` boots without spawn; passthrough → 503 `backend_unavailable` |

### Notable Deviations (PR4)
1. **preset INI format** (design.md had `url = file://`, `ctx_size`): the installed llama.cpp binary REJECTS those keys ("option 'ctx_size' not recognized in preset"). Verified empirically + in llama.cpp source (`common/preset.cpp` — INI keys map to CLI arg names). Correct format: `model = <abs-path>`, `ctx-size = N`, `temp = N`, per-model args as `key = value` with CLI names. Handled entirely in `src/backend/preset.ts`.
2. **Passthrough implementation** (design.md specified http-proxy-middleware): app-level `express.json()` consumes the request body before the route handler, so the proxy could not forward POST bodies (requests hung; GET worked). Replaced with a direct `fetch`-based forwarder that re-serializes the parsed body and streams the upstream response back — same pattern the chain engine already uses. Removed `http-proxy-middleware` dependency (package.json). SSE/abort behavior preserved.
3. **Manager spawn args**: `--predict-n` → `--n-predict` and `--flash-attn` requires a value (`--flash-attn on`) on this llama.cpp build.
4. **config.example.yaml router**: nGpuLayers -1 (not 99 as tasks.md suggested — -1 = all layers offload; config uses -1 while docs example port shows default behavior).

### Remaining
- None — apply complete. Next: sdd-verify.

---

## Verify Gap Closure Batch (2026-09-01) — ALL 4 GAPS CLOSED (55/55)

**Trigger**: verify-report 51/55 (33/33 reqs); validator requires 55/55.
**Branch**: rewrite-to-gateway/pr4. **Commit**: `fix(gateway): close verify gaps …` (see git log).
**Mode**: Standard.

### Gap 3 — Unknown model → OpenAI 404 + clean backend-unavailable (was 500)
- `src/routes/chat.ts` + `completions.ts`: `modelExists()` pre-check after chain resolution → `404 {error:{message,type:"invalid_request_error",param:"model",code:"model_not_found"}}`; `backendAvailable()` gate before runChain → `503 {error:{message:"Backend not available",type:"server_error",param:null,code:"backend_unavailable"}}` (external/autoStart:false mode — previously raw TypeError 500 on chain path).
- `src/middleware/proxy.ts`: upstream non-2xx response bodies normalized to OpenAI `{error:{message,type,param,code}}` envelope; `cleanup()` hoisted above the error branch (TDZ ReferenceError fix).
- Evidence (real curl): unknown model → `{"error":{"message":"Model \"nonexistent-real-model\" not found","type":"invalid_request_error","param":"model","code":"model_not_found"}}` [404] on chat AND completions; `?autoload=false` passthrough upstream 400 → `{"error":{"message":"model is not loaded","type":"invalid_request_error","param":null,"code":null}}` [400] (normalized); external-mode instance (`autoStart:false`, port 8091) chain + passthrough → `503 backend_unavailable` OpenAI shape.

### Gap 4 — Query params (autoload) preserved through chain path
- `src/providers/llama-server.ts`: `buildUrl()` appends internal `__gatewayQuery` (reserved key, dropped by sanitizer) → `${baseUrl}/v1/chat/completions?${query}`; `chat()`/`chatStream()` use it; added `[provider] POST <url>` observability logs.
- `src/orchestrator/engine.ts`: `runChain(…, query?)` sets `payload.__gatewayQuery`. `src/routes/chat.ts`+`completions.ts`: `queryString(req)` from `req.originalUrl`.
- Evidence (real curl): `POST /v1/chat/completions?autoload=false` gateway/thinker → log `[provider] POST http://127.0.0.1:8080/v1/chat/completions?autoload=false`, chain answered normally (`SET.`) when model already loaded; earlier boot proved backend honors it (llama `{"error":{"code":400,"message":"model is not loaded"}}`).

### Gap 2 — `tool_calls_route` runtime coverage (real bug found + fixed)
- **Root cause**: zod `z.object()` strips unknown keys by default → `tools`/`tool_choice` were dropped from `parsed` before `runChain`, so chain steps NEVER received tools (direct passthrough worked because it forwards raw `req.body`). Verified: `zod parsed keys: model, messages; tools kept? false`.
- **Fix**: `chat.ts` passes `req.body` (already zod-validated) to `runChain`; `completions.ts` spreads `req.body` into `chatPayload`. Sanitizer already whitelists `tools`/`tool_choice`.
- Config: new `tool-demo` chain (`tool_calls_route: tool_executor`) — planner **Llama3.2-3B-Instruct** (Qwen2.5-Coder-3B-Instruct provably ignores `tools` on this backend build — never emits tool_calls even forced), executor Phi-4-Mini-Instruct; in `llm-proxy.config.yaml` + `config.example.yaml`.
- Evidence (real runtime): engine log `[engine] chain "Tool Demo" step 1/2 …` → `[engine] tool_calls detected on step 0, routing to "tool_executor"` → step 2 executed. Direct backend proof: same sanitized body to llama-server yields `finish_reason:"tool_calls"`, `message.tool_calls:[{…get_current_time…}]`.

### Gap 1 — `on_429` fallback coverage (engine harness, honestly labeled)
- llama-server has NO rate limiter → real 429 over the wire is impossible; evidence = real runtime (config/boot/invocability) + engine-branch harness driving the actual dist engine.
- Config: new `fallback-demo` chain (step 1 SmolLM3-3B `on_429: fallback`; step 2 Phi-4); registered at boot (`[gateway] virtual models: … gateway/fallback-demo`), invocable (curl → 2-step execution).
- Harness (`node /tmp/opencode/on429-harness.mjs`, real `runChain` from dist, stub providers): response-status 429 → `[engine] 429 on step 0, falling back to "fallback"` → fallback model ran, `FALLBACK RAN`; thrown `err.status=429` → `429 error on step 0, falling back` → fallback ran; control 500 → no fallback, error propagates.

### Additional regression (no new gaps)
- Tool-call chain response shape: `Tool Demo` step 2 emit final answer; unknown chain → 404; valid real-model passthrough → 200; chain SSE clean with `[DONE]`.
- **Sandbox note**: gateway comm is `node-MainThread` (eludes `pgrep -x node`); stop via `kill -TERM` on `ps -eo pid,args | awk '/node dist\/index\.js/'`.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command + result | `pnpm typecheck` PASS (0 errors); `pnpm build` PASS; harness `node /tmp/opencode/on429-harness.mjs` → 3/3 cases (fallback ran x2, control threw) |
| Runtime harness command/scenario + result | Real gateway :8090 + managed llama :8080; curl per gap — [1] fallback-demo 2-step run, [2] `tool_calls detected … routing to "tool_executor"`, [3] 404/503/400 OpenAI shapes, [4] `[provider] POST …?autoload=false` |
| Rollback boundary | Revert commit e6e2fb9^..HEAD of the gap-closure commit; touchpoints: chat.ts/completions.ts pre-checks + req.body passthrough, proxy.ts normalization, engine query param, provider buildUrl, 2 demo chains in both configs |

### Deviations (this batch)
1. **req.body to runChain** (design said parsed payload): required by the zod-strip discovery; validation still enforced by zod before runChain.
2. **301 Error normalization** in proxy.ts added beyond design for passthrough upstream errors (verify gap 3 requirement).

### Status
21/21 tasks + 4/4 verify gaps closed → **Ready for sdd-verify (expect 55/55)**.