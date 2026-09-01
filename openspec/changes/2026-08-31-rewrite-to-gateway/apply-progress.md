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