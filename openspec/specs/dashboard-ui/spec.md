# Dashboard UI Specification

## Purpose

The static SPA served at `/ui` that lets an operator inspect pipelines, models, and executions and build, validate, and hot-apply pipeline graphs in a browser.

## Requirements

### Requirement: Static SPA serving

The system SHALL serve the SPA as static assets at `/ui` with correct content types and a path-traversal guard, with no client build step.

#### Scenario: SPA loads at /ui

- GIVEN a browser requests `/ui`
- THEN the `index.html` is served with `text/html` and the SPA loads

#### Scenario: Path traversal is rejected

- GIVEN a request for `/ui/../../etc/passwd`
- WHEN the static handler resolves the path
- THEN the request is rejected with a non-200 response

### Requirement: Vanilla frontend

The system SHALL implement the SPA in vanilla HTML/CSS/JS with native SVG rendering (no D3/sigma/xyflow), HTML5 drag-and-drop, and native `<dialog>` elements. No framework shall be required at runtime.

#### Scenario: Editor renders the graph as native SVG

- GIVEN a pipeline graph loaded in the editor
- THEN the nodes and edges render as SVG DOM elements with no external graph library

### Requirement: Accessibility and keyboard navigation

The SPA SHALL meet WCAG AA contrast and MUST support full keyboard navigation with ARIA attributes on interactive elements.

#### Scenario: Entire editor is keyboard operable

- GIVEN a user without a pointing device
- WHEN they tab through the editor
- THEN every node, palette item, and dialog control is reachable and operable via keyboard

#### Scenario: Focus and contrast are WCAG-AA conformant

- GIVEN the SPA rendered
- THEN interactive focus states are visible and text contrast meets WCAG AA thresholds

### Requirement: Graph editing and validation

The editor SHALL let the operator compose node types (`start`, `end`, `llm_call`, `condition`, `loop`), connect them into edges, and invoke the validate endpoint. It SHALL display the validation result and surface errors in place.

#### Scenario: Operator builds and validates a graph

- GIVEN an operator dragging nodes onto the canvas and connecting them
- WHEN they submit the graph for validation
- THEN the result is displayed and, if invalid, the errors are surfaced next to the offending nodes

### Requirement: Condition AST builder

The editor SHALL provide a builder for condition expressions limited to `compare`, `logical` (AND/OR), `not`, and `exists` over `lastResponse.status`, `lastResponse.content`, `error`, and `variables`, with no free-form code entry.

#### Scenario: Condition is built from allowed operators only

- GIVEN an operator constructs a condition in the builder
- THEN only the allowed AST node types and context fields are selectable, and no code/eval input is offered

### Requirement: Apply with connection validation

The editor SHALL validate the connection schema before applying and SHALL send the resulting config to the apply endpoint, surfacing the apply result.

#### Scenario: Operator applies a validated graph

- GIVEN a valid graph composed in the editor
- WHEN the operator clicks apply
- THEN the connection is schema-validated, the config is posted, and the apply result is displayed

#### Scenario: Apply failure is surfaced

- GIVEN the apply endpoint returns a `400` envelope
- WHEN the editor receives it
- THEN the error message is shown and the previous editor state is retained

### Requirement: Execution and model inspection

The SPA SHALL display executions and models via the `/api/ui/*` endpoints and update live through the SSE events bus (execution progress, `pipeline:reloaded`, `models:changed`). The model inspection view SHALL render GGUF metadata (`ggufContextLength`, `hardwareMaxCtx`) per model. The pipeline editor's context window selector SHALL dynamically filter options using the selected model's `ggufContextLength` and `hardwareMaxCtx` instead of a hardcoded list, and SHALL visually indicate when a selected context exceeds the safe range.

#### Scenario: Execution progress updates live

- GIVEN the SPA is subscribed to SSE and an execution starts
- WHEN `step:*` events arrive
- THEN the executions view updates to reflect the current step and status

#### Scenario: Model list refreshes on models:changed

