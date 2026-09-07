# Exploration: svelte-ui

Validates the approved quest/RFC (`openspec/changes/svelte-ui/quest.md`, Approval: approved) against the real codebase. Answers: *can the approved RFC be built here?*

## Current State

### Current UI inventory (`src/ui/`, 158,567 bytes raw)

- `index.html` (191 lines) — static shell, `lang="es"`, five hash-anchored views (Editor, Pipelines, Modelos, Ejecuciones, Agentes), node palette with six base blocks (`start/llm_call/condition/loop/pipeline/end`, `data-key` 1–6), canvas toolbar (Nuevo, Nombre, Validar, Ver flujo, Aplicar, Limpiar), node-switcher carousel, inspector, two dialogs (node config, apply error) plus a validate-errors dialog, Backend lifecycle panel (TTL / VRAM mode / freeGb / capGb), agents view with token row. Scripts via `<script type="module" src="/ui/app.js">`.
- `app.js` (2,325 lines ≈ 95 KB raw, unminified) — vanilla controller. Imperative `render()` rebuilds the ENTIRE SVG tree (`createElementNS`) on every mutation, including per-pointermove during drag/pan/connect (no rAF batching today). State: `{nodes, edges, selectedId, nextId, models, pipelines, applyError, drag, connect, view{zoom/pan}, pan}`.
  - Editor interactions: palette drag (`text/plain` + `llm_call:<model>` / `pipeline:<name>` payloads) and palette click-to-add; drop on canvas (screen→graph coords); numeric keys 1–6 add nodes (canvas focused); Delete/Backspace removes selected; wheel zoom 0.2×–3× at cursor; background drag pans; node drag via pointer capture; click selects; port-to-port connections resolved by NEAREST input socket within a 24 px screen hit radius; condition nodes expose `true`/`false` branch sockets (guards drawn, "Sí"/"No" labels); edge delete via midpoint circle; loop containers wrap body members (auto-stack `stackLoopMembers`), `+ Agregar bloque` button, drop-into-loop, drag-out-of-loop re-buckets membership, inspector reorders/removes members; node-switcher carousel (chips, arrows, arrow-key rotation, scroll fades); flow animation (`computeFlowOrder` mirrors engine semantics: start → first edge, condition takes true branch, loop walks body then exits; 300 ms steps, `flow-active`/`flow-past` classes).
  - Inspector: per-type tabs (Config./Prompt/Avanzado only for `llm_call`), model select, ctx selector filtered by `min(ggufContextLength, hardwareMaxCtx)` with custom + unsafe options, prompt/assistant char counters, mode pills, `on_429`/`tool_calls_route` orphan-tolerant selects, provider input, guard select, pipeline params key/value rows, condition pill-builder (compare/exists rows, negate, AND/OR combine, live Spanish phrase), loop members block.
  - Lifecycle: `GET /api/ui/config` → merge → `POST /api/ui/apply`; unload-all; per-model unload; VRAM field visibility by mode; 5 s auto-refresh while the models view is visible.
  - SSE: `EventSource("/api/ui/events")`; subscribes to 7 events INCLUDING `execution:failed`; native auto-reconnect with `connecting/connected/disconnected` status states; handlers re-fetch lists (models/pipelines/executions).
  - REST calls (all match existing routes): `GET /api/ui/pipelines`, `GET /api/ui/pipelines/:id`, `POST /api/ui/pipelines/:id/validate`, `POST /api/ui/apply`, `GET /api/ui/models`, `POST /api/ui/models/:id/unload`, `POST /api/ui/models/unload-all`, `GET /api/ui/config`, `GET /api/ui/executions?limit=50`, `GET /api/ui/agents/status`, `POST /api/ui/agents/configure`. The `POST /api/ui/executions/:execId/steps/:nodeId/retry` endpoint EXISTS but app.js never calls it today.
