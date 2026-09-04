# Tasks: Refactor a grafo canónico

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 2800–4200 (additions + modifications + deletions) |
| 400-line budget risk | High |
| Chained PRs recommended | No |
| Suggested split | Single PR (size:exception accepted by user) |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Schema + types foundation | PR 1 | `bun run typecheck` | N/A (no runtime behavior yet) | schema.ts + graph.ts changes only |
| 2 | Config migration | PR 1 | `bun test src/config` | N/A (config files) | llm-proxy.config.yaml + config.example.yaml |
| 3 | Graph engine fixes (message refeed, routing, composition) | PR 1 | `bun test src/orchestrator` | N/A | graph-engine.ts + engine.ts export |
| 4 | Parity test gate | PR 1 | `bun test src/orchestrator/engine.test.ts` | N/A (fake-provider snapshot) | parity snapshot + test file |
| 5 | Registry + route + boot simplification | PR 1 | `bun run typecheck && bun test` | N/A | registry.ts + routes + index.ts |
| 6 | Linear engine deletion + cleanup | PR 1 | `bun run typecheck && bun test` | N/A | hybrid-selector.ts + parser.ts + chain.ts removal |
| 7 | Test update + final verification | PR 1 | `bun run typecheck && bun run lint && bun test` | N/A | all test files |

## Phase 1: Schema & Types (Foundation)

- [x] 1.1 Add `astExprSchema` (z.lazy, depth-capped at 12 via superRefine) to `src/config/schema.ts`; add `graphNodeSchema` with fields: `id`, `type` (enum includes `pipeline`), `model`, `mode` (default `generate`), `provider`, `system`, `assistant`, `user`, `ctx`, `pos`, `on_429`, `tool_calls_route`, `condition`, `body`, `pipeline`, `params`, `parallel`, `guard`; add `graphEdgeSchema` with `from`/`to`/`guard`; replace `steps` in `chainConfigSchema` with `nodes: z.array(graphNodeSchema).min(1)` + `edges: z.array(graphEdgeSchema).default([])`; remove `stepConfigSchema` export. *(schema-load spec: "Zod schema validation preserved")*
- [x] 1.2 Update `GraphNode` in `src/orchestrator/graph.ts`: add `mode` (enum `generate/refine/passthrough`, default `generate`), `ctx`, `pos` (`{x:number, y:number}` optional), `on_429`, `tool_calls_route`, `system`, `assistant`, `user`, `pipeline`, `params`, `parallel`, `guard` as optional fields; add `"pipeline"` to `NodeType` union; remove `isLinearCompatible` function.
- [x] 1.3 Delete `src/types/chain.ts` (removes `Step`, `Chain`, `StepContext`, `ResolvedStep`, `StepType`). *(design: deleted file)*

## Phase 2: Parity Baseline (Before Deleting Linear Engine)

- [x] 2.1 Add parity test infrastructure to `src/orchestrator/engine.test.ts`: create a fake provider that records `(stepType, model, messages, stream)` call sequences; run each of the 6 chains through `runChain` with the fake provider; serialize call sequences to `src/orchestrator/__snapshots__/linear-parity.json` (committed golden file). *(design: "Fake-provider snapshot test")*
- [x] 2.2 Verify parity snapshot generates correctly: `bun test src/orchestrator/engine.test.ts` must pass and snapshot must contain all 6 chain call sequences.

## Phase 3: Graph Engine Fixes

- [x] 3.1 Export `buildStepMessages` from `src/orchestrator/engine.ts` (change `function` to `export function`); also export `hasToolCalls` from engine.ts for graph-engine reuse. *(graph-engine spec: "Message refeed in graph engine")*
- [x] 3.2 Rewrite `payloadFor` in `src/orchestrator/graph-engine.ts` to call `buildStepMessages` with `(node, originalPayload, { lastResponse: curState.lastResponse, lastContent: curState.lastContent })` and return `{ ...originalPayload, model: node.model, messages, stream: false }`. *(graph-engine spec: "refine mode refeeds previous content")*
- [x] 3.3 Add post-`llm_call` conditional routing in `src/orchestrator/graph-engine.ts` `walk`: after `applyLlmResult`, check `curState.lastStatus === 429 && n.on_429` → jump to `on_429` target; check `hasToolCalls(result) && n.tool_calls_route` → jump to `tool_calls_route` target; else follow sequential edge. *(graph-engine spec: "Conditional edge routing for on_429 and tool_calls_route")*
- [x] 3.4 Add `pipeline` case in `src/orchestrator/graph-engine.ts` `walk`: `const invoked = compositionRuntime.invoke(n.pipeline ?? "", n.params ?? {}, depth); curState = { ...curState, lastResponse: invoked.lastResponse, lastContent: invoked.lastContent, lastStatus: invoked.lastStatus }; cur = onlySuccessor(n.id);`; thread `depth` through walk; create `compositionRuntime` via `createCompositionRuntime` with `getPipeline: deps.getGraph`. *(graph-engine spec: "Composition node execution")*
- [x] 3.5 Verify graph engine fixes: `bun test src/orchestrator/graph-engine.test.ts` and `bun test src/orchestrator/composition.test.ts` pass.

## Phase 4: Parity Test Gate

- [x] 4.1 Add graph-engine parity test to `src/orchestrator/engine.test.ts`: run the same 6 chains through `runGraphEngine` with the same fake provider; assert call sequences match `__snapshots__/linear-parity.json` byte-for-byte. *(proposal: "Parity test: linear-vs-graph execution")*
- [x] 4.2 Verify parity gate passes: `bun test src/orchestrator/engine.test.ts` — parity assertions must be green before any deletion.

