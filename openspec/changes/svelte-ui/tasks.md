# Tasks: Svelte UI Re-platform

## Review Workload Forecast

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

~3,200–4,200 lines, mostly fresh UI; serving/rewrites risk-critical.

### Work Units

- **Unit 1** — PR 1, toolchain + TS port + serving + tests. Test: `bun test src/dashboard`. Harness: `UI_DIR=dist/ui bun run e2e-server`. Rollback: revert serving commit, `UI_DIR` toggles.
- **Unit 2** — PR 2 (base PR1), views/components/editor/stores. Test: `bun test src/ui-svelte`. Harness: `bun run test:e2e`. Rollback: `src/ui-svelte/**` only; old `src/ui` kept.
- **Unit 3** — PR 3 (base PR2), bundle + binary smoke + gate. Test: `bun run typecheck && bun run lint && bun test`. Harness: `build:ui && build:binary` from unrelated cwd. Rollback: drop `--asset` → disk fallback.

## Phase 1: Foundation

- [x] 1.1 `package.json` (edit): devDeps `svelte@5`/`vite`/`@sveltejs/vite-plugin-svelte`/`@testing-library/svelte`/`jsdom`/`@testing-library/jest-dom`; `build:ui` script.
- [x] 1.2 Create `src/ui-svelte/{tsconfig.json,vite.config.ts}`: ESM `.js` resolution/strict TS/`outDir: dist/ui`/hashed assets.
- [x] 1.3 RED `src/ui-svelte/lib/graph-model.test.ts`: port 37-case oracle from `src/ui/graph-model.test.js` (read-only).
- [x] 1.4 GREEN `src/ui-svelte/lib/graph-model.ts`: 1:1 typed port (layout, connect/guard/self-edge, loop, condition, params, payload); suite passes.
- [x] 1.5 MINOR-A: `eslint.config.js` rule banning svelte imports in `src/ui-svelte/lib/*`; `lib/purity.test.ts` boundary test.
- [x] 1.6 `src/server.ts` (edit) MAJOR-1+2: `resolveUiAsset` per-segment reject (`..`, leading-dot, `\`, absolute, empty) → null no-fallback, then forward-slash concat (never `path.join`); `contentTypeFor` += woff/woff2/map/wasm.
- [x] 1.7 `src/server.ts` (edit) `/ui` (read-only) block: unknown `/ui/*` (read-only) GET → `index.html` (read-only) fallback (never `/api/*` (read-only)); missing build → "run build:ui" 404.

## Phase 2: Serving Tests + Rewrites

- [x] 2.1 Rewrite `src/dashboard/static-spa.test.ts`: traversal kept; subdir + fallback + per-extension content-type matrix; green against 1.6.
- [x] 2.2 Rewrite `src/dashboard/e2e-smoke.test.ts`: compiled `dist/ui` landmarks/a11y + hashed `assets/*`; drop `app.js`/`graph-model.js` string checks.
- [x] 2.3 `src/index.ts` (edit): `uiDir` → embedded `import.meta.dir`/`Bun.file`, `./dist/ui` source; `UI_DIR` wins; missing build → 404.
- [x] 2.4 Rewrite `e2e/e2e-server.ts` + `e2e/dashboard.spec.ts`: `UI_DIR`→`dist/ui`; Spanish 5-view, drag/keys/connect, undo/redo, validate/apply, SSE live.

## Phase 3: UI Layer

- [x] 3.1 MINOR-B: `stores/*.store.ts` factories (fresh per test, reset/unmount) + consolidated throttled refresh; `services/rest-service.ts`.
- [x] 3.2 `services/sse-service.ts`: all 8 events incl. `execution:failed`, reconnect, unsub in teardown; `services/trace-service.ts` debug/verbose, presentation-only.
- [x] 3.3 `main.ts`, `App.svelte`, shell/nav; theme tokens verbatim; 5 views; Rioplatense copy; AA/ARIA/native `<dialog>`/reduced-motion.
- [x] 3.4 Editor: declarative SVG, rAF batch, DPR-aware, palette drag/click, keys 1–6/zoom 0.2–3×/pan/select/delete, 24 px connect + self-edge reject, loops/carousel/flow animation.
- [x] 3.5 RED `history.ts`: bounded Command undo/redo (~100) over add/move/delete/connect/reorder.
- [x] 3.6 Ejecuciones list-level + SSE live + `execution:failed` + step-retry wiring; Modelos lifecycle panel (TTL/VRAM) via config/apply + `models:changed`.
- [x] 3.7 Component tests (Testing Library + jsdom): 5 views, editor, stores, history, sse.

## Phase 4: Delivery + Gate

- [x] 4.1 `package.json` (edit): `build:binary` + `--asset dist/ui`.
- [x] 4.2 Bundle guard: gzip prod app JS ≤ 100 KB, recorded via `scripts/measure-bundle.ts`.
- [x] 4.3 MAJOR-3 `scripts/binary-smoke.ts`: build from unrelated cwd; assert embedded `/ui` (read-only) + `/ui/assets/*` (read-only), disk fallback, `UI_DIR` override.
- [ ] 4.4 Gate: typecheck + lint + `bun test` green; delete `src/ui/*` only after verify.
  - Gate part DONE (1.7–2.3 green; 756 tests; bundle guard; smoke PASS). Delete of
    legacy `src/ui/*` intentionally deferred — runs only after `sdd-verify` confirms
    the svelte-ui implementation. Rollback boundary stays until verify.

Ordering: P1 → P2 (resolver/build); 1.3–1.4 → 3.x; P4 needs P1–3. RED before GREEN where marked.