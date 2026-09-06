# Delta for Dashboard UI

## ADDED Requirements

### Requirement: Dark technical theme

The dashboard SHALL render in the "technical dark" visual direction as a CSS-only change: the served `index.html` markup, ARIA roles, and `app.js` behavior SHALL remain unchanged. The rendered SPA SHALL satisfy this observable contract:

**Palette — GitHub-dark neutrals with exact token values:**

| Token | Value |
|---|---|
| Background | `#0d1117` (base) / `#161b22` (surface) / `#1c2128` (card) |
| Text | `#c9d1d9` (primary) / `#8b949e` (muted) |
| Accent | `#58a6ff`; text on accent `#0d1117` |
| Status | `#3fb950` (success) / `#f85149` (danger) |

- **Typography**: body text SHALL render in global mono — JetBrains Mono stack at 14px base with 1.6 line-height.
- **Texture**: the SPA SHALL render flat — the grain overlay and header backdrop blur SHALL be absent, and no steel-blue (`#4a90d9` family) remnants SHALL remain.
- **Topbar**: SHALL be compact at 32px with 16px tab padding and 4–6px radii.
- **Focus**: keyboard focus SHALL use a 2px ring with 1px offset; the `:focus-visible` and `aria-current` rules SHALL remain present in the served stylesheet.
- **Scrollbars**: SHALL be minimal (thin, unobtrusive).
- **Transitions**: color/background state changes SHALL run at 150ms.
- **Status tokens**: the loop accent and connection socket colors SHALL resolve through the `--status-*` token family (success/danger); hardcoded legacy fills (loop `#9d80e9`, sockets `#4cc38a`/`#e05b4f`) SHALL NOT be used.
- **Contrast**: every text/background pair SHALL meet WCAG AA (≥4.5:1), explicitly verified including the near-floor candidates (text-on-accent and faint text on base).

#### Scenario: Dashboard renders in the technical dark theme

- GIVEN the dashboard SPA is served at `/ui` with the theme applied
- WHEN an operator loads the page
- THEN backgrounds render GitHub-dark neutrals, the accent is `#58a6ff`, body text is mono 14px/1.6, the topbar is 32px, and focus, scrollbar, and transition styling match the contract
- AND no steel-blue colors, grain overlay, or header blur are observable

#### Scenario: Near-floor contrast pairs remain AA

- GIVEN the rendered text-on-accent pair (`#0d1117` on `#58a6ff`) and faint/muted text on the base background
- WHEN their contrast ratios are measured
- THEN each pair is ≥4.5:1
- AND any pair below the floor SHALL be corrected by adjusting the token value, never by waiving the threshold

#### Scenario: Regression contract is preserved

- GIVEN the themed `styles.css` and `index.html` are served
- WHEN the e2e smoke suite runs (`bun test`)
- THEN `:focus-visible` and `aria-current` remain present in `styles.css`
- AND `role="banner"`, `id="graph-canvas"`, `<dialog`, and `id="palette"` remain in the served `index.html`

#### Scenario: Loop and socket colors resolve via status tokens

- GIVEN the re-themed dashboard renders
- WHEN the loop accent, badges, and connection sockets are inspected
- THEN their rendered fills match the `--status-*` success/danger values
- AND no legacy hardcoded fills (loop `#9d80e9`, socket `#4cc38a`/`#e05b4f`) appear