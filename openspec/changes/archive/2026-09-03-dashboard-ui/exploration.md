# Exploration: Dashboard UI + Visual Pipeline Editor

Change: `dashboard-ui` · Scope: investigate how the proposed Dashboard/Visual-Pipeline-Editor
architecture maps onto the CURRENT `llm-proxy` codebase (Bun.serve, linear chains).
No production code changed — this exploration only reports.

## Current State

The gateway today is a **Bun.serve fetch handler**, not Express, and its chains are
**linear step lists**, not graphs. The two proposed-module pillars must therefore be
integrated into the fetch dispatcher and a graph model must be layered on top of the
linear step engine. Evidence below.

### 1. Routing: Bun.serve fetch dispatcher (NOT Express)

- `src/index.ts` boots `config → manager.start() → parseChains → createApp → Bun.serve`.
  It then calls `Bun.serve({ port, hostname, fetch: app })` with `app` from `createApp`.
- `src/server.ts` `createApp(deps: ServerDeps)` returns a single
  `(req: Request, server: BunServer) => Promise<Response>` fetch handler. Inside, it
  manually dispatches on `url.pathname` + method:
  - `OPTIONS` → CORS preflight (`corsHeaders`)
  - `authGuard(req)` → optional `BEARER_TOKEN` 401 (no-op when unset) — `src/middleware/auth.ts`
  - `GET /health[,/live,/ready]` → `healthHandler(req)` — `src/routes/health.ts`
  - `GET /v1/models` → `modelsHandler(req)` — `src/routes/models.ts`
  - `POST /v1/chat/completions` / `/v1/completions` → `server.timeout(req,0)` (per-request
    SSE idle-timeout disable, ADR-2) then `chatHandler`/`completionsHandler` —
    `src/routes/chat.ts`, `src/routes/completions.ts`
  - unknown → normalized 404; any throw → `errorHandler` (`src/middleware/errors.ts`)
- `ServerDeps` = `{ config, chains, providers, manager }`. Handlers are created once in
  `createApp` from these deps and closed over — routes never re-read config at request time.
- **Express is still in `package.json` deps but the runtime never uses it** (all routes
  are fetch handlers). The dashboard MUST integrate via new branches in this fetch
  dispatcher, NOT via `app.use`/`router.mount`. There is no Express `app` object to mount on.
- Error envelope is `{ error: { message, type, param, code } }` (builder in
  `src/routes/chat.ts` `jsonError` + `src/middleware/errors.ts` `buildErrorResponse`);
  security headers come from `securityHeaders()` (`X-Content-Type-Options`, `X-Frame-Options`,
  `X-XSS-Protection`, `Referrer-Policy`) merged by `withSecurity`.

### 2. Orchestration: linear step chains (NOT graph)

- `src/types/chain.ts` models a chain as an **ordered list of steps**: `Step[]` with
  `type: "generate"|"refine"|"passthrough"`, plus optional `on_429` (fallback step name)
  and `tool_calls_route` (step name to jump to when response carries tool_calls).
  `Chain` = `{ name, displayName?, defaultProvider?, provider?, steps[] }`.
- `src/config/schema.ts` re-declares this: `stepConfigSchema` (the 6 fields above, minus
  provider-default filling) and `chainConfigSchema` (`steps: z.array(...).min(1)`).
- `src/orchestrator/parser.ts` `parseChains(config)` returns `Map<string, ParsedChain>`
  (a `Chain` with `steps` resolved so each has a non-optional `provider`). It validates
  at boot: empty-chain refusal, `on_429`/`tool_calls_route` step-name references.
  **Registered once at startup** from `config.chains`; no mutation, no `reload()`.
- `src/orchestrator/engine.ts` `runChain(chain, providers, rawBody, signal, query)` walks
  the steps with a `for` loop + `i` rewind for `on_429` / `tool_calls_route` (a linear
  control-flow with two "jump targets", NOT a node/edge graph). Steps feed `StepContext`
  (`lastResponse`, `lastContent`) forward. Final step may stream via `buildStreamBody`
  (SSE contract: exactly ONE terminal chunk, `[DONE]`, client-disconnect abort, 429
  fallback, single error chunk).
- **No node/edge/condition-AST structure exists anywhere.** Grep for `nodes|edges|condition|
  graph|loop|exists|eval|new Function` across `src/` returns nothing. The ONLY conditionals
  are the two flat step-name fields (`on_429`, `tool_calls_route`) — there is no AST
  condition interpreter, and `graph.ts` (nodes/edges + SAFE AST evaluator) is entirely new.
- The proposed `src/orchestrator/graph.ts` + mutable `registry.ts` would be **additive**:
  they must coexist with the existing linear `ParsedChain` engine or the engine itself must
  learn to render a linear chain from a graph (backward-compat) — a design decision for
  propose/spec.

