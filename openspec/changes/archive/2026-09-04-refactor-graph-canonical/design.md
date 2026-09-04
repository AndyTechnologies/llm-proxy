# Design: Refactor a grafo canónico

## Technical Approach

Unify all pipeline execution on a single graph engine by deleting the linear engine path (`runChain`), simplifying the registry to `graphMap` only, wiring composition, and fixing the `payloadFor` message-omission bug. Config migrates from `steps` to `nodes`/`edges` with new zod schemas; `pos` is preserved in round-trip. A parity test gate guards the merge.

## Architecture Decisions

| Decision | Options | Tradeoff | Choice |
|----------|---------|----------|--------|
| Linear migration | Atomic removal vs. deprecation window | Window adds complexity; atomic is safe because parity test gates the swap | **Atomic** — `steps` rejected immediately after config migration |
| `z.lazy` recursion depth | Unbounded vs. capped via `.refine()` | Unbounded risks stack overflow; `.refine()` adds ~2ms per node (acceptable for graph admission, not hot path) | **Capped at 12** via `z.refine()` on `astExprSchema` |
| Parity baseline | Record linear output before migration vs. run both engines in test | Recording requires a running backend; test-only approach is deterministic with fakes | **Fake-provider snapshot test** — inject a fake provider that records call sequence; assert identical between linear and graph |
| `on_429`/`tool_calls_route` representation | Fields on `GraphNode` vs. conditional edges | Fields are simpler, match linear semantics, and avoid encoding error routing as graph edges with AST guards | **Fields on `GraphNode`** — evaluated post-`llm_call` in the walk loop, before following sequential edge |
| `pos` inversion | Remove `delete out.pos` vs. strip at write-time only | Stripping at write would still lose on apply; simplest is to never delete | **Remove `delete out.pos`** from `buildPayload` |

## Architecture: Proposed Modules

### New/Modified

| File | Action | Description |
|------|--------|-------------|
| `src/config/schema.ts` | Modify | Add `astExprSchema` (z.lazy, depth-capped), `graphNodeSchema`, `graphEdgeSchema`; replace `steps` in `chainConfigSchema` with `nodes`+`edges` |
| `src/orchestrator/graph.ts` | Modify | Add `mode`, `ctx`, `pos`, `on_429`, `tool_calls_route`, `system`, `assistant`, `user`, `pipeline`, `params` to `GraphNode`; add `pipeline` to `NodeType`; remove `isLinearCompatible` |
| `src/orchestrator/graph-engine.ts` | Modify | Export `buildStepMessages` from engine.ts; rewrite `payloadFor` to call it with `GraphState`; add `on_429`/`tool_calls_route` post-llm_call routing; add `pipeline` case in `walk` |
| `src/orchestrator/engine.ts` | Modify | Export `buildStepMessages`; delete `runChain`, `ChainMap`, `hasToolCalls` |
| `src/orchestrator/registry.ts` | Modify | Remove `chainMap`, `ParsedChain`, `asMap`; `graphMap` only; `reload(graphs: GraphPipeline[])` |
| `src/orchestrator/composition.ts` | Modify | No structural changes — already correct; wire `getPipeline` from registry into `GraphEngineDeps` |
| `src/routes/chat.ts` | Modify | Dispatch directly to `runGraphEngine`; remove hybrid selector import |
| `src/routes/completions.ts` | Modify | Same as chat.ts |
| `src/ui/graph-model.js` | Modify | Remove `delete out.pos` from `buildPayload` |
| `src/config/write.ts` | Modify | No changes needed — `YAML.stringify` serializes all fields; `pos` is preserved once schema accepts it |
| `llm-proxy.config.yaml` | Modify | Migrate 6 chains to `nodes`/`edges` format |
| `config.example.yaml` | Modify | Update to graph format |

### Deleted

| File | Reason |
|------|--------|
| `src/orchestrator/hybrid-selector.ts` | Hybrid dispatch eliminated |
| `src/orchestrator/parser.ts` | `parseChains`/`chainToGraph`/`ParsedChain` removed; config loads graphs directly |
| `src/types/chain.ts` | `Chain`, `Step`, `ResolvedStep`, `StepContext` replaced by `GraphNode` fields |

### Retained (unchanged)

