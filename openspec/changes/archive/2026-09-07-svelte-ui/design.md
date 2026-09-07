# Design: Svelte UI Re-platform

## Technical Approach

Re-platform the static `/ui` SPA as a **Svelte 5 + Vite build-only** CSR app compiled to `dist/ui` (disk-served dev; `--asset`-embedded release). Parity via a **1:1 framework-free TS port of `graph-model.js`** (37-case suite = oracle); improvements layered on top. Only backend change: subdirectory-safe `resolveUiAsset` + `/ui/*`-scoped fallback. Consumes the `dashboard-ui` delta unchanged.

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Toolchain | Svelte 5 + `vite` + `@sveltejs/vite-plugin-svelte` (devDeps, build-only) | Explore-validated: component sourcemaps, strict `lang="ts"`, hashed `assets/*`. No SvelteKit (SSR/router conflicts hash-nav), no `bun-plugin-svelte` (0.0.x, no maps). |
| Layout | `src/ui-svelte/{main.ts,App.svelte,views/,components/,stores/,services/,lib/}` | Modular convention; `lib/` = TS graph-model port + pure helpers. **Framework-freedom invariant**: lint rule bans `svelte`/`@sveltejs` imports in `lib/`. |
| State | Svelte 5 runes stores created via **injectable store factories**, not module singletons | Fresh stores per test via explicit reset/unmount; no hidden cross-test state; mutations delegate to pure `graph-model.ts`. |
| SSE | Single `sse-service.ts` (all 8 events) + the 5 interval refreshes in one store layer, throttle/batch | The "no jank under SSE load" invariant; observer with explicit unsub in `onDestroy`. |
| Editor | Declarative Svelte SVG (`{#each}` nodes/edges), rAF-batched store updates, DPR-aware canvas | Replaces full-tree imperative `render()`; Svelte diffs per-node/edge; geometry stays pure (unit-testable). |
| Undo/redo | Bounded history (Command pattern) over pure reducer mutations (add/move/delete/connect/reorder) | Each op = {apply, undo} snapshots; cap depth (~100). |

## Data Flow

```
Browser ──GET /ui + assets──▶ fetch handler (resolveUiAsset, /ui/* fallback)
   │                                             │ uiDir → dist/ui | embedded
   ▼                                             ▼
stores ◀── rest-service.ts (fetch /api/ui/*) ──┘
   ▲        │
   │        └──▶ sse-service.ts ◀── EventSource (8 events) ──▶ throttled refresh
views (Editor|Pipelines|Modelos|Ejecuciones|Agentes) ◀── components
    └──▶ trace-service.ts (SSE/store/fetch/editor log + debug mode)
```

Mutations: `component → store action → pure graph-model.ts` → re-render; geometry never computed in components.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/ui/*` | Delete (kept until verified) | Replaced; `graph-model.js` → TS port. |
| `src/ui-svelte/**` | Create | `main.ts`, `App.svelte`, 5 views, editor components, shared components, `lib/`, `services/`, `stores/`. |
| `src/ui-svelte/{tsconfig.json,vite.config.ts}` | Create | Pin ESM `.js`-extension resolution + strict TS for the UI layer (does not inherit); build-only `outDir: dist/ui`, hashed assets. |
| `src/server.ts` | Modify | `resolveUiAsset`: sanitize each segment THEN simple forward-slash concat (joinUIPath semantics — **never `path.join`**); any bad segment → null (non-200, NO fallback) before any join. `/ui` block: benign missing → `index.html`; never intercepts `/api/*`. `contentTypeFor` extended (see Interfaces). |
| `src/index.ts` | Modify | `uiDir` default → compiled dir (`import.meta.dir` + `Bun.file` embedded; `./dist/ui` from source); `UI_DIR` overrides; missing build → "run build:ui" 404. |
| `src/dashboard/static-spa.test.ts` | Modify | Traversal assertions kept; subdir+fallback contract added. |
| `src/dashboard/e2e-smoke.test.ts` | Rewrite | Assert `dist/ui` landmarks/a11y + hashed assets; drop string checks on old files. |
| `e2e/e2e-server.ts`, `e2e/dashboard.spec.ts` | Rewrite | `UI_DIR` → `dist/ui`; Spanish 5-view expectations. |
| `package.json` | Modify | devDeps (svelte/vite/plugin/testing-library); `build:ui`, `build:binary` + `--asset dist/ui`. |
| `src/ui-svelte/**/*.test.ts` | Create | Port oracle, geometry, history, sse/service tests. |

## Interfaces / Contracts

```ts
// lib/graph-model.ts — pure TS, 1:1 port (suite = oracle); framework-free
// INVARIANT (MINOR-A): no `svelte`/`@sveltejs` imports (lint-guarded).
createNode(type,id); layoutGraph(nodes,edges); connectNodes(edges,from,to,guard);
deleteNode(nodes,edges,id); moveNode(nodes,id,x,y); socketPositions(p); // 24px hit
bezierEdge; stackLoopMembers; buildCondition/describeCondition; paramsToRows; ...

