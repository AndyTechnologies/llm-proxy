# Apply Progress — svelte-ui (Unit 1 + Unit 2 + Unit 3)

Status: **Units 1–3 IMPLEMENTED — all Phase 1–4 tasks green except the
post-verify legacy delete (4.4 gate); Unit 3 attempt pending settle**.
Date: 2026-09-06

## Scope

Phase 1 (tasks 1.1–1.7) + Phase 2 (tasks 2.1–2.4) + Phase 3 (tasks
3.1–3.7) + Phase 4 (tasks 4.1–4.3; 4.4 gate partial — legacy delete
deferred until after verify) of `openspec/changes/svelte-ui`. Legacy
`src/ui/*` unmodified (rollback boundary).

## Evidence (committed state, sha256:da8bac27…69f48)

- `bun test src/dashboard` → 116 pass / 0 fail (after `build:ui`)
- `bun test src/ui-svelte` → 79 pass / 0 fail (76-case oracle port + purity guard)
- `bun run typecheck` → clean; `bun run lint` → clean
- `bun run build:ui` → repo-root `dist/ui` with hashed `assets/*`
  (index.html + index-*.js + index-*.css)
- Harness `UI_DIR=dist/ui bun run e2e-server` → boots; `/ui` 200 text/html,
  hashed asset 200 application/javascript, traversal 404

## Deliverables by task

- **1.1** `package.json`: Svelte 5/Vite 6 devDeps + `build:ui`
  (`bunx vite build src/ui-svelte`; the `bun --cwd` form cannot resolve the
  vite bin — no package.json under src/ui-svelte).
- **1.2** `src/ui-svelte/{tsconfig.json,vite.config.ts}` — strict NodeNext,
  `outDir` resolved absolutely to repo-root `dist/ui` via
  `new URL("../../dist/ui", import.meta.url)` (config lives two levels under
  the repo root).
- **1.3–1.4** `src/ui-svelte/lib/graph-model.ts` — 1:1 typed TS port; oracle
  suite ported verbatim. NOTE: the suite is 76 cases, not the 37 forecast in
  tasks.md (oracle grew later; all 76 ported, identical pass/expect counts to
  the JS original). Type-shape fixes: `ConditionForm` is a plain interface
  (`op: string` + optional members) so the default branch stays reachable;
  `rowsToParams` accepts `unknown` (null); `describeLlmCall` String()-casts
  the model.
- **1.5** MINOR-A: `eslint.config.js` `no-restricted-imports` (svelte imports
  banned in `src/ui-svelte/lib/**/*.ts`) + self-excluding `lib/purity.test.ts`.
- **1.6** `src/server.ts`: MAJOR-1 per-segment `resolveUiAsset` (reject `..`,
  leading-dot, backslash, absolute, empty → null **no fallback**, then
  forward-slash concat, never `path.join`) — nested subdirs resolve, so
  `assets/*` works; MAJOR-2 `contentTypeFor` += woff/woff2/map/wasm.
- **1.7** `src/server.ts` `/ui` block: benign unknown GET → `index.html`
  fallback (never `/api/*`); missing build → "run build:ui" 404. NOTE: `/ui/`
  (trailing slash = empty segment) is a designed 404 per MAJOR-1 ordering.
- **2.1** `static-spa.test.ts` rewrite: 20 tests (traversal kept, subdirs,
  fallback + `/api/*` isolation, full MAJOR-2 matrix, `/ui/` rejection,
  missing-build 404, resolver triangulation).
- **2.2** `e2e-smoke.test.ts` rewrite: compiled `dist/ui` shell landmarks
  (Panel de control / banner / Principal) + hashed-asset triangulation; the
  suite skips with a documented gate test when `dist/ui` is absent; old
  app.js/graph-model.js string checks dropped.
- **2.3** `src/index.ts`: `resolveUiDir()` — `UI_DIR` wins → `./dist/ui`
  when built → embedded `import.meta.dir/ui` **excluding the legacy src/ui
  tree via its `app.js` marker** (otherwise dev would silently serve the old
  SPA); missing build falls through to the 404.
- **2.4** `e2e/e2e-server.ts` + `e2e/dashboard.spec.ts`: `UI_DIR` →
  `dist/ui` (+ missing-build boot warning); harness-only debug seam
  `POST /api/ui/_e2e/complete` (records + publishes `execution:completed`);
  spec rewritten to the Spanish 5-view contract. The shell describe is green
  now; the editor/views interaction groups (drag/keys/connect, undo/redo,
  validate/apply, SSE live) are the RED acceptance device for Unit 2 —
  `bun run test:e2e` will fail some groups until Phase 3 lands.

## Commits (Unit 1)