| File | Reason |
|------|--------|
| `src/orchestrator/composition.ts` | Already correct; only wiring changes |
| `src/dashboard/execution-tracker.ts` | Dashboard concern, not affected |
| `src/dashboard/retry.ts` | Retries use tracker, not engine |

## Data Flow: Unified Dispatch

```
HTTP Request (chat/completions)
  │
  ├─ X-Chain-ID header? → resolve from graphMap
  ├─ model: gateway/<name>? → resolve from graphMap
  └─ else → forward to provider directly
       │
       ▼
  runGraphEngine(graph, deps, opts)
       │
       ├─ walk(start)
       │    ├─ start → follow edge
       │    ├─ llm_call:
       │    │    ├─ payloadFor(node, originalPayload, graphState)
       │    │    │    └─ buildStepMessages(node, originalPayload, context) ← EXPORTED from engine.ts
       │    │    ├─ provider.chat(payload)
       │    │    ├─ applyLlmResult(state, result)
       │    │    ├─ post-llm_call routing:
       │    │    │    ├─ status===429 && node.on_429 → jump to on_429 target
       │    │    │    ├─ hasToolCalls(result) && node.tool_calls_route → jump to tool_calls_route target
       │    │    │    └─ else → follow sequential edge
       │    │    └─ if terminal → buildStreamBody (streaming final step)
       │    ├─ condition → pickConditionBranch (AST eval)
       │    ├─ loop → walk body N times
       │    ├─ fan → Promise.all branches → join
       │    └─ pipeline → compositionRuntime.invoke(name, params, depth)
       └─ assemble Response (SSE stream or JSON)
```

## Message Refeed (payloadFor fix)

Current: `payloadFor` sends `{model, stream:false}` — no messages.

Proposed: `payloadFor(node, originalPayload, state)`:

```
payloadFor(node, originalPayload, state):
  messages = buildStepMessages(node, originalPayload, { lastResponse: state.lastResponse, lastContent: state.lastContent })
  return { ...originalPayload, model: node.model, messages, stream: false }
```

`buildStepMessages` (exported from engine.ts) switches on `node.mode` (default `"generate"`): generate → system+assistant+original; refine → system+assistant+original+lastContent; passthrough → original.

## Conditional Routing (on_429 / tool_calls_route)

After each non-terminal `llm_call` in the `walk` switch-case:

```
case "llm_call":
  const result = await provider.chat(payloadFor(n, opts.payload, curState), graph.name);
  curState = applyLlmResult(curState, result);
  exec.push(n.id);

  // Post-call routing (replaces hybrid-selector logic)
  if (curState.lastStatus === 429 && n.on_429) {
    cur = n.on_429;  // jump to fallback node
    break;
  }
  if (hasToolCalls(result) && n.tool_calls_route) {
    cur = n.tool_calls_route;  // jump to tool handler
    break;
  }
  cur = nextId;  // default sequential
  break;
```

## Composition Wiring

Add `pipeline` case to `walk`:

```
case "pipeline":
  const invoked = compositionRuntime.invoke(n.pipeline ?? "", n.params ?? {}, depth);
  curState = { ...curState, lastResponse: invoked.lastResponse, lastContent: invoked.lastContent, lastStatus: invoked.lastStatus };
  cur = onlySuccessor(n.id);
  break;
```

`compositionRuntime` is created via `createCompositionRuntime` from `composition.ts` with `getPipeline: deps.getGraph` (registry lookup). Depth starts at 0; `walk` threads current depth.

## Schema Design