// server.ts — resolveUiAsset ORDERING INVARIANT (MAJOR-1)
// 1. Split pathname on "/"; reject → null (NO fallback) if ANY segment is
//    empty, ".", "..", starts with ".", contains "\", or is absolute.
// 2. ONLY THEN join the sanitized segments with simple "/" concat — joinUIPath
//    semantics preserved. Never path.join: it re-normalizes ../ upward and
//    would defeat the sanitizer.
// contentTypeFor (MAJOR-2) covers: html, js, css, json, svg, png, ico, woff,
//   woff2, map, wasm; default octet-stream. Vite emits js/css/map/woff2;
//   fonts/icons add woff; wasm reserved. A serving test asserts each
//   extension serves its mapped type. (spec: "correct content types")
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | graph-model.ts port (37), history, sse throttle, trace, lib/ purity | `bun:test`; port oracle + import-boundary test. |
| Component | 5 views, editor, stores (fresh via factory per test) | Testing Library + jsdom. |
| Serving | subdir resolve, traversal reject, `/ui/*` fallback, `/api/*` untouched, content-type per full extension set | rewritten `static-spa.test.ts`. |
| E2E | Spanish nav, drag/keys/connect, undo/redo, validate/apply, SSE live | Playwright vs `e2e-server` (`UI_DIR`→`dist/ui`). |
| Binary smoke | `build:binary --asset dist/ui` from an UNRELATED cwd; assert embedded `/ui` + `/ui/assets/*`, disk fallback, `UI_DIR` override | verify-phase script — `bun test` can't exercise `import.meta.dir` embedding (MAJOR-3). |
| Bundle | prod app JS gzip ≤ 100 KB | `build:ui` → gzip measure (recorded). |
| Gate | tsc/eslint/bun test | typecheck + lint + `bun test` green. |

## Threat Matrix

N/A — no shell/subprocess/VCS-PR/executable-classification/process-integration boundary. Static serving is pure path resolution; traversal rejection is covered by spec scenarios + rewritten tests.

## Migration / Rollout

Dual-path boot via `UI_DIR`; old `src/ui` kept until verified. Binary embeds `dist/ui`; non-`--asset` disk-falls back. Sequence: `build:ui` → tests → serve → verify → archive.

## UI Decisions

- **Stack/theme**: Svelte 5; carry `dashboard-ui` tokens verbatim (`#0d1117`/`#58a6ff`, `--status-*`, JetBrains Mono 14px/1.6, `:focus-visible`) — no redesign.
- **A11y**: WCAG AA contrast, ARIA landmarks, keyboard operability, native `<dialog>`, SVG icons.
- **Copy**: Rioplatense voseo ("Validar", "Principal").
- **Interaction**: ≥44px targets, 150 ms transitions, `prefers-reduced-motion` gates animation.
- **Failure UX**: bounded retry-able error surfaces, loading feedback, trace panel; debug shows only payload-present data.

## Open Questions

None.

## Risks

| Risk | L | Mitigation |
|---|---|---|
| Editor parity regression | Med | 1:1 oracle port + verify checklist + rewritten e2e. |
| Serving change near auth boundary | Med | Fallback `/ui/*`-only; traversal tests kept green. |
| 100 KB gzip / SSE jank | Low/Med | Measured build; single consolidated SSE store w/ throttle. |