- GIVEN the SPA has loaded the model list
- WHEN a `models:changed` SSE event arrives
- THEN the model list refreshes to include the newly detected or registered models

#### Scenario: Context selector filtered by GGUF metadata

- GIVEN a model with `ggufContextLength: 8192` and `hardwareMaxCtx: 16384`
- WHEN the user selects that model in the pipeline editor
- THEN the context window selector shows only options up to `min(ggufContextLength, hardwareMaxCtx)`

#### Scenario: Context selector shows safe range indicator

- GIVEN a model where `hardwareMaxCtx` is less than `ggufContextLength`
- WHEN the user opens the context selector
- THEN options exceeding `hardwareMaxCtx` are visually distinguished (e.g., dimmed or flagged) to indicate they may cause OOM

#### Scenario: Fallback when GGUF metadata is null

- GIVEN a model with `ggufContextLength: null`
- WHEN the user selects that model
- THEN the context selector uses `hardwareMaxCtx` only, or shows all standard options as a fallback

### Requirement: Dark technical theme

The dashboard SHALL render in the "technical dark" visual direction as a CSS-only change: the served `index.html` markup, ARIA roles, and `app.js` behavior SHALL remain unchanged. The rendered SPA SHALL satisfy this observable contract:

**Palette — GitHub-dark neutrals with exact token values:**

| Token | Value |
|---|---|
| Background | `#0d1117` (base) / `#161b22` (surface) / `#1c2128` (card) |
| Text | `#c9d1d9` (primary) / `#8b949e` (muted) / `#7d8590` (faint, near-floor) |
| Accent | `#58a6ff`; text on accent `#0d1117` |
| Status | `#3fb950` (success) / `#f85149` (danger) |

- **Typography**: body text SHALL render in global mono — JetBrains Mono stack at 14px base with 1.6 line-height.
- **Texture**: the SPA SHALL render flat — the grain overlay and header backdrop blur SHALL be absent, and no steel-blue (`#4a90d9` family) remnants SHALL remain.
- **Topbar**: SHALL be compact — header padding `2px 16px`, 16px tab padding, 4–6px radii. The binding measured render height is **37.39px** (headless-Chromium measurement; the 14px-root title line-height drives the extra height over the nominal 32px). The editor layout SHALL track the measured header: `.editor-layout` height `calc(100vh - 61.39px)` (37.39px header + 1px border + 24px main padding).
- **Focus**: keyboard focus SHALL use a 2px ring with 1px offset; the `:focus-visible` and `aria-current` rules SHALL remain present in the served stylesheet.
- **Scrollbars**: SHALL be minimal (thin, unobtrusive).
- **Transitions**: color/background state changes SHALL run at 150ms.
- **Status tokens**: the loop accent and connection socket colors SHALL resolve through the `--status-*` token family (success/danger); hardcoded legacy fills (loop `#9d80e9`, sockets `#4cc38a`/`#e05b4f`) SHALL NOT be used.
- **Contrast**: every text/background pair SHALL meet WCAG AA (≥4.5:1). Measured binding values for the near-floor pairs: text-on-accent `#0d1117`/`#58a6ff` = 7.49:1; faint text `#7d8590` on base `#0d1117` = 5.07:1 (`#6e7681` measures 4.12:1 and is below the AA floor; the `#7d8590` lift is the required correction). Any pair below the floor SHALL be corrected by adjusting the token value, never by waiving the threshold.

#### Scenario: Dashboard renders in the technical dark theme

- GIVEN the dashboard SPA is served at `/ui` with the theme applied
- WHEN an operator loads the page
- THEN backgrounds render GitHub-dark neutrals, the accent is `#58a6ff`, body text is mono 14px/1.6, the topbar is compact (binding measured height 37.39px), and focus, scrollbar, and transition styling match the contract
- AND no steel-blue colors, grain overlay, or header blur are observable

#### Scenario: Near-floor contrast pairs remain AA

- GIVEN the rendered text-on-accent pair (`#0d1117` on `#58a6ff`, measured 7.49:1) and faint text `#7d8590` on the base background (measured 5.07:1)
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
