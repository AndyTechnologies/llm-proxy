# Exploration: ui-dark-theme

Change: `ui-dark-theme` — Adapt the dashboard SPA to the proposed "technical dark" design document (12-section guide). This exploration validates each guide section against the real code and flags what applies, what does not, and what the guide omits.

## Current State

The dashboard is a **vanilla static SPA** (no build step) served from `src/ui/` at `/ui/*` via `resolveUiAsset`/`contentTypeFor` in `src/server.ts`:

- `src/ui/index.html` — HTML shell (lang="es"), header with nav tabs + conn-status, editor grid (palette / canvas-wrap / inspector), pipelines/models/executions/agents views, dialogs.
- `src/ui/styles.css` (1132 lines) — ALL styling. **The UI is already a dark theme**, self-described in the file header as "Dark Blue direction": near-black backgrounds, steel-blue accents, editorial grain overlay, WCAG-AA-checked text pairs. Tokens live on `:root` (lines 8–44); 34 unique tokens are referenced 218 times.
- `src/ui/app.js` (1674 lines) — frontend logic. **Zero hardcoded colors**; all theming flows through CSS classes/variables.
- `src/ui/graph-model.js` + `graph-model.test.js` — pure graph model, no colors.

Current existing tokens (names differ from the guide): `--bg-base #090b10`, `--bg-surface #111419`, `--bg-card #181c22`, `--bg-hover #1f242c`, `--text #e8ecf1`, `--text-muted #8a94a3`, `--text-faint #5c6675`, `--border rgba(200,210,225,.1)`, `--border-strong rgba(200,210,225,.18)`, `--accent #4a90d9`, `--accent-bright #6aabe8`, `--accent-soft`, `--accent-glow`, `--accent-on`, `--success #4cc38a`, `--danger #e05b4f`, `--focus #6aabe8`, socket tokens, `--radius 8px`, space tokens 4/8/12/16/24, `--font Inter` (16px), `--mono JetBrains Mono`. Notable: `--accent-2 #9d80e9` (loop/purple) is USED via fallback `var(--accent-2, #9d80e9)` but never declared on `:root`. Node type fills are hardcoded hex in CSS (`#13211c` llm_call, `#201a10` condition, `#1a1830` loop, `#121c2a` pipeline).

Structure mapping (guide section → reality):

