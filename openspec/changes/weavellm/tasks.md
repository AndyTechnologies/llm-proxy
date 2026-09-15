# Tasks: WeaveLLM Rewrite

## Review Workload Forecast

Estimated changed lines: 6k–12k (58 reqs, full rewrite) — far above review budget; split PR 1 → PR 6, delivery ask-on-risk.

Decision needed before apply: Yes (RESOLVED: user accepted size:exception, single PR)
Chained PRs recommended: Yes (overruled by size:exception acceptance)
Chain strategy: none — single PR with size:exception
400-line budget risk: High (accepted; budget never trims code/tests/docs)

### Suggested Work Units

| Unit | Goal | PR | Test cmd | Harness | Rollback |
|------|------|----|----------|---------|----------|
| 1 | Shell + DB + config | PR 1 | `bun test src/db` | `bun run dev` boots | revert shell/frontend |
| 2 | Backend + gguf + YaRN | PR 2 | `bun test src/backend src/utils/gguf.ts` | llama-server `--port 0` | revert backend/gguf |
| 3 | Catalog + downloads | PR 3 | `bun test src/downloads src/catalog` | fake gosh | revert downloads/catalog |
| 4 | Secrets + providers + proxy | PR 4 | `bun test src/secrets src/providers src/routes` | fake upstreams | revert secrets/providers/routes |
| 5 | Sandbox + embeddings + RAG | PR 5 | `bun test src/sandbox src/rag` | net-block probe | revert sandbox/rag |
| 6 | Engine + editor + /ws | PR 6 | `bun test src/orchestrator src/app/ws.ts` | Playwright | revert engine/editor/ws |

TDD: every task: RED test → GREEN impl (`bun test`).

## Phase 1: Shell & Foundation

- [x] 1.1 Create `electrobun.config.ts`, `hutch.config.ts`: Bun main + entrypoint, pins, flatpak
- [x] 1.2 Scaffold `frontend/`: Astro 7 static + Svelte islands
- [x] 1.3 Create `src/main.ts`, `src/app/server.ts`: Bun.serve, JSON logs, loopback
- [x] 1.4 Create `src/db/schema.ts`: 10 tables via bun:sqlite
- [x] 1.5 `scripts/build-binaries.ts`: 3 targets; >100 MB fails
- [x] 1.6 `src/app/update.ts`: Hutch check, consent UI, offline silent
- [x] 1.7 Cold start: interactive <2 s

## Phase 2: Backend & Model Config

- [x] 2.1 `src/utils/gguf.ts`: derive `yarn_orig_ctx`; 32K→128K scale 4
- [x] 2.2 Scale guard: reject ratio <1
- [x] 2.3 `src/backend/manager.ts`: single spawn, `--port 0` regex, health, idle kill, restart
- [x] 2.4 RED: metachar spawn-args denied → GREEN array builder
- [x] 2.5 b9908+ gate: old binary fails startup
- [x] 2.6 YaRN flags `--rope-scaling yarn` from config
- [x] 2.7 KV q8_0 args; `--cache-ram` host-only
- [x] 2.8 `model_config` store + sampler overrides

## Phase 3: Catalog & Downloads

- [x] 3.1 `src/downloads/{engine,gosh}.ts`: queue, resume, cancel; `sha256:<hex>` args
- [x] 3.2 RED: missing `sha256:` prefix errors
- [x] 3.3 sha256 verify; mismatch discards, unregistered
- [x] 3.4 resume/resume-all; cancel → resumable state
- [x] 3.5 `src/catalog/`: curated, HF search, local path; reject non-GGUF
- [x] 3.6 Registry reloads from SQLite after restart
- [x] 3.7 NIAH probe: per-model pass/fail

## Phase 4: Secrets, Providers, Proxy

- [x] 4.1 `src/secrets/keychain.ts`: AES-256-GCM; tamper → error
- [x] 4.2 Keys never logged; masked UI
- [x] 4.3 Port Provider seam + openai types; `adapter-{openai,anthropic,openrouter}.ts`
- [x] 4.4 Bearer auth + `${ENV}` headers; missing key → misconfigured
- [x] 4.5 RED: fallback on 429/5xx/net; stream no-dup
- [x] 4.6 `/v1/*` on 4317; unmapped → 404
- [x] 4.7 SSE relay; one `data: [DONE]`; disconnect abort
- [x] 4.8 Auth off default; 401 envelope when on
- [x] 4.9 Loopback bind default

## Phase 5: Sandbox, Embeddings, RAG

- [x] 5.1 `src/sandbox/runner.ts`: unshare net-block, tmp, env whitelist, timeout
- [x] 5.2 RED: net/FS/secrets denied
- [x] 5.3 Output cap + timeout kill
- [x] 5.4 `/v1/embeddings` local, OpenAI shape
- [x] 5.5 `chunks` store: cosine top-k; empty ok
- [x] 5.6 `memory` node: `kv_memory` inject
- [x] 5.7 `rag_local`: embed→retrieve→prompt; no-context notice

## Phase 6: Workflow Engine, Editor, /ws

- [x] 6.1 `src/orchestrator/graph.ts`: DAG validate (cycles, refs, types)
- [x] 6.2 `src/orchestrator/engine.ts`: topo exec, fan/join, `runChain`, logs
- [x] 6.3 10+ node taxonomy parity
- [x] 6.4 MoA 3+1 parallel synthesis
- [x] 6.5 `on_429` + `tool_calls_route`
- [ ] 6.6 `gateway/<name>` + `X-Chain-ID`
- [ ] 6.7 Editor canvas, palette, inline errors
- [x] 6.8 YAML round-trip; bad import names node
- [ ] 6.9 `/ws` events, order, scope, abort
- [ ] 6.10 `/api/*` CRUD

## Phase 7: Verification & Cleanup

- [ ] 7.1 Remove legacy router/preset code
- [ ] 7.2 Suite green; build gate; docs; tag