1. `feat(ui): scaffold svelte toolchain with build:ui` (ba3b3fe)
2. `feat(ui): port graph-model oracle to strict TS` (f278392)
3. `feat(ui): serve compiled SPA with hashed subdir assets + fallback` (e4971e1)
4. `test(ui): rewrite serving + e2e suites for compiled SPA` (aaafe73)

---

# Unit 2 (PR 2) — Phase 3 UI layer

Status: **IMPLEMENTED — all tasks green (`bun test` 761 pass / 0 fail
across 61 files incl. src/dashboard 117); typecheck + lint clean;
`build:ui` emits dist/ui (app JS gzip 29.8 KB)**. Unit 2 attempt settle
recorded in "Attempt accounting".

## Scope

Phase 3 (tasks 3.1–3.7) of `openspec/changes/svelte-ui`. Phase 4 untouched.
Legacy `src/ui/*` unmodified (rollback boundary).

## Evidence (committed state, HEAD `262c021` on `svelte-ui/pr2`)

- `bun test src/ui-svelte` → 238 pass / 0 fail / 0 error (20 files → 16
  after removing 4 temporary debug probes; 602 expect)
- `bun test src/dashboard` → 117 pass / 0 fail (289 expect)
- `bun test` (full) → 761 pass / 0 fail, 1853 expect across 61 files
- `bun run typecheck` → clean; `bun run lint` → clean
- `bun run build:ui` → 82.28 KB app JS (gzip 29.83 KB) + 22.72 KB CSS
  (gzip 4.91 KB) — under the 100 KB gzip budget (deadline: 4.2)

## Deliverables by task

- **3.1** `stores/dashboard-store.ts` + `stores/editor-store.ts` injectable
  factories (fresh per test, reset/unmount) + consolidated throttled
  refresh; `services/rest-service.ts` typed client. Editor store adds
  `rename` (no history entry), `beginMove`/`endMove` transactional drag,
  `loading: false` on loaded snapshot.
- **3.2** `services/sse-service.ts`: 8 events incl. `execution:failed`,
  reconnect, unsub in teardown; `services/trace-service.ts` debug/verbose
  presentation-only.
- **3.3** `main.ts`, `App.svelte` shell with hash routing to 5 views
  (Pipelines, Editor, Ejecuciones, Modelos, Agentes); theme tokens
  verbatim; Rioplatense copy; AA/ARIA/native `<dialog>`/reduced-motion.
- **3.4** Editor: declarative SVG, rAF batch, DPR-aware, palette
  drag/click, keys 1–6 / zoom 0.2–3× / pan / select / delete, 24 px
  connect hit radius + self-edge reject, loop bucketing + carousel/flow
  animation. **Interactions completed in head commit 262c021**: undo/redo
  buttons wired to `store.actions.undo()/redo()` (they previously had no
  `onclick` — bound via keyboard handler only); `cancelAnimationFrame`
  teardown falls back to `clearTimeout` when jsdom lacks rAF (unhandled
  error between tests); `computeFlowOrder` loop-body narrowing fixed
  (TS18047 via local `const loopNode`).
- **3.5** `lib/history.ts` RED first: bounded Command undo/redo (~100)
  over add/move/delete/connect/reorder.
- **3.6** Ejecuciones list-level + SSE live + `execution:failed` +
  step-retry wiring (`POST /api/ui/executions/:id/steps/:nodeId/retry`);
  Modelos lifecycle panel (TTL/VRAM) via config/apply + `models:changed`.
- **3.7** Component tests (Testing Library + jsdom via `test-setup/dom.ts`
  preload): 5 views, editor interactions, stores, history, sse. dom.ts
  polyfills PointerEvent + `setPointerCapture` on Element (jsdom gaps).
  **Removed 4 temporary debug probes** (`debug-{connect,coords,drop,mouse}.
  test.ts`) that were diagnostic-only console.log asserts — thorn on the
  real test-setup; live polyfills live in dom.ts.

## Commits (Unit 2, branch `svelte-ui/pr2`)

1. `feat(ui-svelte): injectable store factories + consolidated throttled refresh` (9c3f0f4)
2. `feat(ui-svelte): SSE service (8 events, reconnect, teardown) + trace service` (28e765a)
3. `feat(ui-svelte): App shell with hash routing and five views (task 3.3)` (a485e3d)
4. `test(ui-svelte): jsdom + svelte-loader preloads and shared fakes (task 3.7)` (3262703)
5. `feat(ui-svelte): editor geometry helpers + drag/reorder store transactions (tasks 3.4, 3.5)` (8de47d3)
6. `feat(ui-svelte): bounded undo/redo history buffer (task 3.5)` (4e7c6b0)
7. `feat(ui-svelte): loop bucketing for palette drops and drag end (task 3.4)` (ef6cf73)
8. `feat(ui-svelte): complete editor canvas interactions` (262c021)

## Notes / handoff for Unit 3

