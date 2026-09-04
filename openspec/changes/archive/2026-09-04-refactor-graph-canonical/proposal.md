# Proposal: Refactor a grafo canónico

## Intent

The orchestrator currently maintains two parallel execution paths — a linear engine (`runChain`) and a graph engine (`runGraphEngine`) — with a hybrid selector choosing between them. This duplication creates maintenance burden, divergent behavior (e.g. `payloadFor` omits messages, mode-wiring differs), and blocks composition (dead code). Config still uses legacy `steps` arrays for linear chains while the dashboard already sends `nodes`/`edges`. The zod schema strips graph payloads from the dashboard, breaking live apply.

## Scope

### In Scope
- Single graph engine: delete `runChain`, `hybrid-selector`, `graphToParsedChain`, `isLinearCompatible`; dispatch directly to `runGraphEngine`
- New zod schema: `graphNodeSchema` + `graphEdgeSchema` under `chainConfigSchema`; `condition` via `z.lazy` discriminated union; `steps` removed
- Export `buildStepMessages` from `engine.ts`; reuse in graph engine's `payloadFor` (fixes missing messages on intermediate steps)
- `GraphNode` gains optional `on_429` and `tool_calls_route` fields for legacy fallback routing parity
- Registry simplified to `graphMap` only; remove `chainMap`, `ParsedChain`, simplify `asMap`
- Compose pipelines: add `pipeline` case to `walk` in `composition.ts`; wire `getPipeline` from registry (currently stubeado)
- Persist `pos` in config (invert `delete out.pos` in `buildPayload`)
- Parity test: linear-vs-graph execution of all 6 migrated chains must produce identical outputs
- Migrate all 6 config chains (orchestrator, thinker, coder, verifier, fallback-demo, tool-demo) to `nodes`/`edges`

### Out of Scope
- Dashboard UI changes (SPA already sends graph format — no changes needed)
- New node types beyond existing set
- TOML/JSON5 config format (YAML confirmed as canonical)
- Runtime config format migration tooling

## Capabilities

### New Capabilities
None

### Modified Capabilities
- `graph-engine`: Remove hybrid selection; graph engine is the sole runtime. Add `on_429`/`tool_calls_route` support in `llm_call` handler.
- `pipeline-orchestration`: Replace `steps`-based config with `nodes`/`edges` graph format. Simplify registry to `graphMap` only. Remove `runChain` and linear dispatch.
- `pipeline-composition`: Wire `getPipeline` from registry; add `pipeline` node case in `walk`. Remove dead-code status.
- `config-load`: Update zod schema from `steps` to `graphNodeSchema`/`graphEdgeSchema`.
- `virtual-model-routing`: Resolve models from `graphMap` instead of `chainMap`+`graphMap` union.

## Approach

1. **Schema first**: Define `graphNodeSchema`/`graphEdgeSchema` with `z.lazy` for recursive `condition`, `on_429`, `tool_calls_route`, `pos`, `system`/`assistant`/`user`, `pipeline`/`params`. Remove `steps` from `chainConfigSchema`.
2. **Export + refeed**: Export `buildStepMessages` from `engine.ts`. Update `payloadFor` in `graph-engine.ts` to call it, using `GraphState.lastContent` for refine mode.
3. **on_429/tool_calls_route in graph engine**: Add conditional edge routing in `llm_call` handler using AST evaluation on `lastResponse.status` and `lastResponse.tool_calls`.
4. **Composition wiring**: Add `pipeline` case to `composition.ts` `walk`; inject `getPipeline` from registry into `runGraphEngine`.
5. **Registry simplification**: Single `graphMap`; remove `chainMap`/`ParsedChain`/`asMap` union. Update `chat.ts`/`completions.ts` dispatch.
6. **Config write**: Invert `buildPayload` to preserve `pos`. Update `write.ts` serialization.
7. **Migration**: Convert all 6 chains to `nodes`/`edges` in `llm-proxy.config.yaml`.
8. **Parity test**: Run each migrated chain through graph engine; assert output matches recorded linear-engine baseline.
9. **Cleanup**: Delete `runChain`, `hybrid-selector`, `graphToParsedChain`, `isLinearCompatible`. Remove `steps` zod branch.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/config/schema.ts` | Modified | New graph zod schemas; remove `steps` |
| `src/config/write.ts` | Modified | Persist `pos`; updated serialization |
| `src/orchestrator/engine.ts` | Modified | Export `buildStepMessages` |
| `src/orchestrator/graph-engine.ts` | Modified | Refeed messages in `payloadFor`; add `on_429`/`tool_calls_route` routing |
| `src/orchestrator/registry.ts` | Modified | `graphMap` only; remove `chainMap`/`ParsedChain`/`asMap` |
| `src/orchestrator/composition.ts` | Modified | Add `pipeline` case to `walk` |
| `src/orchestrator/hybrid-selector.ts` | Removed | No longer needed |
| `src/orchestrator/parser.ts` | Removed or simplified | `graphToParsedChain`/`isLinearCompatible` removed |
| `src/orchestrator/engine.ts` | Modified | `runChain` deleted |
| `src/routes/chat.ts`, `completions.ts` | Modified | Direct dispatch to `runGraphEngine` |
| `src/ui/graph-model.js` | Modified | `buildPayload` keeps `pos` |
| `llm-proxy.config.yaml` | Modified | 6 chains migrated to `nodes`/`edges` |
| Tests (`parser.test.ts`, `registry.test.ts`, `engine.test.ts`, `graph-engine.test.ts`, `config*.test.ts`) | Modified | Updated for new schema + parity gate |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Parity test reveals behavioral divergence (e.g. `payloadFor` message differences) | Medium | Record linear-engine baseline outputs before migration; parity test gates the merge |
| Composition wiring introduces subtle depth/breakage | Low | Existing `resolveCompositionDepth` is tested; add integration test for nested pipeline |
| Removing `steps` breaks existing user configs | Medium | Migration step converts all configs; `steps` can remain as deprecated transient branch with deprecation warning |
| `on_429`/`tool_calls_route` graph semantics differ subtly from linear | Medium | Implement as conditional edges in graph engine; parity test with fallback-demo and tool-demo chains |

## Rollback Plan

1. Restore `llm-proxy.config.yaml` from git (old `steps` format).
2. Revert schema changes (restore `steps` zod branch).
3. Restore deleted files (`runChain`, `hybrid-selector`, etc.) from git.
4. Run `bun run typecheck && bun test` to confirm clean state.

## Dependencies

None — pure internal refactor with no new external dependencies.

## Success Criteria

- [ ] All 6 chains execute correctly on graph engine (parity test passes)
- [ ] Dashboard apply works end-to-end (graph format accepted by zod, persisted, reloaded)
- [ ] Composition wired: nested pipeline invocation works with depth bounds
- [ ] `pos` preserved in config round-trip
- [ ] `runChain`, `hybrid-selector`, `ParsedChain` removed from codebase
- [ ] `bun run typecheck && bun run lint && bun test` all pass