### 3. How pipelines/config are loaded today

- `src/config/load.ts` `loadRawConfig`: `Bun.YAML.parse(await Bun.file(path).text())` for
  `.yaml/.yml`, `JSON.parse` for `.json`; injectable `LoaderDeps` (file, yamlParse). Missing
  file → `ERR_CONFIG_NOT_FOUND`; non-object → `ERR_CONFIG_NOT_OBJECT`. Honors `CONFIG_FILE`
  (default `./llm-proxy.config.yaml`) — `src/config/index.ts` `loadGatewayConfig`.
- `loadGatewayConfig` zod-validates via `configSchema`, then sets `chain.name` from the
  record key and fills default providers. **Static single load** — called once at boot in
  `src/index.ts` line 36; the resulting `GatewayConfig` is frozen into `ServerDeps`.
- There is **no `defaults.ts`** (no minimal-config generation) and **no `watcher.ts`** (no
  `modelsDir` `*.gguf` scan). The managed backend's model list comes from
  `Object.keys(config.llama.models)` → `manager.status().models` (`src/backend/manager.ts`),
  validated against `modelsDir` on disk by `src/backend/validation.ts`. A `*.gguf` scan and
  a `defaults.ts` are entirely new.
- `defaultChain` is declared in schema + returned in `/health`, but **NOT used in routing**:
  `resolveChainId` in chat/completions only checks `X-Chain-ID` and the `gateway/` prefix.

## Affected Areas

- `src/server.ts` — extend the fetch dispatcher with `GET|POST /api/ui/*` branches and serve
  the SPA at `/ui` (static assets), reusing `authGuard`/`withSecurity`/`errorHandler`.
- `src/dashboard/router.ts` (NEW) — `/api/ui/*` route handlers + SPA file serving, built as
  fetch-handler-style functions to match the existing pattern.
- `src/dashboard/service.ts` (NEW) — pipeline CRUD, zod validation, atomic YAML write
  (Bun.write(tmp) → `fs.renameSync`), reload the registry.
- `src/dashboard/execution-tracker.ts` (NEW) — in-memory execution registry (state, metrics,
  per-step logs).
- `src/dashboard/metrics.ts` (NEW) — aggregate per-step metrics.
- `src/dashboard/events.ts` (NEW) — SSE pub/sub event bus with bounded buffer/backpressure.
- `src/orchestrator/registry.ts` (NEW) — mutable in-memory pipeline registry with atomic
  `reload()`; supersedes the boot-time `parseChains` single `Map`.
- `src/orchestrator/graph.ts` (NEW) — node/edge validation (acyclic except loops, ref/model
  existence, 1 start + ≥1 end, required fields) + SAFE typed-AST condition evaluator
  (no `eval`/`new Function`), evaluating compare/logical/not/exists over literals +
  contextual vars (`lastResponse.status/content`, `error`, `variables`).
- `src/config/watcher.ts` (NEW) — scan `modelsDir` for `*.gguf`, case-insensitive paths,
  emit `models:changed` SSE.
- `src/config/defaults.ts` (NEW) — generate minimal config if `llm-proxy.config.yaml`
  missing, scan `~/models`.
- `src/index.ts` — boot: construct registry + watcher + events + execution tracker,
  pass them into `createApp`, and make chain resolution read the mutable registry instead
  of the frozen `chains` Map.
- `src/routes/chat.ts` / `completions.ts` / `models.ts` — read chains from the registry
  (which is `Map<string, ParsedChain>`-compatible) so virtual models reflect live edits.
- `src/ui/*` (NEW) — vanilla `index.html`/`app.js`/`styles.css`, SVG-native graph render,
  HTML5 DnD, `<dialog>`, Zod for connection schema validation.
- `openspec/specs/*` — a new `dashboard-ui` capability spec (or delta to
  `pipeline-orchestration`) to pin requirements/scenarios.

## Approaches

1. **Extend the existing fetch dispatcher directly (dashboard routes + registry replace the
   frozen chains Map).**
   - Pros: matches the Bun.serve reality exactly; no Express re-introduction; reuses
     `authGuard`, `withSecurity`, `errorHandler`, `server.timeout(req,0)` for SSE; minimal
     new machinery; `Map<string, ParsedChain>` keeps all existing route/tests working.
   - Cons: `createApp`'s routing `if/else` grows; SPA static serving must be hand-rolled in
     the fetch handler (content-type mapping, path traversal guard).
   - Effort: Medium

2. **Re-introduce an Express `app`/`router.mount` layer for `/api/ui/*` + `/ui` only.**
   - Pros: matches the PDFs' "mount(app)"/"Express router" wording literally; familiar
     middleware syntax.
   - Cons: dies against the codebase ground truth — there is no Express app, Express was
     deliberately removed from the runtime, and mixing Express into a Bun.serve
     `(req)=>Response` world introduces a second, incompatible networking model and
     duplicated security/error wiring. Would undo a completed migration.
   - Effort: High (and architecturally regressive)

