# Tasks: Dashboard UI + Visual Pipeline Editor

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2400–3200 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR A → PR B → PR C → PR D |
| Delivery strategy | auto-chain |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

Chain strategy is **pending** — delivery_strategy is auto-chain but no chain strategy is cached. The orchestrator must collect `stacked-to-main` vs `feature-branch-chain` before apply (per session param).

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| A | Regression add. → Mutable registry + atomic reload + config write/defaults/watcher | PR A | `bun test src/orchestrator/registry.test.ts src/config/write.test.ts src/config/defaults.test.ts` | `bun start` boots from generated defaults when config absent | Revert registry/write/defaults/watcher; routes fall back to frozen `parseChains` |
| B | Graph engine + SAFE AST + composition + hybrid selector | PR B | `bun test src/orchestrator/graph.test.ts src/orchestrator/graph-engine.test.ts src/orchestrator/composition.test.ts` | Ad-hoc complex pipeline via test harness; not runtime-visible without PR C | Revert graph-engine/composition; linear path untouched |
| C | `/api/ui/*`(read-only) REST + SSE + execution tracker + metrics + events + auth | PR C | `bun test src/dashboard/` | `curl /api/ui/pipelines/events`(read-only) on running server | Revert `src/dashboard/` + server.ts branches; `/ui`(read-only) untouched |
| D | Static SPA (/ui) vanilla editor | PR D | `bun run typecheck && bun run lint && bun test`; fetch smoke on `/ui`(read-only) | `bun start` then browse `/ui`(read-only), build+validate+apply a graph | Remove `src/ui/`; serve no SPA |

## Phase 1 — Slice A: Registry + Atomic Config Write

- [x] 1.1 Create `src/orchestrator/registry.ts`: `PipelineRegistry` with `asMap(): Map<string,ParsedChain>`, `getGraph(id)`, `reload(graphs,chains)` — build+validate all, swap only on full success; RED/GREEN for swap/no-swap on `registry.test.ts`
- [x] 1.2 Create `src/config/write.ts`: atomic persist — `Bun.write`(tmp in same dir) + `fs.renameSync`; re-validate via zod before persist; test failed-write-leaves-prior-intact (config-load Req 1, scenarios)
- [x] 1.3 Create `src/config/defaults.ts`: generate minimal schema-valid config when file absent, scanning `modelsDir` for `*.gguf`; test missing-config-boots (config-load Req default gen)
- [x] 1.4 Create `src/config/watcher.ts`: scan `modelsDir` for `*.gguf` (case-insensitive paths), candidate-only; emit `models:changed` hook; test scan (dashboard-api model-list merge)
- [x] 1.5 Modify `src/index.ts`: construct registry + defaults + watcher; wire into `createApp` deps; chain resolution reads registry not frozen `parseChains`
- [x] 1.6 Modify `src/routes/models.ts`/`health.ts` (read-only consumers unchanged): read chains via registry `.asMap()`; verify existing route tests stay green

## Phase 2 — Slice B: Graph Engine, AST, Composition, Hybrid

- [ ] 2.1 Create `src/orchestrator/graph.ts`: node/edge validation — acyclic except `loop` boundaries, exactly one `start` + ≥1 `end`, model existence, required fields; RED for cyclic/zero-start (dashboard-api validate scenarios)
- [ ] 2.2 Create `src/orchestrator/graph.ts` SAFE AST: typed walker (discriminated union) for `compare`/`logical`/`not`/`exists` over `lastResponse.status/content`, `error`, `variables`; forbid `eval`/`new Function`/URL/file/network; RED unsafe-input-rejected (graph-engine Req safe AST)
- [ ] 2.3 Create `src/orchestrator/composition.ts`: pipeline invocation by name, input params, output→`lastResponse`, max depth 5 enforced; RED depth-6 fails, depth-3 runs (pipeline-composition Req 2)
- [ ] 2.4 Create `src/orchestrator/graph-engine.ts`: immutable runtime executing start/end/llm_call/condition/loop; sequential-guarded default; parallel opt-in with explicit `join`; loop bound; single-terminal stream on last executed-path step (reuse `buildStreamBody`), intermediates `step:*` non-streaming
- [ ] 2.5 Hybrid selector: linear-compatible graph → `runChain`; else graph engine (pipeline-orchestration modified Req sequential/streaming); RED both scenarios
- [ ] 2.6 Modify `src/routes/chat.ts`/`completions.ts`: route via hybrid selector after `registry.asMap()`; `/v1/*`(read-only) streams never buffered (RED no-buffer invariant)

## Phase 3 — Slice C: Dashboard API + SSE + Tracker

- [ ] 3.1 Create `src/dashboard/execution-tracker.ts`: in-memory history, N=100 bound, `ExecutionStatus`; test bounds (dashboard-api Req executions)
- [ ] 3.2 Create `src/dashboard/metrics.ts`: per-step aggregate metrics fed by engine/events
- [ ] 3.3 Create `src/dashboard/events.ts`: SSE pub/sub, bounded buffer + slow-client eviction/backpressure; test eviction (dashboard-api Req SSE)
- [ ] 3.4 Create `src/dashboard/service.ts`: apply — zod-validate draft → atomic write → `reload()`; rolls back on failure, writes nothing; error envelope `{error:{message,type,param,code}}` (config-load Req reload path)
- [ ] 3.5 Create `src/dashboard/router.ts`: `/api/ui/pipelines|models|executions|:id/validate|apply|:execId/steps/:nodeId/retry|events(SSE)`(read-only) fetch handlers; normalized errors; `server.timeout(req,0)` on SSE
- [ ] 3.6 Modify `src/server.ts`: add `/api/ui/*`(read-only) + `/ui`(read-only) branches; auth guard on `/api/ui/*`(read-only)+SSE when `BEARER_TOKEN` set, `/ui`(read-only) open (dashboard-api Req auth)
- [ ] 3.7 Retry: manual retry only failed `llm_call`, max 1/step, non-streaming, result stored; RED already-retried refused + non-llm_call refused (dashboard-api Req retry)

## Phase 4 — Slice D: Static SPA (/ui)

- [ ] 4.1 Create `src/ui/index.html`: ARIA landmarks, keyboard nav, WCAG AA, `<dialog>`, EventSource client
- [ ] 4.2 Create `src/ui/app.js`: load pipelines/models/executions; SVG-native graph render (no D3/xyflow); HTML5 DnD node palette; condition AST builder (compare/logical/not/exists only, no free-form code); validate + apply wiring; live SSE updates; surface apply errors, retain editor state
- [ ] 4.3 Create `src/ui/styles.css`: WCAG AA contrast, visible focus states
- [ ] 4.4 Static serving in `src/server.ts`/`router.ts`: correct content-types; path-traversal guard (RED `/ui/../../etc/passwd`(read-only) 4xx) (dashboard-ui Req static serving)
- [ ] 4.5 E2E smoke: `/ui`(read-only) loads, editor builds+validates+applies a graph, keyboard operable; verify `bun run typecheck && bun run lint && bun test` green (RFC acceptance)

## Phase 5 — Docs / Cleanup

- [ ] 5.1 Update `config.example.yaml` / README with dashboard + `/ui`(read-only) + `/api/ui/*`(read-only) usage; document `/api/ui/models`(read-only) model-candidate semantics- [ ] 5.2 Archive maintenance: ensure spec delta scenarios all covered by tests; remove any scratch code
