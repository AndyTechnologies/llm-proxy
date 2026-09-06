# Proposal: Dark Technical Theme for Dashboard UI

## Intent

Adapt the dashboard SPA to the approved "technical dark" design guide: hue shift to GitHub-dark neutrals + `#58a6ff`, global mono typography, flat texture, topbar compaction, and scrollbar/focus/transition polish. CSS-only; zero `app.js` or copy changes.

## Scope

### In Scope
- Token-value remap on `:root` to the guide palette (exploration Approach 1)
- Global mono: JetBrains Mono / Fira Code stack, 14px base
- Flat style: remove grain overlay + header blur
- Loop purple `--accent-2` + socket green/red mapped to `--status-*`
- Topbar 32px, radius 4–6, focus 2px/1px, minimal scrollbars, 150ms transitions

### Out of Scope
- Full re-tokenization to guide token names (deferred; exceeds budget)
- `app.js` / `graph-model.js` / HTML semantics changes
- Spanish UI copy; light theme / theme switching
- Density changes (already at guide targets)

## Capabilities

### New Capabilities
None

### Modified Capabilities
- `dashboard-ui`: ADDED requirement "Dark technical theme" (GitHub-dark palette, mono 14px base, compact 32px topbar, `--status-*` tokens, 2px/1px focus ring, minimal scrollbars). WCAG AA requirement unchanged; delta MAY add a scenario for near-floor contrast pairs (≈4.6:1 / 4.7:1).

## Approach

Approach 1: change `:root` token VALUES to the guide palette; keep all 34 token names so every `var()` still resolves. Then: mono body font, remove grain/blur, 32px topbar, radius 4–6, focus 2px/1px, scrollbars, 150ms transitions, loop/sockets → `--status-*`. Keep `:focus-visible` and `aria-current` byte-stable. Diff stays under the 800-line single-PR budget.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/ui/styles.css` | Modified | Tokens, typography, texture, compaction, focus, scrollbars, transitions |
| `src/ui/index.html` | Modified (minimal) | Topbar/conn-status class tweaks; e2e ids/roles preserved |
| `openspec/specs/dashboard-ui/spec.md` | Modified (archive) | Delta adds theme requirement |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| e2e substrings dropped (`:focus-visible`, `aria-current`) | Med | Keep selectors; `bun test` before PR |
| Contrast near 4.5:1 floor | Low | Verify pairs; adjust value if below AA |
| Mono 14px readability | Med | User-confirmed; line-height 1.6 |
| Stale `var(--accent-2, #9d80e9)` fallbacks | Low | Declare on `:root`; remove fallbacks |

## Rollback Plan

`git revert` of the CSS/HTML commit. Tokens live on `:root` with no JS dependency; restoring the previous block fully reverts the theme.

## Dependencies

- None. No packages, build step, or API changes.

## Success Criteria

- [ ] GitHub-dark palette renders; no steel-blue/grain remnants
- [ ] Mono 14px/1.6 body; flat texture
- [ ] Loop/sockets use `--status-*`; no hardcoded fills
- [ ] `bun test` green, incl. e2e-smoke
- [ ] All token pairs ≥ 4.5:1
- [ ] Diff ≤ 800 lines (single PR)