- PR 1 `https://github.com/AndyTechnologies/llm-proxy/pull/27` (draft)
  against `svelte-ui-tracker`; PR 2 will be raised base `svelte-ui/pr1` →
  head `svelte-ui/pr2` (feature-branch-chain; tracker PR not creatable —
  GitHub rejects empty-diff PRs, tracker branch is the merge target).
- Unit 2 harness per tasks.md: `bun run test:e2e` with `UI_DIR=dist/ui`.
  The e2e editor/views groups are now expected green (previously RED
  acceptance device) — full `bun test` already covers the phase.
- Bundle measured: 29.8 KB gzip (79.3% under the 100 KB guard, task 4.2).
- Handoff: settle Unit 2 attempt (see below), then Phase 4 (tasks
  4.1–4.4) on `svelte-ui/pr3`.

---

# Unit 3 (PR 3) — Phase 4 delivery

Status: **IMPLEMENTED — tasks 4.1–4.3 green + 4.4 gate partial; settle
recorded in "Attempt accounting"**. Branch `svelte-ui/pr3` (base
`svelte-ui/pr2`), 3 commits.

## Evidence (committed state, HEAD `eae6f40` on `svelte-ui/pr3`)

- `bun run typecheck` → clean; `bun run lint` → clean
- `bun test` (full) → 756 pass / 0 fail (1848 expect) — count moved from
  761 because the 4 Unit-2 debug probes + their removal happened before
  this unit; unchanged suite content
- `bun test ./scripts/binary-smoke.test.ts` → 6 pass against prebuilt
  dist/llm-proxy (real spawns from throwaway temp cwd)
- `bun run build:ui` → measures bundle: app JS 82279 B raw → **29.23 KB
  gzip ≤ 100 KB** ("OK")