3. **Extract a small path-dispatch table / mini-router helper in `server.ts` before adding
   the dashboard.**
   - Pros: replaces the growing `if/else` chain with a declarative `{method, pathPattern} →
     handler` table; dashboard routes register cleanly; SSE/`server.timeout` special-casing
     stays local; least disruptive to existing behavior tests.
   - Cons: adds a new abstraction to a readable dispatcher; must keep the `/v1/*` stream +
     per-request timeout semantics intact.
   - Effort: Medium

## Recommendation

**Approach 1** (extend the fetch dispatcher, replace the frozen chains Map with the mutable
registry), layered with Option 3's small dispatch table if the `if/else` grows beyond comfort.

Rationale:
- The codebase is unambiguously Bun.serve; the PDFs' Express wording is stale. The dashboard
  MUST integrate as fetch-handler branches in `createApp`. Re-introducing Express (Option 2)
  is a regression and rejected.
- The mutable `registry.ts` keyed `Map<string, ParsedChain>` is backward-compatible with every
  existing consumer (`chat.ts`, `completions.ts`, `models.ts`, `health.ts`, and all route
  tests reference `Map<string, ParsedChain>`). Swapping the frozen `parseChains` result for a
  registry that also returns a `Map<string, ParsedChain>` keeps the whole existing surface
  green while adding `reload()`/subscribe.
- Run the SSE `/api/ui/events` through the same `server.timeout(req,0)` pattern already proven
  for `/v1/*` streams.
- Preserve invariants verbatim: no buffering of `/v1/*` streams, single terminal chunk,
  `{error:{message,type,param,code}}`, no new SSRF hosts (upstream URL always config-derived),
  fail-fast bootstrap, `autoStart:false` respected, `BEARER_TOKEN` optional auth reused.

## Risks

- **Graph-vs-linear gap (highest).** `graph.ts` (nodes/edges + condition AST + loops) is
  entirely new; today only linear steps + two flat jump fields exist. The propose/spec phase
  must decide: does the visual editor produce linear `Step[]` (backward-compat, editor maps
  straight-line pipelines) or a true new graph model that the engine must execute? A new graph
  execution path risks diverging from the proven `runChain` — recommend the registry keeps
  serving `ParsedChain` and graph validation gates what shapes are admitted.
- **Atomic reload safety.** Editing/apply must not tear the running config: build config from
  the draft, zod-validate it, atomically write (tmp + `fs.renameSync`), then `reload()` the
  registry; on any failure keep the previous registry and return the error. Concurrency on
  concurrent apply/validate requests needs a mutex or single-flight.
- **SSE in Bun.** One `server.timeout(req,0)` precedent exists; multiple simultaneous SSE
  clients (`/api/ui/events`) need a pub/sub with bounded buffer + backpressure (the proposed
  `events.ts`). Must handle client disconnect cleanly.
- **Preserving stream invariants.** The dashboard's execution tracking must not buffer or
  transform `/v1/*` streams; per-step logs must come from pass-through observation, never by
  buffering the SSE body.
- **SSRF.** New graph condition context (e.g. `variables`) must never carry upstream URLs;
  routing target stays config-derived (extend the existing sanitize/routing boundary).
- **Frontend size.** A vanilla dashboard is sizable; the 400-line review budget (Section E)
  will blow on first delivery unless the work is chained/stacked (backend registry+API first,
  then SSE+tracking, then static UI).
- **`defaultChain` dead field.** Not currently used in routing; dashboard wiring may surface it
  — clarify intent (route fallback when no gateway:/X-Chain-ID) or leave as reporting-only.
- **`modelsDir` scan vs config models.** `watcher.ts`/`defaults.ts` scan `*.gguf`, but the
  runtime model list is `config.llama.models` keys. Decide whether scanned GGUF files are
  offered as candidate models for the editor or actually registered.

## Ready for Proposal

**Yes** — pending the orchestrator telling the user:
1. The codebase is **Bun.serve**, not Express; the dashboard will integrate into the existing
   fetch dispatcher (Option 1), NOT via Express mounting. The PDFs' "mount(app)" wording is
   stale.
2. The graph model / condition-AST / loops from the PDFs do NOT exist — today it's linear
   steps + `on_429`/`tool_calls_route`. The propose phase must pick the graph↔linear bridge:
   editor admits linear (and step-conditional) pipelines served as `ParsedChain`, with graph
   validation gating admission, OR a genuinely new graph executor — the latter is a much
   larger change.
3. Delivery of this change will exceed the 400-line review budget; expect chained/stacked PR
   slices (backend registry+API → SSE/tracking → static UI).
4. `defaultChain` is currently unused in routing (reporting-only); worth deciding during spec.
