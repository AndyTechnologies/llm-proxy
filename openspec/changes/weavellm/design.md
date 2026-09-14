# Design: WeaveLLM — Full Rewrite

## Technical Approach

Rebuild the repo as WeaveLLM: Electrobun v2 app (Bun main) hosting an Astro 7/Svelte 5 SPA in the webview, Bun.serve OpenAI proxy (4317, /ws), sidecars (llama-server per model, gosh), SQLite+YAML persistence, keychain secrets. Port five proven modules (gguf, manager lifecycle, graph, Provider seam, openai types); rest fresh. Legacy tests (~445) rewritten (strict TDD).

## Architecture Decisions

| # | Option | Tradeoff | Decision |
|---|---|---|---|
| D1 | Cottontail vs **Bun** | JSC default vs Bun spawn/sqlite/serve | `build.mainProcess:"bun"` + `bun.entrypoint` |
| D2 | adapter-static vs **Astro 7 static** | removed in v7 (npm 404) | native `output:"static"` |
| D3 | @xyflow/svelte 1.6.6 vs 2.0-next | stable v1 vs pre-release | **1.6.6** pinned |
| D4 | Bun-native vs **gosh CLI** | zero-dep vs verified flags/resume | gosh v0.6.3+ via `DownloadEngine`; `sha256:` prefix |
| D5 | preset/router vs **single-model spawn** | router dropped | one llama-server/model; SQLite flags; port-0 detect ported |
| D6 | current vs **b9908** | cache-ram hard limit since b9908 | fail-fast gate |
| D7 | **YaRN auto** vs manual | auto from GGUF; manual if missing | scale = ctx/orig, guard ≥ 1 |
| D8 | plaintext vs **keychain AEAD** | — | AES-256-GCM; key in Keychain/Secret Service |
| D9 | env-gated vs **opt-in auth** | — | auth OFF default; 127.0.0.1 bind |
| D10 | in-proc vs **subprocess sandbox** | isolation vs cost | SandboxRunner: `unshare -n` (Linux), `sandbox-exec` (macOS); tmp cwd, env whitelist, timeout, cap |

## Data Model

SQLite `weavellm.db` (appData): `models(id, source, path, sha256, gguf_ctx, yarn_orig_ctx, state, probe_status)` ∞1 `model_config(ctx_size, kv_k, kv_v, n_cache_gpu, cache_ram, ngl, flash_attn)`; `workflows(name, version, yaml_graph)`; `execution_log(workflow_id, status, error, started_at, ms)`; `providers(kind, base_url, fallback_id, misconfigured)`; `secrets(scope, nonce, ciphertext)`; `kv_memory(conv_id, role, content, ts)`; `chunks(doc, vector BLOB, text)`; `downloads(model_id, url, state, bytes)`; `settings(key, value)`. YAML: workflow `name/version/nodes/edges`; curated catalog in-bundle.

## Key Flows

- **Spawn**: config → args (`--model --ctx-size --rope-scaling yarn --rope-scale --yarn-orig-ctx -ctk/-ctv -n-cache-gpu --cache-ram -ngl`) → `Bun.spawn(array)` → stdout port regex → health poll. Idle 5min → SIGTERM/SIGKILL; crash → backoff; EADDRINUSE guard. OOM: `hardwareMaxCtx` caps ctx.
- **Workflow**: `validateGraph` → topo walk, parallel fan/join → techniques expand (MoA 3+1) → `on_429`/`tool_calls_route` routing; AbortSignal per node; failure → node `error`, outputs kept.
- **RAG**: query embed → cosine top-k → grounded prompt; empty → no-context notice.
- **Download**: queue → `gosh -x 16 --checksum sha256:<hex> --output json` → progress → `/ws` → verify → register; cancel → resumable; `resume`/`resume-all`.
- **Secrets**: keychain AEAD, nonce/record; tamper → error.
- **Auto-update**: Hutch check at boot; UI offer; offline silent.

## Module Design (files)

| File | Action | Notes |
|---|---|---|
| `electrobun.config.ts`, `hutch.config.ts` | Create | bun main, version pin, codesign, flatpak |
| `src/main.ts`, `src/app/{server,ws,store,ipc}.ts` | Create | fetch+/ws; channels→renderer |
| `frontend/` (Astro, `svelte/`) | Create | editor, catalog, models, settings |
| Ported: `src/utils/gguf.ts`, `src/backend/manager.ts`, `src/orchestrator/graph.ts`, `src/providers/{types,llama-server,openai-compatible}.ts`, `src/types/openai.ts` | Port+modify | gguf + `yarn_orig_ctx`/scale guard; manager single-model spawn + b9908 gate (preset deleted); graph new taxonomy; provider seam + wire contract unchanged |
| `src/providers/adapter-{openai,anthropic,openrouter}.ts` | Create | `makeProviderAdapter(kind)`; keychain auth; fallback |
| `src/downloads/{engine,gosh}.ts`, `src/sandbox/runner.ts`, `src/secrets/keychain.ts`, `src/db/schema.ts` | Create | per Interfaces |
| `src/routes/{v1,api}-*.ts` | Create | proxy + CRUD |

## Interfaces

New: `DownloadEngine { enqueue, resume, cancel }`; `SandboxRunner.run(code, {timeoutMs, maxOutput})` → `SandboxResult`. Ported: `Provider` seam (`chat`, `chatStream`) + `openai.ts` wire types. Spawn args strictly `string[]`.

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | YaRN math, gguf parse, DAG validate, sandbox denial, AES round-trip/tamper, spawn/gosh args | bun test, pure fns, RED first |
| Integration | adapter round-trips (fake upstreams), MoA 3+1, 429 fallback, download resume/checksum (fake gosh), spawn+health | ported e2e harness |
| E2E | editor draw→export→run, rag_local, /ws order, auth 401, sandbox net-block | Playwright + fake sidecars |

## Threat Matrix

| Boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no VCS/PR automation |
| Git select/commit/push/PR | N/A — no git surface |

Process integration in scope: args as arrays (shell metachars rejected), binary paths validated (llama-server from settings; gosh bundled), sandbox denies net/FS/secrets. RED tests: spawn-arg injection, sandbox net/env denial, missing checksum prefix → error, 429 fallback.

## Migration / Rollout

No data migration (fresh DB). Tag master pre-rewrite; archive 14 legacy specs; chained PRs (budget likely exceeded); Flatpak for Linux deps; Hutch codesign+notarize; <100 MB gate fails build.

## Open Questions

- [ ] **Provider-list conflict**: specs say Google+Groq; handoff + AC #7 say OpenAI+OpenRouter. Align specs to handoff at archive.
- [ ] Archive risk 1: delta MODIFIED blocks merge with unchanged originals — verify tooling.
- [ ] Archive risk 2: renamed+modified `external-providers` needs rename-before-replace.
- [ ] macOS `sandbox-exec` deprecation status on 14+.