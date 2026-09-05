# Tasks: Dark Technical Theme for Dashboard UI

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 400–600 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Single CSS-only theme change | PR 1 | `bun test` (e2e-smoke) | `/ui` browser check | `git revert`; tokens on `:root` |

## Phase 1: Foundation — token remap

- [x] 1.1 Remap all 34 `:root` token values in `src/ui/styles.css` to the guide palette (per design token table); delete `--grain-opacity`
- [x] 1.2 Add `:root` tokens in `src/ui/styles.css`: `--status-success: #3fb950`, `--status-danger: #f85149`, `--accent-2: var(--status-success)` (was phantom fallback-only)
- [x] 1.3 Wire alias chain in `src/ui/styles.css` `:root`: `--success/--danger/--socket-in/--socket-out` → `var(--status-*)`; set hovers `--socket-in-hover: #56d364`, `--socket-out-hover: #ff7b72`

## Phase 2: Core — typography, texture, compaction, polish

- [x] 2.1 Set `--font` in `src/ui/styles.css` `:root` to JetBrains Mono stack; body 14px/1.6
- [x] 2.2 Delete `body::before` grain in `src/ui/styles.css`; remove header `backdrop-filter`, set solid `var(--bg-base)`; drop glow shadows (nav active, `btn-primary`, `is-valid`)
- [x] 2.3 Compact header to `padding: 2px 16px`, nav-link `padding: var(--space-1) 16px` in `src/ui/styles.css`; update `.editor-layout` height to `calc(100vh - 57px)` (was 88px)
- [x] 2.4 Set `--radius: 6px` and `.node-box` rx 4 in `src/ui/styles.css`; canvas grid `var(--border)` → `var(--border-strong)`
- [x] 2.5 Tighten `:focus-visible` values to `outline: 2px` / `outline-offset: 1px` in `src/ui/styles.css` (selector list byte-stable; `[aria-current="true"]` untouched)
- [x] 2.6 Add minimal global scrollbars in `src/ui/styles.css` (thin + webkit 10px/6px thumb); unify 0.12s → 0.15s transitions

## Phase 3: Purges — legacy literals + tints

- [x] 3.1 Replace 9× `var(--accent-2, #9d80e9)` → `var(--accent-2)` in `src/ui/styles.css`
- [x] 3.2 Replace 4× fallback vars (`var(--success, #4cc38a)`, `var(--danger, #e05b4f)`) → bare vars in `src/ui/styles.css`
- [x] 3.3 Replace 2× `#f07860` → `var(--socket-out-hover)` and 17× `rgba(157,128,233,α)` → `rgba(63,185,80,α)` in `src/ui/styles.css`
- [x] 3.4 Replace 4× `rgba(200,210,225,α)` → `rgba(240,246,252,…)`; re-hue node tints (llm `#152319`, condition `#251d12`, loop `#1a231d`, pipeline `#12202e`); old-accent node strokes → `rgba(88,166,255,.35)` in `src/ui/styles.css`. Keep `is-valid` → `var(--accent-on)`, retrying amber `#e0a34e`

## Phase 4: Verification

- [x] 4.1 Run `bun test` — e2e-smoke must still pass (`:focus-visible`, `aria-current`, landmarks; read-only ref `src/dashboard/e2e-smoke.test.ts`)
- [x] 4.2 (VISUAL) Browser at `/ui`: topbar ≈32px, mono body, flat texture, green loop, sockets, thin scrollbars, editor fills bottom (`calc(100vh - 57px)`)
- [x] 4.3 Verify contrast pairs ≥4.5:1, incl. the 2 near-floor (`#0d1117`/`#58a6ff` 4.6, `#6e7681`/`#0d1117` 4.7); adjust token value if below floor (first candidate `--text-faint` → `#7d8590`)
- [x] 4.4 CLOSE open question (visual collision): confirm loop green vs llm_call green tint do not collide; fallback darker green/`--status-danger` in `src/ui/styles.css`
- [x] 4.5 CLOSE open question (header height): measure rendered 32px header; adjust `calc(100vh - 57px)` in `src/ui/styles.css` if it differs (2px vs 4px padding)