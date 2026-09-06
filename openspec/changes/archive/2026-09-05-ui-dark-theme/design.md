# Design: Dark Technical Theme for Dashboard UI

## Technical Approach

Follow proposal Approach 1 and the `dashboard-ui` delta spec ("Dark technical theme"): remap the 34 `:root` token **values** to the GitHub-dark palette (names unchanged → all 218 `var()` references keep resolving), add `--status-success`/`--status-danger` and declare `--accent-2`, then targeted value edits (global mono, flat texture, 32px topbar, radius, focus 2px/1px, scrollbars, 150ms) plus a legacy-literal purge (loop `#9d80e9`, sockets `#4cc38a`/`#e05b4f`, `rgba(157,128,233,…)`). CSS-only; `index.html` markup and `app.js` untouched (spec: markup SHALL remain unchanged). Estimated diff ≈ 200–260 authored lines ≪ 800-line single-PR budget.

## Architecture Decisions

### D1 Token remap + status alias chain

| Option | Tradeoff | Decision |
|---|---|---|
| Full rename to guide names (A2) | Doc fidelity; 600–900 lines > budget; CSS var rename unchecked | Rejected |
| Hybrid alias layer (A3) | Audit-friendly; more churn than A1 | Rejected |
| Value remap, names kept (A1) | Smallest diff; every var() keeps resolving | **Chosen** |

New chain: `--status-success: #3fb950`, `--status-danger: #f85149`; `--success: var(--status-success)`, `--danger: var(--status-danger)`; `--accent-2: var(--status-success)` (declared on `:root` — it was phantom, fallback-only). Spec "resolve through `--status-*`" holds via the chain.

### D2 Loop purple → status success

| Option | Tradeoff | Decision |
|---|---|---|
| Keep `#9d80e9` | Violates spec (legacy fill must not appear) | Rejected |
| Loop → `--status-danger` | Red reads as error; collides with failed chips/out-sockets | Rejected |
| Loop → `--status-success` `#3fb950` | Green = "active construct"; value already in palette | **Chosen** |

### D3 Sockets → status family

`socket-in`/branch-true → success; `socket-out`/branch-false → danger; hovers `#56d364`/`#ff7b72` via `--socket-in-hover`/`--socket-out-hover`. Branch true/false UX semantics preserved.

### D4 Global mono

`--font` → JetBrains Mono stack (same family as `--mono`); body 14px/1.6. All rem sizes auto-scale (0.95rem→13.3px … 0.72rem→10.1px); SVG text 9–12px already mono, untouched.

### D5 Flat texture

Delete `body::before` grain block + `--grain-opacity` token; remove header `backdrop-filter` → solid `var(--bg-base)`; drop glow shadows (nav active, `btn-primary`, `is-valid`), keep drop shadows.

### D6 Compaction + radius

Header padding `2px 16px` (measure ≈32px total); nav-link padding `var(--space-1) 16px`; **`editor-layout` height `calc(100vh - 88px)` → `calc(100vh - 57px)`** (32 header + 1 border + 24 main padding — must track header height); `--radius: 6px`; node-box `rx: 4`.

### D7 Regression-critical edits

`:focus-visible` selector list **byte-stable**; only values 3px/2px → 2px/1px. `[aria-current="true"]` selector untouched. Canvas grid: `var(--border)` → `var(--border-strong)` inside `.graph-canvas` gradients (visible grid, no new token).

### D8 Polish + legacy purge

Scrollbars: global `scrollbar-width: thin` + webkit 10px/6px thumb (~12 additive lines). Transitions: unify 0.12s → 0.15s (2 blocks). Purge: 9× `var(--accent-2, #9d80e9)` → `var(--accent-2)`; 4× success/danger fallback vars → bare vars; 2× `#f07860` → `var(--socket-out-hover)`; 17× `rgba(157,128,233,α)` → `rgba(63,185,80,α)`; node tints re-hue (llm `#152319`, condition `#251d12`, loop `#1a231d`, pipeline `#12202e`); 2× old-accent node strokes → `rgba(88,166,255,.35)`; 4× `rgba(200,210,225,…)` highlights → `rgba(240,246,252,…)`. Kept deliberately: `is-valid` text `#06281a` → `var(--accent-on)` (7.6:1); retrying amber `#e0a34e` (third state, not forbidden); condition orange stroke (not forbidden).

## Token Mapping (34 tokens)

