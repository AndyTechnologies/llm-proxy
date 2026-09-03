# Proposal: Dashboard UI + Visual Pipeline Editor

## Intent

Provide a browser **Dashboard UI** (`/ui`) + **Visual Pipeline Editor** so operators inspect, build, validate, and hot-apply pipelines without YAML editing. Today chains are linear `Step[]` frozen at boot. To support modern pipelines we need a mutable registry, graph/AST validation, atomic config write, and a pipeline engine capable of running both linear chains and complex graphs with conditionals, multiple branches, and pipeline composition.

## Scope

### In Scope
- `/api/ui/*` REST + SSE in the `Bun.serve` fetch dispatcher (no Express).
- **Hybrid pipeline engine**: linear-compatible graphs run on the existing `runChain`; complex graphs (conditionals + multiple branches) run on a new **graph engine**.
- **Pipeline composition**: a pipeline can invoke another pre-defined pipeline (max depth, input parameters, output → `lastResponse`).
- Editor node types: `start`, `end`, `llm_call`, `condition` (AST), `loop`.
- Branch semantics: sequential-guarded default; parallel opt-in on marked subgraphs with explicit join.
- Streaming: intermediate steps non-streaming + progress events (`step:*`); only the last step of the path streams (single terminal chunk).
- Mutable registry + atomic `reload()`, config `defaults.ts`, `modelsDir` watcher.
- Vanilla SPA `src/ui/` (SVG editor, HTML5 DnD, `<dialog>`, Zod connection checks).

### Out of Scope
- Express re-introduction / `app.mount`.
- `defaultChain` routing change (reporting-only).
- Auto-registering disk models without operator action (detected `.gguf` added to `config.llama.models` via apply only).

## Capabilities

### New Capabilities
- `dashboard-api`: `/api/ui/*` REST + SSE — pipelines CRUD/validate/apply, models, executions, retry, events.
- `dashboard-ui`: vanilla SPA — SVG graph editor, drag-and-drop, `<dialog>`, Zod connection validation, condition-AST builder.
- `graph-engine`: runtime execution of complex pipelines (conditionals, multiple branches, parallel opt-in, joins) + safe AST evaluation; reuses linear engine for linear-compatible graphs.
- `pipeline-composition`: a pipeline invoking another pre-defined pipeline (max depth, input parameters).

### Modified Capabilities
- `pipeline-orchestration`: chains runtime-reloadable via mutable registry; admission gated by graph/AST validation; conditions move to a typed-AST interpreter (delta).
- `config-load`: atomic config write + `defaults.ts` generation + reload path (delta).

## Approach

1. **Fetch-native:** add `/api/ui/*` + `/ui` branches to `createApp`; reuse `authGuard`/`withSecurity`/`errorHandler`/`server.timeout(req,0)`.
2. **Registry supersedes frozen Map:** `registry.ts` keeps a `Map<string, ParsedChain>` surface + atomic `reload()` (build+validate, swap only on success).
3. **Graph gate + engine:** `graph.ts` validates acyclicity (loop excepted), ref/model existence, 1 `start` + ≥1 `end`, required fields, bounded composition depth; evaluates compare/logical/not/exists over literals + `lastResponse.status/content`, `error`, `variables` — no `eval`/`new Function`. A new **graph engine** executes complex graphs; linear-compatible graphs reuse `runChain`.
4. **Atomic apply:** `service.ts` zod-validates drafts, `Bun.write`(tmp) + `fs.renameSync`, then `reload()`. Metrics/events pass-through (never buffer `/v1/*`).
5. **Frontend:** vanilla HTML/CSS/JS; SVG DOM, CSS Grid + ARIA/WCAG-AA, EventSource, `<dialog>`, HTML5 DnD.
6. **Delivery:** chained PRs — (a) registry+watcher+config write, (b) graph engine + composition, (c) API SSE/tracking, (d) static UI.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/server.ts` | Modified | dispatcher + `/api/ui/*` `/ui` branches |
| `src/dashboard/router.ts`, `service.ts`, `execution-tracker.ts`, `metrics.ts`, `events.ts` | New | api handlers, CRUD+atomic write, exec registry, metrics, SSE bus |
| `src/orchestrator/registry.ts` | New | mutable registry + atomic reload |
| `src/orchestrator/graph.ts` | New | graph validation + SAFE AST |
| `src/orchestrator/graph-engine.ts` | New | complex-graph runtime execution |
| `src/orchestrator/composition.ts` | New | pipeline composition (depth, params) |
| `src/config/watcher.ts`, `defaults.ts` | New | `.gguf` scan, min-config gen |
| `src/index.ts` | Modified | wire registry/graph-engine/watcher/events/tracker |
| `src/routes/chat.ts`, `completions.ts`, `models.ts` | Modified | read chains from registry; route complex pipelines to graph engine |
| `src/ui/index.html`, `app.js`, `styles.css` | New | SPA frontend |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Graph engine runtime correctness | High | testable graph engine w/ branch + parallel + loop cases; linear reuse where compatible |
| Composition cycles / depth | Med | max-depth enforcement + clear error |
| Reload tearing config | Med | tmp+rename, build-then-swap, mutex |
| SSE multi-client/Bun | Med | bounded pub/sub + backpressure |
| Stream invariants broken | Low | intermediate non-streaming; only last step streams; never buffer `/v1/*` |
| SSRF via condition vars | Low | vars exclude URLs; routing config-derived |
| Review-budget blow (400) | High | chained PR slices |

## Rollback Plan

Per-slice revert of the offending commit — registry is additive and `Map`-compatible, so existing routes need no change. Graph engine + composition are additive behind the registry; linear paths untouched. Full revert restores frozen `parseChains` boot path and disables `/api/ui/*`; `/v1/*` invariants untouched. No destructive migration.

## Dependencies

- Bun ≥ 1.4 (`Bun.serve`, `Bun.write`, `fs.renameSync`); existing zod schema + `Map<string, ParsedChain>` (`runChain`).

## Success Criteria

- [ ] `bun run typecheck && bun run lint && bun test` green.
- [ ] `/api/ui/*` failures return the `{error:{message,type,param,code}}` envelope.
- [ ] Apply persists YAML atomically; `reload()` swaps registry without restart.
- [ ] A complex pipeline (conditionals + branches) runs on the graph engine; a linear pipeline runs on the linear engine.
- [ ] Pipeline composition respects max depth, propagates input params and `lastResponse`.
- [ ] `/v1/*` stream invariants preserved (single terminal chunk, no buffering).
- [ ] SPA validates a pipeline graph; unsafe AST input rejected (no `eval`).
- [ ] `/api/ui/models` lists registered + detected models; adding a detected `.gguf` to `config.llama.models` works via apply.