```typescript
// Recursive AST — capped at depth 12 via z.refine
const astExprSchema: z.ZodType<AstExpr> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("exists"), field: z.string() }),
    z.object({ op: z.literal("not"), child: astExprSchema }),
    z.object({ op: z.literal("logical"), and: z.boolean(), args: z.array(astExprSchema).min(1).max(10) }),
    z.object({ op: z.literal("compare"), field: z.string(), op2: z.enum(["==","!=","<","<=",">",">="]), value: z.unknown() }),
  ])
).superRefine((val, ctx) => {
  if (astDepth(val) > 12) ctx.addIssue({ code: "custom", message: "condition nesting exceeds max depth 12" });
});

const graphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["start","end","llm_call","condition","loop","fan","join","pipeline"]),
  model: z.string().optional(),
  mode: z.enum(["generate","refine","passthrough"]).optional().default("generate"),
  provider: z.string().optional(),
  system: z.string().optional(),
  assistant: z.string().optional(),
  user: z.string().optional(),
  ctx: z.union([z.number().int().positive(), z.string()]).optional(),
  pos: z.object({ x: z.number(), y: z.number() }).optional(),
  on_429: z.string().optional(),
  tool_calls_route: z.string().optional(),
  condition: astExprSchema.optional(),
  body: z.array(z.string()).optional(),
  pipeline: z.string().optional(),
  params: z.record(z.string()).optional(),
  parallel: z.boolean().optional(),
  guard: z.string().optional(),
}).strict();

const graphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  guard: z.string().optional(),
}).strict();

// chainConfigSchema replaces steps with nodes/edges
const chainConfigSchema = z.object({
  name: z.string().optional(),
  displayName: z.string().optional(),
  defaultProvider: z.string().optional(),
  provider: z.string().optional(),
  nodes: z.array(graphNodeSchema).min(1),
  edges: z.array(graphEdgeSchema).default([]),
});
```

## Registry Simplification

```typescript
interface PipelineRegistry {
  getGraph(id: string): GraphPipeline | undefined;
  reload(graphs: GraphPipeline[]): Promise<void>;
  listGraphs(): GraphPipeline[];
}
// chainMap, ParsedChain, asMap() removed
// listGraphs() replaces asMap() for /v1/models listing
```

## Parity Test Strategy

1. **Baseline capture**: Before deleting `runChain`, add a test helper that runs each of the 6 migrated chains through the linear engine with a fake provider that records `(stepType, model, messages, stream)` calls.
2. **Snapshot**: Serialize call sequences to `__snapshots__/linear-parity.json` (generated once, committed).
3. **Graph parity**: Run the same 6 chains through `runGraphEngine` with the same fake provider. Assert identical call sequences.
4. **Gate**: Parity test must pass before any deletion commit.

## Migration Order

1. Schema (`schema.ts`) — add graph schemas, remove `steps`
2. `GraphNode` interface (`graph.ts`) — add fields
3. `buildStepMessages` export + `payloadFor` fix (`engine.ts` + `graph-engine.ts`)
4. `on_429`/`tool_calls_route` in graph-engine `walk`
5. Composition wiring (`graph-engine.ts` + `composition.ts`)
6. Registry simplification (`registry.ts`)
7. Route dispatch (`chat.ts`, `completions.ts`)
8. Config migration (YAML files)
9. `pos` preservation (`graph-model.js`)
10. Parity test gate
11. Deletions: `runChain`, `hybrid-selector.ts`, `parser.ts`, `chain.ts` types
12. Cleanup: remove `isLinearCompatible`, `chainToGraph`

## Risks

| Risk | Mitigation |
|------|------------|
| Parity divergence in `payloadFor` message construction | Fake-provider parity test captures exact message arrays; diff on failure |
| `z.lazy` stack overflow on deeply nested AST | `superRefine` depth cap at 12; admission-only (not hot path) |
| Removing `steps` breaks external configs | Atomic removal after all known configs migrated; clear error message on `steps` |
| Composition depth + graph walk depth interaction | `compositionRuntime.invoke` checks depth independently; `walk` doesn't recurse on composition |
| `on_429` semantics differ between linear (catch + jump) and graph (post-call check) | Linear catches thrown errors; graph checks `lastStatus` after successful `applyLlmResult`. Both produce the same routing. Parity test validates with fake provider returning `{status:429}` |

## Key Learnings

1. `payloadFor` in graph-engine sends empty messages — the linear engine's `buildStepMessages` is the correct reference for message construction.
2. `buildPayload` in graph-model.js deliberately deletes `pos` — this must be inverted to preserve layout positions through config round-trip.
3. The dashboard already sends `nodes`/`edges` but zod strips them — schema fix unblocks live apply immediately.
4. `composition.ts` is correct and tested but dead at runtime — wiring `getPipeline` from registry activates it with no code changes to composition.ts itself.
5. `isLinearCompatible` and `chainToGraph` become dead code once all chains are graph-format and hybrid selector is removed.