- `styles.css` (1,523 lines ≈ 33 KB) — GitHub-dark token system matching dashboard-ui theme contract exactly (`#0d1117/#161b22/#1c2128`, `#58a6ff` accent, `--status-*` socket/loop tokens, JetBrains Mono 14px/1.6, `:focus-visible` rings, 150 ms transitions, thin scrollbars), plus all component styles (palette, canvas, nodes, sockets, loop containers, edges incl. guard variants, chips, dialogs, lists, param rows, cond builder, flow animation classes, lifecycle panel, agents cards).
- `graph-model.js` (569 lines) — pure framework-free logic: `createNode`, `layoutGraph` (layered, user-fixed `pos` respected), `buildPayload` (`pos` preserved), `moveNode`, `deleteNode` (also cleans loop bodies), `connectNodes` (guarded edges, self-edge rejection), `socketPositions`/`conditionSockets`/`outSocketFor`, `bezierEdge`, `loopBodyRect`/`loopContainsPoint`, `stackLoopMembers`, `ownerLoopId`, `stripLoopInternalEdges`, `describeCondition`/`buildCondition`/`condAstToRows` helpers (closed compare/exists/not/logical AST, Spanish phrasing), `llmModeLegible`, `describeLlmCall`/`describePipeline`/`describeLoop`, `paramsToRows`/`rowsToParams`, `isCompleteNode`/`requiredField`. Tested by `graph-model.test.js` (671 lines, ~37 cases across 14 describes).

### Dashboard API surface (boundary NOT to change)

