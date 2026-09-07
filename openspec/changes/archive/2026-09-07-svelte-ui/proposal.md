# Proposal: Svelte UI Re-platform

## Intent

Re-platform the static `/ui` SPA (`src/ui/`: app.js 2,325L, styles.css 1,523L, graph-model.js 569L) to a compiled Svelte 5 CSR SPA served by the Bun backend, so the approved improvements don't grow the 2,325-line imperative controller.

## Scope

### In Scope
- Svelte 5 + Vite build-only (`src/ui-svelte/`), devDeps-only
- Parity: 5 views + editor set; improvements
- Serving + delivery: subdirs + `/ui/*` fallback; `uiDir` → `dist/ui`; `--asset`; `UI_DIR` kept
- Tests: graph-model TS port (1:1), component tests, rewritten static-spa/e2e-smoke/dashboard.spec; dashboard-ui delta

### Out of Scope
- REST/SSE changes — metrics list-level only (API sends no steps); step-retry wiring in-scope
- SSR/router/i18n/redesign; runtime deps beyond Svelte

## Capabilities

### New Capabilities
None

### Modified Capabilities
- `dashboard-ui`: supersede "Static SPA serving" + "Vanilla frontend"; theme + a11y carry over

## Approach

- **Toolchain**: Svelte 5 + Vite build-only (sourcemaps, TS); SvelteKit/bun-plugin-svelte rejected
- **Editor**: declarative Svelte SVG; geometry pure in TS `graph-model` (ported 1:1); rAF-batched
- **Serving**: `resolveUiAsset` subdirs allowed (traversal preserved); unknown `/ui/*` → `index.html`, never `/api/*`
- **Delivery**: `--compile --asset dist/ui` via `import.meta.dir`; dev serves build from disk
- **SSE**: all 8 events incl. `execution:failed`; throttled refreshes
- **Verify**: bun test/tsc/eslint; Testing Library; rewritten e2e; ≤ 100 KB gzip

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/ui/*` | Removed | Replaced (kept until verified) |
| `src/ui-svelte/` | New | Views, components, stores, svg |
| `src/server.ts`, `src/index.ts` | Modified | Subdirs + fallback; `uiDir`; asset resolution |
| `src/dashboard/*.test.ts` (static-spa, e2e-smoke) | Modified | Rewritten; traversal kept |
| `e2e/dashboard.spec.ts`, `e2e/e2e-server.ts` | Modified | Rewritten; `UI_DIR` → output |
| `package.json`, `openspec/specs/dashboard-ui/spec.md` | Modified | Scripts+devDeps; delta at archive |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Editor parity regression | Med | Verify checklist; port 1:1 |
| Serving change on auth-adjacent path | Med | Fallback `/ui/*`-only; traversal kept |
| 100 KB gzip / SSE jank | Low/Med | Measured; single store layer |

## Rollback Plan

- `UI_DIR` switches old vs new at boot; old `src/ui/` kept until verified
- Revert serving commit → single-segment restored
- Rebuild binary sans `--asset` → disk-served fallback

## Dependencies

- devDeps svelte/vite/vite-plugin-svelte/Testing Library + Bun `--compile --asset`

## Success Criteria

- [ ] AC1–2 `/ui` serves Svelte SPA; parity (5 views + editor set)
- [ ] AC3 Improvements: undo/redo, connections, metrics (+ retry, `execution:failed`), backend panel, trace, debug
- [ ] AC4–5 Self-contained; ≤ 100 KB gzip measured
- [ ] AC6–7 REST + SSE payloads identical; bun test/tsc/eslint/e2e green (1:1 TS port)
- [ ] AC8–10 ARIA/WCAG AA, Rioplatense copy; scripts + structure; no runtime deps beyond Svelte