| Guide | Reality |
|---|---|
| 1 Palette | Tokens exist but with different names AND different hue family (steel-blue dark-luxury vs guide's GitHub-dark neutrals + `#58a6ff`). No token for loop-purple or sockets in the guide. |
| 2 Typography | Current body is **Inter sans 16px/1.5**; mono only for labels/SVG. Guide wants **global mono** JetBrains Mono 14px/1.6 — the single boldest visual change. |
| 3 Topbar/tabs | Exists as `.app-header` (sticky, blur, grain) + `.nav-link` tabs. Tab names match the guide EXACTLY (Editor, Pipelines, Modelos, Ejecuciones, Agentes). Guide = compaction (32px height, 16px tab padding, min-width 60px). Active tab already accent-bg. |
| 4 Sidebar | Exists as `.palette` (Paleta de nodos), **already 220px** (matches guide). Section titles already 0.75rem uppercase w/ letter-spacing. Preset dots already exist (`::before` 8px, `--success`/`--accent`). Gap: 6px 8px / radius 6 / hover `--bg-tab-inactive` values differ. Global scrollbar styling is NEW. |
| 5 Center panel | `.canvas-toolbar` + `.btn`/`.btn-primary` ("Aplicar" is already primary) + `#pipeline-name` `.text-input` exist. Radius 8 → 6, padding 8/12 → matches mostly. |
| 6 Canvas | `.graph-canvas` grid already 24px cells (guide allows 20–24) but uses `--border` (0.1 alpha) — guide wants 0.3 alpha `--border-subtle`. `.canvas-empty` exists in mono. Node radius 8 → 4 per guide. Per-type tinted fills are an existing pattern the guide ignores. |
| 7 Inspector | `.inspector` at 280px, bg-surface, radius 8, padding 16 (already 16px = guide target), `.panel-title` present; guide wants weight 600 vs current 700. |
| 8 Scrollbars | **NEW** — no global scrollbar styling today (only `.node-switcher` hides its scrollbar). Additive, low risk. |
| 9 Transitions | Already 0.12–0.15s ease, no springs, scattered. Guide wants uniform 150ms on color props — mostly true already; a small unification pass. |
| 10 Density | **Already at the guide's targets**: panel padding 16px (`--space-4`), button gap 8px (`--space-2`), sidebar section margin 12px (`--space-3`). Essentially nothing to do. |
| 11 Focus | Exists: `:focus-visible` outline 3px `--focus` offset 2px. Guide wants 2px/1px. Trivial. |
| 12 Priorities | Process ordering only. |

Guide material that does NOT apply cleanly (structural mismatches):

- **Node switcher carousel** (`.node-switcher` chips strip above canvas) — absent from the guide; must keep styled.
- **Loop/condition visuals** — `--accent-2 #9d80e9` purple system (containers, badges, flow-past states, AST builder) has NO counterpart in the guide palette; per-node-type tinted fills likewise.
- **Socket semantics** — `--socket-in` green / `--socket-out` orange, branch true/false green/red coloring is requested UX preserved by an existing spec scenario; the guide palette only offers `--status-success #3fb950` / `--status-warning #f85149` (red-ish) as rough mappings. Must map deliberately, not blindly.
- **Grain overlay + backdrop blur** — `body::before` fractal-noise grain (0.04) and header blur are the "dark luxury" signature; the guide (GitHub-dark technical) implies removing them but never says so. Needs an explicit decision.
- **Other views** (pipelines/models/executions/agents lists, `.list-item`, `.chip` status pills, dialogs, agents config) — restyle implicitly through shared tokens; the guide's 12 sections never cover them.
- **conn-status** — guide wants "Reconectando…" as `--status-warning` badge; app.js already emits state `disconnected` + text "Reconectando…" (currently colored `--danger`). Pure token mapping.
- **"Sidebar model dots"** in the guide map to the palette's preset dots, but live model status only partially — the models list is its own view, not the sidebar.

## Affected Areas

- `src/ui/styles.css` — the entire change: re-tokenization, compaction, scrollbars, focus, transitions. ~1100 lines, 34 tokens in play.
- `src/ui/index.html` — likely minimal: topbar padding/class tweaks, possibly the conn-status badge markup. Must NOT remove `role="banner"`, `id="graph-canvas"`, `<dialog>`, `id="palette"` (e2e assertions).
- `src/ui/app.js` — only if class/structure names change (e.g. conn-status badge). No color literals today, so no color work here.
- `openspec/specs/dashboard-ui/spec.md` — needs a delta ADDED requirement (e.g. "Dark technical theme") if the spec phase adds one; the WCAG AA requirement (lines 33–46) constrains the palette but needs no modification unless a scenario is added.

## Impact

The change MODIFIES existing visual behavior (not greenfield), so regressive impact applies:

- **`src/dashboard/e2e-smoke.test.ts` (REGRESSION NET)** — asserts served `styles.css` contains the literal substrings `:focus-visible` and `aria-current`, and served `index.html` contains `role="banner"`, `id="graph-canvas"`, `<dialog`, `id="palette"`; `app.js` contains `EventSource`, `/api/ui/events`, `/api/ui/pipelines/`, `/api/ui/apply`, `createElementNS`, `graph-model.js`. Any refactor MUST preserve those selectors and ids verbatim. Risk: **medium-high if the CSS is rewritten wholesale** (a rename that drops `:focus-visible` or the `.nav-link[aria-current]` selector breaks the suite); low if tokens/values only change.
- **`src/dashboard/static-spa.test.ts`** — fixture-driven (temp dir, dummy files); only MIME/types/traversal asserted. Unaffected.
- **`src/dashboard/router.test.ts`, `server-dispatch.test.ts`, `service.test.ts`, `events.test.ts`, `execution-tracker.test.ts`, `agent-config.test.ts`, `metrics/retry`** — JSON/API contracts, no UI content. Unaffected.
- **`src/ui/graph-model.test.js`** — pure model. Unaffected.
- **WCAG AA requirement (dashboard-ui spec)** — the guide palette passes contrast on paper (`--text-primary #c9d1d9` on `#0d1117` ≈ 10.9:1; `--text-muted #8b949e` ≈ 6.6:1; `--text-on-accent #0d1117` on `#58a6ff` ≈ 4.6:1 — borderline over 4.5). The global-mono 14px body is smaller than the current 16px; contrast is unaffected but readability/size should be considered (guide's own UI design gate prefers base 16px).
- No snapshot/golden tests on CSS or HTML content beyond the e2e substrings. No browser-automation tests exist.

## Approaches

1. **Token-value remap, keep all names** — Change `:root` token VALUES to the guide's colors (`--bg-base→#0d1117`, `--bg-surface→#161b22`, `--bg-card→#1c2128`, `--accent→#58a6ff`, `--text→#c9d1d9`, etc.), then targeted value/compaction tweaks (focus 2px/1px, node radius 4, topbar compaction, scrollbar additions, mono body font swap).
   - Pros: smallest diff; every one of the 218 `var()` references keeps working; zero risk to the e2e substrings; fully reversible per-token.
   - Cons: token names stay diverged from the guide document's names (audit/reading mismatch); per-component extras (sockets, loop purple, node tints, grain) still need individual decisions.
   - Effort: Low–Medium.

2. **Full re-tokenization to the guide's names + full component restyle** — Rename all 34 tokens to the guide's names (`--bg-primary`, `--bg-sidebar`, `--bg-panel`, `--bg-tab-active`, `--text-primary`, ... `--status-*`, `--border-subtle`, `--focus-ring`), rewrite component rules to the guide's exact specs (32px topbar, radius 6 everywhere, 14px mono base, 10px scrollbars, 150ms transitions).
   - Pros: design system matches the guide document 1:1; clean future surface for theming; the spec can cite real token names.
   - Cons: largest diff — realistically 600–900 changed lines, likely over the 800-line review budget → needs chaining; no compiler catches a missed `var(--...)` rename (CSS); higher chance of accidentally dropping an e2e substring (`:focus-visible`/`aria-current`).
   - Effort: High.

3. **Hybrid: adopt guide VALUES via a renamed-but-mapped token layer, keep semantic structure** — Introduce the guide's token names as the canonical set but keep semantic alias grouping (e.g. `--bg-panel` maps to the existing panel/surface roles; `--status-*` replaces `--success`/`--danger`/`--accent`/`--accent-2`), plus the compaction items; keep `:focus-visible`/`aria-current` selectors intact.
   - Pros: doc fidelity without blind renaming; semantic grouping survives (socket green/red, loop purple get explicit decisions); reviewable in two slices (tokens → components).
   - Cons: more churn than approach 1; needs a token-mapping table in the design to stay auditable.
   - Effort: Medium–High.

## Recommendation

**Approach 1 (token-value remap + targeted compaction), with an explicit decision gate on the guide's two open design-direction questions.** The guide is a guide, and the strongest finding is that the current UI **already is** a dark theme and already sits at the guide's density targets (sections 9–10 are essentially no-ops). The real delta is: hue shift toward GitHub-dark neutrals + `#58a6ff` accent, **global mono typography (the boldest change — confirm the user actually wants the whole UI in mono at 14px, or scope mono to chrome/labels)**, topbar/mode compaction, radius 4–6, scrollbars, focus 2px/1px.

The orchestrator should ask the user, before propose:
1. **Mono global vs. mono-for-chrome** — full-JetBrains-Mono at 14px is a big readability change over Inter 16px.
2. **Grain overlay + header blur** — remove (pure GitHub-dark technical) or keep (hybrid)?
3. **Loop purple `--accent-2 #9d80e9` and socket green/red** — keep as-is, or fold into the guide's `--status-*` tokens?

Keep token names intact (or rename only if the user insists); keep the `:focus-visible` and `aria-current` selectors byte-stable; keep `graph-canvas`, `palette`, `dialog`, `role="banner"` ids/roles in index.html.

## Risks

- **e2e-smoke.css substrings** (`:focus-visible`, `aria-current`) — highest regression risk; mitigated by approach 1.
- **Unchecked CSS var rename** — no compiler/linter catches a typo'd `var(--...)`; a full rename (approach 2) multiplies this risk.
- **Contrast regression at the edges** — `--text-on-accent` `#0d1117` on `#58a6ff` ≈ 4.6:1 is close to the 4.5:1 WCAG AA floor; verify rather than assume. Muted `--text-muted #6e7681` on `#0d1117` ≈ 4.7:1 also near the floor.
- **Review budget** — a full restyle likely exceeds 800 authored lines; plan chained slices (tokens → components) if the diff balloons.
- **Spanish UI strings untouched** — no copy changes needed; the theme is visual only.

## Ready for Proposal

**Yes** — the guide is implementable as-is via CSS-only changes, and the approved RFC (if any) does not conflict with any existing contract. Tell the user: the dashboard is already dark; the change is a hue/token shift toward GitHub-dark technical + mono typography + compaction + polish (scrollbars/focus/transitions), and three decisions (mono global or chrome-only, grain removal, loop/socket accent mapping) should be settled before proposal. Also flag that a full token rename could exceed the 800-line review budget and may need chaining.