`src/dashboard/router.ts` (918 lines) dispatches exactly the endpoints app.js consumes (verified against `router.test.ts` / `router-lifecycle.test.ts` / `server-dispatch.test.ts`). Payloads:
- `GET /api/ui/pipelines` → `[{id, description, nodeCount, lastExecution}]`
- `GET /api/ui/pipelines/:id` → full graph `{nodes, edges}`
- `GET /api/ui/models` → `{models:[{id,file,loaded,ggufContextLength,hardwareMaxCtx,ctx,effectiveCtx,processLoaded,lastUsed,...}], modelsDir, autoRefresh, lifecycle:{vramPolicyActive,lastVramSample,recentUnloads}}` (richer than the spec's minimum list — app.js relies on the extra fields)
- `GET /api/ui/executions?limit=N` → `[{id, pipelineId, status, totalLatencyMs}]` — STEPS ARE NOT EXPOSED (`ExecutionTracker` records `steps[]` internally but the route maps only 4 fields)
- `POST /api/ui/pipelines/:id/validate` → `{valid:true}` | `{valid:false, errors:[...]}`
- `POST /api/ui/apply` `{config:{chains:{...}}}` → `{status:"applied", reloadedChains:[...]}` | 400 `{error:{message,type,param,code}}`
- `POST /api/ui/executions/:execId/steps/:nodeId/retry` (exists; unused by current UI)
- `GET /api/ui/config` → live `config` incl. `llama.lifecycle.{ttl,vram.{mode,freeGb,capGb}}`
- `POST /api/ui/models/:id/unload`, `POST /api/ui/models/unload-all`
- `GET /api/ui/agents/status`, `POST /api/ui/agents/configure` (`{agent, apiKey?}`)
- `GET /api/ui/events` → SSE, events: `execution:started`, `step:started`, `step:completed`, `step:failed`, `execution:completed`, `execution:failed`, `pipeline:reloaded`, `models:changed` (`src/dashboard/events.ts` typed union). NOTE: the RFC's contract list omits `execution:failed`; the spec + events.ts include it and app.js subscribes to it — the Svelte service must handle all 8 event names.
- Auth boundary: `/ui` static served BEFORE the auth guard (`src/server.ts:206-250`); `/api/ui/*` + SSE behind `BEARER_TOKEN` guard. Unchanged.

### Static serving + delivery (verified, matches the given evidence)

- `resolveUiAsset` (`src/server.ts:11-29`): `/ui` prefix only, `raw` must be a single segment — rejects forward slash, `\`, leading `.`, `..` (nested path → null → 404). NO subdirectories, NO SPA fallback (unknown → 404 JSON `{error:{...}}`).
- `contentTypeFor` (`:32-51`): html/js/css/json/svg/png/ico + octet-stream default.
- `GET /ui` block (`:212-250`): serves `Bun.file(joinUIPath(uiDir, file))` when the file exists.
- `uiDir`: default `"./src/ui"` cwd-relative, `UI_DIR` env override (`src/index.ts:521`). Binary: `bun build src/index.ts --compile` only — NO embedded assets today.
- Bun supports embedding: `bun build --compile --asset <dir>` / `compile.assets` embeds directories, readable at runtime via `import.meta.dir` + `Bun.file` (verified against current Bun docs) — this is the self-contained-binary mechanism.
- Test harnesses: `static-spa.test.ts` (real createApp + tmp uiDir), `e2e-smoke.test.ts` (uiDir = real `src/ui`, asserts served HTML/JS/CSS contents), `e2e/e2e-server.ts` (`UI_DIR = src/ui`, fake dashboard deps, seed data), `e2e/dashboard.spec.ts` (Playwright against the harness).

## Affected Areas

- `src/ui/*` (index.html, app.js, styles.css, graph-model.js + test) — REPLACED by the Svelte SPA; graph-model.js → framework-free TS port.
- `src/server.ts` (`resolveUiAsset`/`contentTypeFor`/`joinUIPath` + `/ui` block) — extended: asset subdirectory traversal-safe resolution + SPA fallback to index.html. Traversal rejection must be preserved.
- `src/index.ts` — `uiDir` default flips to the compiled output dir; binary path resolves embedded assets (`import.meta.dir`) instead of cwd-relative `./src/ui`.
- `src/dashboard/static-spa.test.ts` — assertions "nested paths rejected" / "unknown asset → non-200" directly conflict with the mandated subdir+fallback change; must be rewritten to the new contract.
- `src/dashboard/e2e-smoke.test.ts` — asserts `/ui/app.js` contains `createElementNS`, `graph-model.js`, no framework imports; compiled hashed output changes all of this; must be rewritten against the compiled SPA.
- `e2e/dashboard.spec.ts` + `e2e/e2e-server.ts` — harness `UI_DIR` must point at the build output; Playwright specs must be rewritten (see Impact: they are ALREADY stale).
- `package.json` — `build:ui` (+ `install`/`preview`), `build:binary` extended with `--asset` embed of the compiled UI.
- `openspec/specs/dashboard-ui/spec.md` — Reqs "Static SPA serving" ("no client build step") and "Vanilla frontend" (no framework at runtime) are SUPERSEDED by the approved migration; sdd-spec must write the delta. Theme contract (tokens, 37.39 px header binding, AA pairs) carries over as-is per the RFC's "no redesign" non-goal.
- Unaffected: `src/dashboard/router.ts`, `events.ts`, `service.ts`, `execution-tracker.ts`, `metrics.ts`, `retry.ts`, graph-engine, all `/api/*` and `/v1/*` routes.

## Impact

This change MODIFIES/REMOVES existing behavior (UI content + static-serving contract), so regressive impact is substantive, not greenfield:

| Surface | Status | Regression risk |
|---|---|---|
| `graph-model.test.js` (37 cases) | Must keep passing (ports to TS 1:1) | Migration must not alter graph logic semantics; `bun test` stays green |
| `static-spa.test.ts` | MUST be updated (2 assertions flip) | The path-traversal tests must STILL pass under the new resolver — only subdir/fallback semantics change |
| `e2e-smoke.test.ts` | MUST be rewritten | Served-asset assertions (`app.js`, `graph-model.js`, `createElementNS`) can't hold on compiled output; keep the WCAG/a11y landmark assertions |
| `e2e/dashboard.spec.ts` (Playwright) | MUST be rewritten — **already stale today** | Current specs expect English UI (`llm-proxy Dashboard` title, `aria-label="Primary"`, 4 nav links, "Validate" button) but the shipped UI is Rioplatense Spanish, 5 views, "Principal", "Validar" — the suite would fail against the CURRENT code today; RFC AC7 mandates updated e2e |
| `e2e/e2e-server.ts` | harness `UI_DIR` + webServer `url` | Point at build output; dashboard fakes are untouched so REST/SSE fixtures survive |
| `router.test.ts`, `router-lifecycle.test.ts`, `server-dispatch.test.ts`, `events.test.ts`, `service.test.ts`, `agent-config.test.ts`, `execution-tracker.test.ts`, `retry.test.ts`, `metrics.test.ts` | Unchanged | Contract untouched → must stay green as the regression net for API parity |
| `dashboard-api` / `graph-engine` specs | Unchanged | No REST+SSE or engine behavior changes → no delta needed |
| `dashboard-ui` spec | DELTA REQUIRED | "Vanilla frontend" + "no client build step" are superseded by the approved RFC; theme contract + accessibility requirements carry over |
| `resolveUiAsset` callers (`src/server.ts`, e2e) | Extended | Traversal guard must remain; fallback must not mask legitimate 404s for `/api/*` (fallback scoped to `/ui/*` only) |

Not manufactured: no risk to `/v1/*`, providers, backend manager, shutdown, or config loading — none are touched.

## Approaches

1. **Svelte 5 + Vite, build-only** (no SvelteKit) — `vite` + `@sveltejs/vite-plugin-svelte` (official, ~v6 maturity) compile `src/ui-svelte/` → `dist/ui` (`index.html` + hashed `assets/*`), served from disk by the Bun backend; `build:binary` adds `--asset dist/ui`.
   - Pros: official mature toolchain; full component sourcemaps (mitigates the RFC's "no sourcemaps degrades debug" concern); `lang="ts"` in components; standard minified hashed output; no external router (hash navigation is hand-rolled exactly as the RFC mandates); Vite used ONLY as a builder — the RFC's dev flow ("compiled build served from disk by the Bun backend, no separate frontend server") holds.
   - Cons: adds the Vite toolchain as a devDep; dev iteration needs a watch/rebuild step (or opt-in `vite dev`); SvelteKit is NOT used, so no SSR/fallback plumbing (correct, it's CSR-only).
   - Effort: Medium

2. **Svelte 5 + `bun-plugin-svelte`** (single Bun toolchain, current latest 0.0.6) — `bun build src/ui-svelte/main.ts --outdir dist/ui` with the plugin loading `.svelte`.
   - Pros: one toolchain (bun build does server + UI); no Vite/node_modules complexity; trivially fits the disk-served dev flow.
   - Cons: 0.0.x pre-1.0 maturity; NO component sourcemaps (RFC explicitly flags this as its failure case); no preprocessors; `lang="ts"` support unproven (risks the strict-TS mandate inside components); debug experience leans entirely on trace logging.
   - Effort: Medium

3. **SvelteKit + adapter-static** (or `@sveltejs/adapter-bun` 1.0.0-next.1) — mature framework path.
   - Pros: battle-tested build pipeline; adapter-bun `compile: true` can embed the whole app into one binary.
   - Cons: SvelteKit's router/Vite-dev-server model fights the RFC's "hash-based SPA without an external router" and "no separate frontend server in the normal flow"; `_app/immutable/` output needs the serving extension anyway; adapter-bun is a prerelease (1.0.0-next.1) and compiling the WHOLE gateway through it is a much larger blast radius than embedding static assets; heaviest dependency footprint for a CSR dashboard.
   - Effort: High

### Editor rendering strategy

Current `render()` is 100% imperative full-SVG rebuild per mutation. Two viable strategies (RFC leaves to design):
- **Declarative Svelte SVG** (recommended): `<svg>` component with `{#each}` over nodes/edges, reactive stores for graph state; pointer-drag/pan/connect updates flow through stores with rAF batching; Svelte diffs per-node/per-edge instead of the current whole-tree rebuild. All geometry/layout stays pure in the TS `graph-model` port → unit-testable unchanged.
- **Isolated imperative renderer**: keep a framework-free render module (like today) mounting into an SVG container; Svelte owns the shell. Fallback if pointer-throughput profiling shows jank; preserves the current architecture almost verbatim but forfeits most of Svelte's declarative value.

Both satisfy the RFC invariants (rAF coordination, DPR awareness via the component layer, ResizeObserver cleanup in `onDestroy`/effect teardown).

## Recommendation

**Svelte 5 + Vite (build-only)** for the toolchain — official/mature, full sourcemaps, TS in components, exactly the RFC's output shape (hashed subdirs + SPA fallback, both RFC-sanctioned server changes), and the dev flow stays disk-served with no frontend server. `bun-plugin-svelte` is a credible fallback ONLY if the team accepts no-sourcemaps + JS-only components; SvelteKit is overkill and conflicts with the hash-router/CSR constraints. **Declarative Svelte SVG with rAF-batched store updates** for the editor, with geometry kept pure in the TS `graph-model` port. **Static serving**: extend `resolveUiAsset` to allow subdirectory segments (still rejecting `..`/leading-dot/backslash/absolute per segment) + fallback to `index.html` for unknown `/ui/*` GETs; **binary**: `bun build --compile --asset dist/ui` + runtime `uiDir` resolution via `import.meta.dir`, preserving the `UI_DIR` override.

Bundle budget grounding: current app.js is ~95 KB raw (~2,325 lines, unminified); minified + gzipped it lands well under the 100 KB gzip target even before Svelte's runtime (~4–6 KB gzip) and compiler-size reductions — achievable, verify with a measured production build in verify.

## Quest-validation findings (flagged, NOT blockers)

1. **Executions/metrics improvement granularity**: `GET /api/ui/executions` exposes ONLY `{id, pipelineId, status, totalLatencyMs}` — per-step detail (steps, per-step latency) lives in the tracker but is NOT sent. A per-execution step-detail view would VIOLATE the "no dashboard API contract changes" non-goal. Implementable as-is at LIST level: richer rendering of existing fields + SSE live updates + wiring the EXISTING (today-unused) step-retry endpoint + execution `:failed` handling. Proposal/spec must scope "executions/metrics" at this granularity.
2. **SSE event list**: RFC lists 6 events; the real contract (spec + `events.ts` + app.js) has 8 — `execution:failed` and `execution:failed` handling must be included; `execution:failed` also currently triggers `loadExecutions` on failure. The Svelte event service must not drop it.
3. **Stale Playwright specs**: not a conflict — AC7 mandates updated e2e; the current specs would fail against the CURRENT Spanish UI already (English expectations). Rewriting them is in-scope work, not regressions.
4. **dashboard-ui spec deltas**: "Vanilla frontend" / "no client build step" are superseded by the approved RFC — expected sdd-spec delta; theme + a11y requirements transfer unchanged.

## Risks

- Editor interaction parity is the highest-risk surface (24+ interactions inventoried above); the checklist must be mechanically walked during verify (drag/drop, keys 1–6, zoom, pan, select, delete, guard-aware connect with 24 px hit radius, loop bucket/reorder, dialogs, validate/apply, flow animation, switcher carousel).
- Static-serving change touches an auth-boundary-adjacent path (`/ui` before guard) — fallback must be `/ui/*`-scoped only and must never intercept `/api/*`; traversal tests must keep passing.
- Component sourcemaps are a stated RFC failure case only for bun-plugin-svelte; with Vite they are available — keep trace logging as the compensating mechanism anyway (RFC wants it regardless).
- The five 5 s-interval and SSE-triggered list refreshes must be consolidated into one store/services layer with throttled/batched updates so the "no main-thread jank under SSE load" invariant holds (today: unfettered re-fetch + full SVG rebuild).
- 100 KB gzip budget is feasible but must be measured on the production build in verify (AC5), since hashed chunking splits it across files.

## Ready for Proposal

**Yes** — the approved RFC is implementable as-is. The toolchain and editor-rendering evidence above resolves the RFC's sole open design questions. Two scope notes to carry into proposal/spec: (a) "executions/metrics" must be scoped to list-level data the API already sends (+ retry endpoint wiring), NOT per-step detail (contract non-goal); (b) the Svelte SSE service must handle all 8 event names including `execution:failed`. No quest re-open needed; these are scoping clarifications, not infeasibilities.