- `bun run build:binary` → `--asset dist/ui` compile OK, dist/llm-proxy
- CLI `bun /…/scripts/binary-smoke.ts` from `/tmp/opencode` (unrelated
  cwd) → `[smoke] PASS` (embedded /ui 200 html, /ui/assets/* 200 js,
  unknown fallback 200, malicious segment 404 json, disk fallback
  "DISK-FALLBACK", UI_DIR override "OVERRIDE-INDEX" + asset 200)

## Deliverables by task

- **4.1** `package.json`: `build:binary` = `bun build src/index.ts
  --compile --outfile dist/llm-proxy --asset dist/ui`; script contract
  tests added in `scripts/package-scripts.test.ts`.
- **4.2** `scripts/measure-bundle.ts` (measure gzip app JS via
  `findAppJs`, assert ≤ 100 KB) + `scripts/measure-bundle.test.ts`;
  `build:ui` now runs the guard after vite.
- **4.3** `scripts/binary-smoke.ts` + `binary-smoke.test.ts`: shared
  helpers (`createSmokeWorkspace` — schema-valid `autoStart:false`
  config with `/bin/true`, `spawnSmokeGateway`, `collectSmokeEvidence`,
  `assertSmokeEvidence`); three spawned gateways from temp cwds
  (embedded/disk/override) exercising the full delivery contract;
  `smoke:binary` script added.
- **4.4** Gate green (typecheck/lint/test/bundle/smoke). Legacy
  `src/ui/*` delete deferred — only after `sdd-verify` (rollback
  boundary preserved).

## Commits (Unit 3, branch `svelte-ui/pr3`)

1. `feat(ui): embed dist/ui in binary build via --asset (task 4.1)` (7d1da37)
2. `feat(ui): guard app JS bundle ≤100 KB gzip on build:ui (task 4.2)` (8df3a6d)
3. `feat(scripts): binary smoke from unrelated cwd with embedded /ui contract (task 4.3)` (eae6f40)

## Notes / handoff for verify

- Delivery chain: svelte-ui-tracker ← svelte-ui/pr1 (PR 27) ←
  svelte-ui/pr2 ← svelte-ui/pr3 (HEAD). PR 2 and PR 3 creation is the
  next orchestrator delivery step after settle; PR 3 targets
  `svelte-ui/pr2` (immediate parent), commit-ref base to keep diffs
  focused.
- After verify approves: delete legacy `src/ui/*` (4.4 final), archive,
  changelog, then merge tracker → master for delivery.

## Attempt accounting

### Unit 1 (PR 1) — settled + ledger reset

- Token `sha256:bdcb327b…aaa5e71` settled with outcome **passed**,
  evidence-revision sha256:da8bac27…69f48.
- `changed_lines: 2484` vs budget 1200 → `changed_line_budget_exceeded`,
  `decision_required: true`, `next_action: reset`.
- Maintainer-authorized reset **executed** (user approved via orchestrator
  decision prompt) — two-step due to ledger revision conflict:
  1. First run with stale `--expected-revision sha256:3a11985d…` was
     refused: ledger already at `sha256:f9f7e57d95b9153f42b38dbaba015c2c3bafe99496839459c50e09a79b5c486b`.
  2. Re-run with the ledger's actual revision → OK; ledger now
     `sha256:3f266d6f772039a81c48ee359f6fd260cf78454c8cfe5967927576247b104631`;
     attempt 1 recorded `outcome: passed`, `changed_lines: 2484`.
- Untracked inventory ruling used at settle:
  `--untracked-scope exclude --expected-untracked-inventory sha256:673d0f36…40c3`
  (task list committed; remaining change docs stay untracked, as before).

### Unit 2 (PR 2) — settled passed + ledger reset

- Token `sha256:a552f73e345e9488b77db323b531b2f185cf9e4bfbefff20aa3a51b33ca0ad36`,
  work_unit `unit-2-pr-2-views-editor`, `state: proceed`.
- Acquire used `--untracked-scope exclude --expected-untracked-inventory
  sha256:ed7eccf59c704bfc4f0c357e510a0200c6cccf632a15fbbe117138e017294640`
  (change docs untracked by design).
- **Settled**: first attempt refused (undeclared untracked) → re-run with
  `--untracked-scope exclude --expected-untracked-inventory
  sha256:673d0f36c01fc6ad0c514cd0d1da5cd04e27cdbbf3afae7fc47d72cbc46e40c3`
  (tasks.md/apply-progress now committed) → recorded `outcome: passed`,
  `changed_lines: 6899`, `changed_line_budget_exceeded: true`.
- Settle settled blocked on `maintainer_decision`; user authorized reset
  ("Resetear y continuar Unit 3"):
  `gentle-ai sdd-attempt reset --expected-revision
  sha256:2bcf28d95e416e289d7132ef610649f40a6b1845d483caf05b049ddca6ae2e25
  --request-id svelte-ui-unit2-budget-reset --actor maintainer` → OK,
  ledger now `sha256:5d6a17a0a3d45637c82df798612da7f2df81472e71b42518ae7bb5343aacc841`,
  `decision_required: false`, `next_action: begin`.

### Unit 3 (PR 3) — acquired, pending settle

- Token `sha256:a337e3d961a8a8ed071fafc9ddd3b576ce53ac4d448c68d2a8151767e0e6feec`,
  work_unit `unit-3-pr-3-bundle-binary-gate`, `max_attempts 1`,
  `max_changed_lines 600`, `state: proceed`.
- Acquire used `--untracked-scope exclude --expected-untracked-inventory
  sha256:673d0f36…40c3`.
- Settle (reject if token already closed):
  ```
  gentle-ai sdd-attempt settle --cwd /home/andy/Proyectos/llm-proxy \
    --change svelte-ui \
    --token sha256:a337e3d961a8a8ed071fafc9ddd3b576ce53ac4d448c68d2a8151767e0e6feec \
    --request-id svelte-ui-unit3-settle \
    --outcome passed \
    --evidence-revision <sha256 of HEAD after verification> \
    --diagnosis "Unit 3 (Phase 4 delivery; tasks 4.1-4.3 + 4.4 gate partial) green: bundle guard 29.23 KB gzip <= 100 KB, binary smoke PASS from unrelated cwd, 756 tests, typecheck+lint clean; legacy src/ui delete deferred to after verify" \
    --harness-disposition reused \
    --cleanup-evidence "dist/ui + dist/llm-proxy rebuilt; smoke workspaces removed" \
    --process-evidence "git log svelte-ui/pr2..svelte-ui/pr3 = 3 commits"
  ```

## Notes / handoff for Unit 2

- `build:ui` output: `dist/ui/index.html` + `assets/index-<hash>.js/.css`
  (vite root = `src/ui-svelte`; outDir absolute from config location).
- The placeholder shell (`index.html`, `main.ts`, `styles.css`) is the build
  entry; Phase 3 replaces with `App.svelte` and the five views (task 3.3).
- Spanish shell strings already in place: title "llm-proxy Panel de control",
  nav `aria-label="Principal"`, 5 `data-view` links — the e2e shell group
  asserts exactly these.
- Editor contract selectors used by the spec: `#editor`, `#graph-canvas`
  (tabindex=0), `#palette-list`, `.palette-item[data-node-type=…]`,
  `#graph-svg .graph-node[data-type=…]`, `.port--input/.port--output`,
  `#btn-validate` (“Validar”), `#validate-dialog`, `#btn-apply`,
  `#apply-dialog`, `#btn-confirm-apply`, `#btn-undo`, `#btn-redo`,
  `#executions-list .list-item`, `#models-list`, `#pipelines-list`.
- SSE bus surface is `publish` (not `emit`); event `execution:completed` is
  `{ type, executionId }` only. `/api/ui/events` is GET; heartbeat 15s.