## Phase 5: Config Migration

- [x] 5.1 Migrate all 6 chains in `llm-proxy.config.yaml` from `steps` to `nodes`/`edges` format: `orchestrator` (4 nodes), `thinker` (2 nodes), `coder` (4 nodes), `verifier` (4 nodes), `fallback-demo` (2 nodes with `on_429`), `tool-demo` (2 nodes with `tool_calls_route`). *(proposal: "Migrate all 6 config chains")*
- [x] 5.2 Update `config.example.yaml` to use graph `nodes`/`edges` format.
- [x] 5.3 Update `buildPayload` in `src/ui/graph-model.js`: remove `delete out.pos` from the `strip` function so `pos` is preserved in round-trip. *(config-load spec: "pos is preserved in round-trip")*

## Phase 6: Registry Simplification

- [x] 6.1 Simplify `src/orchestrator/registry.ts`: remove `ParsedChain` import, `chainMap`, `validateParsedChain`, `asMap()` union surface; keep only `graphMap`; update `PipelineRegistry` interface to expose `listGraphs(): GraphPipeline[]` instead of `asMap()`; update `reload(graphs: GraphPipeline[])` signature (single arg). *(pipeline-orchestration spec: "Runtime-reloadable chain registry")*
- [x] 6.2 Update `src/routes/models.ts`: change `ModelsRouteDeps.chains` from `Map<string, ParsedChain>` to use `listGraphs()` from registry; iterate `GraphPipeline` instead of `ParsedChain` for virtual model listing. *(virtual-model-routing spec: "Virtual models appear in /v1/models listing")*
- [x] 6.3 Update `src/routes/health.ts`: change `HealthRouteDeps.chains` to derive from `listGraphs()` or accept pipeline names directly.
- [x] 6.4 Update `src/server.ts` `createApp`: remove `deps.chains` (was `registry.asMap()`); wire `listGraphs` for models/health handlers; simplify route handler deps.
- [x] 6.5 Update `src/routes/chat.ts`: replace hybrid-selector dispatch with direct `deps.getGraph?.(chainId)` lookup → `runGraphEngine`; remove `createHybridSelector` import and `deps.chains` usage.
- [x] 6.6 Update `src/routes/completions.ts`: same as 6.5 — direct graph dispatch, no hybrid selector.
- [x] 6.7 Update `src/index.ts` boot: remove `parseChains` + `chainToGraph` calls; build graphs directly from config (zod-parsed `nodes`/`edges`); simplify `registry.reload` to single-arg; update `chainSummaries`/`nodeTypeFor` to use `listGraphs`.

## Phase 7: Delete Linear Engine & Cleanup

- [x] 7.1 Delete `src/orchestrator/hybrid-selector.ts` and `src/orchestrator/hybrid-selector.test.ts`. *(design: "No hybrid selector exists")*
- [x] 7.2 Delete `src/orchestrator/parser.ts` and `src/orchestrator/parser.test.ts` (removes `parseChains`, `chainToGraph`, `ParsedChain`). *(design: "parser.ts removed")*
- [x] 7.3 In `src/orchestrator/engine.ts`: delete `runChain`, `ChainMap`, `hasToolCalls` (moved to graph-engine or shared); keep only `buildStepMessages` (exported) and shared helpers (`isStreamRequest`, `runStepStream`, `runStepNonStream`, `extractContent`, etc.) that graph-engine still imports.
- [x] 7.4 Delete `isLinearCompatible` from `src/orchestrator/graph.ts` (already removed in 1.2; verify no remaining references).
- [x] 7.5 Update `src/orchestrator/engine.test.ts`: remove `runChain` tests; keep only parity tests and `buildStepMessages` unit tests.

## Phase 8: Test Update & Final Verification

- [x] 8.1 Update `src/orchestrator/registry.test.ts`: remove `chainMap`/`asMap`/`ParsedChain` assertions; test only `graphMap`-based registry (add/get/reload/listGraphs).
- [x] 8.2 Update `src/orchestrator/graph.test.ts`: remove `isLinearCompatible` tests; add tests for new `GraphNode` fields (`mode`, `on_429`, `tool_calls_route`, `pipeline`, `pos`).
- [x] 8.3 Update `src/routes/graph-route.test.ts`: remove hybrid-selector dispatch tests; test direct graph dispatch via `runGraphEngine`.
- [x] 8.4 Update `src/routes/models.test.ts`: remove `ParsedChain` fixtures; use `GraphPipeline` fixtures.
- [x] 8.5 Update `src/routes/stream.test.ts` and `src/routes/health.test.ts`: remove `ParsedChain` references; use `GraphPipeline`.
- [x] 8.6 Add new tests: `src/config/schema.test.ts` for graph schema validation (valid nodes/edges, steps rejection, recursive condition depth cap, `pipeline` node type).
- [x] 8.7 Final verification: `bun run typecheck && bun run lint && bun test` — all pass.

## Phase 9: Spec Sync

- [x] 9.1 Update `openspec/specs/graph-engine/spec.md` to reflect unified engine (no hybrid selector, `on_429`/`tool_calls_route` on `GraphNode`, `buildStepMessages` refeed).
- [x] 9.2 Update `openspec/specs/pipeline-orchestration/spec.md` to reflect `graphMap`-only registry, no `steps` format.
- [x] 9.3 Update `openspec/specs/config-load/spec.md` to reflect graph zod schemas and `pos` preservation.