| Token | New value | Token | New value |
|---|---|---|---|
| `--bg-base` | `#0d1117` | `--danger` | `var(--status-danger)` |
| `--bg-surface` | `#161b22` | `--danger-soft` | `rgba(248,81,73,.12)` |
| `--bg-card` | `#1c2128` | `--focus` | `#58a6ff` |
| `--bg-hover` | `#21262d` | `--grain-opacity` | deleted |
| `--text` | `#c9d1d9` | `--socket-in` | `var(--status-success)` |
| `--text-muted` | `#8b949e` | `--socket-in-hover` | `#56d364` |
| `--text-faint` | `#6e7681` | `--socket-out` | `var(--status-danger)` |
| `--border` | `rgba(240,246,252,.1)` | `--socket-out-hover` | `#ff7b72` |
| `--border-strong` | `rgba(240,246,252,.18)` | `--radius` | `6px` |
| `--accent` | `#58a6ff` | `--space-1…5` | unchanged |
| `--accent-bright` | `#79c0ff` | `--font` | JetBrains Mono stack |
| `--accent-soft` | `rgba(88,166,255,.12)` | `--mono` | unchanged |
| `--accent-glow` | `rgba(88,166,255,.3)` | `--accent-2` | `var(--status-success)` † |
| `--accent-on` | `#0d1117` | `--status-success` | `#3fb950` (add) |
| `--success` | `var(--status-success)` | `--status-danger` | `#f85149` (add) |
| `--success-soft` | `rgba(63,185,80,.12)` | | |

† declared on `:root`; currently fallback-only.

## Contrast Verification (spec-mandated pairs)

| Pair | Ratio | AA |
|---|---|---|
| `#c9d1d9` / `#0d1117` | 10.9:1 | ✓ |
| `#c9d1d9` / `#161b22` | 11.4:1 | ✓ |
| `#8b949e` / `#0d1117` | 6.6:1 | ✓ |
| `#6e7681` / `#0d1117` (near-floor) | 4.7:1 | ✓ |
| `#0d1117` / `#58a6ff` (near-floor) | 4.6:1 | ✓ |
| `#58a6ff` focus ring vs surfaces | ≥5:1 (UI needs 3:1) | ✓ |

Correction rule: any pair < 4.5:1 → adjust only the token value, never waive; first candidate `--text-faint` → `#7d8590` if needed.

## Data Flow

None — static CSS. `/ui/styles.css` served unchanged by existing `resolveUiAsset`; `var()` resolution happens in the browser at render.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/ui/styles.css` | Modify | `:root` remap + 2 token adds; mono; flat; compaction; focus 2px/1px; scrollbars; 150ms; literal purge (~200–260 authored lines) |
| `src/ui/index.html` | None | Untouched (spec: markup SHALL remain unchanged) |
| `src/ui/app.js` | None | Untouched (0 color literals confirmed) |

## Interfaces / Contracts

None new. CSS Custom Properties are the interface: names stable, values per the spec table, `--status-*` chain resolves for loop/sockets. No type definitions or API surface.

## UI Decisions

Contrast AA ✓ · focus ring 2px/1px on `:focus-visible` ✓ · global mono 14px (ui-gate size exception, user-approved; SVG labels ≥9px already mono) · color-only 150ms transitions (motion-safe; no `prefers-reduced-motion` needed) · SVG-only icons, no emoji ✓ · no new fixed-px containers.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Integration | e2e-smoke regression: `:focus-visible` + `aria-current` in served CSS; landmarks in served HTML | `bun test` (existing suite, unchanged) |
| Manual | Contrast pairs above | compute ratios; adjust token value if < 4.5 |
| Manual (visual) | 32px header fit, mono body, flat texture, green loop, socket colors, thin scrollbars, editor height calc | browser check at `/ui` |

## Threat Matrix

N/A — CSS-only change served by existing static routes; no routing, shell, subprocess, VCS/PR automation, executable classification, or process-integration boundary is touched.

## Migration / Rollout

No migration. Single commit; rollback = `git revert` (tokens live on `:root`, no JS dependency — reverting the block fully restores the theme).

## Open Questions

- [ ] Loop → green `#3fb950` vs llm_call green tint: verify they do not visually collide; fallback is a darker green or `--status-danger`.
- [ ] Header exact 32px (2px vs 4px vertical padding): measure in browser; adjust `calc(100vh - 57px)` if the rendered header height differs.