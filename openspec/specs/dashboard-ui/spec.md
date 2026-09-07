# Dashboard UI Specification

## Purpose

The static SPA served at `/ui` that lets an operator inspect pipelines, models, and executions and build, validate, and hot-apply pipeline graphs in a browser.

## Requirements

### Requirement: Compiled SPA serving (was "Static SPA serving")

The system SHALL serve the compiled Svelte 5 CSR SPA at `/ui` with correct content types and a per-segment traversal guard (`..`, leading dots, backslashes, absolute paths rejected). Hashed asset subdirectories (`/ui/assets/*`) SHALL resolve. Unknown `/ui/*` paths SHALL fall back to `index.html`; `/api/*` SHALL NOT fall back, returning non-200 for unknown paths.

#### Scenario: SPA loads at /ui

- GIVEN a browser requests `/ui`
- THEN `index.html` serves with `text/html`

#### Scenario: Hashed asset subdirectory is served

- GIVEN a request for `/ui/assets/*`
- THEN the asset serves with the correct content type

#### Scenario: Path traversal is rejected

- GIVEN a request for `/ui/../../etc/passwd`
- THEN a non-200 is returned

#### Scenario: Unknown /ui/* falls back to index.html

- GIVEN a client-route reload like `/ui/pipelines`
- THEN `index.html` is served, not a 404

#### Scenario: Fallback never intercepts /api/*

- GIVEN an unknown `/api/ui/*` request
- THEN a non-200 is returned without fallback

### Requirement: Svelte frontend (was "Vanilla frontend")

The system SHALL implement the SPA in Svelte 5 compiled to static assets, with native SVG rendering (no D3/sigma/xyflow), HTML5 drag-and-drop, and native `<dialog>`; Svelte SHALL be the only frontend runtime dependency.

#### Scenario: Editor renders the graph as native SVG

- GIVEN a pipeline graph loaded in the editor
- THEN nodes and edges render as SVG with no external graph library

#### Scenario: Graph-model TS port preserves behavior

- GIVEN `graph-model` logic ported 1:1 to framework-free TypeScript
- WHEN its unit suite runs
- THEN every original case passes (suite is the port oracle)

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

### Requirement: Editor undo/redo and connection handling

The editor SHALL provide bounded undo/redo over graph mutations (add, move, delete, connect, reorder) and SHALL preserve the connection contract: 24 px nearest-socket hit radius, self-edge rejection, guarded edges.

#### Scenario: Undo restores, redo reapplies

- GIVEN an operator deletes a node and presses undo
- THEN the node and its edges are restored
- AND redo reapplies the deletion

### Requirement: Executions and metrics at list level

The executions view SHALL render list-level data (`id`, `pipelineId`, `status`, `totalLatencyMs`) with SSE live updates and SHALL wire the existing step-retry endpoint; no per-step detail is requested, the API contract unchanged.

#### Scenario: Failed execution is retried

- GIVEN a failed execution row
- WHEN the operator clicks retry
- THEN the step-retry endpoint is called and the view reflects it

### Requirement: Models and backend lifecycle panel

The models view SHALL render the lifecycle panel (TTL, VRAM mode/freeGb/capGb) and per-model controls from existing `/api/ui/*` data, updating on `models:changed`.

#### Scenario: Backend changes apply via existing endpoints

- GIVEN the panel edits TTL/VRAM values and saves
- THEN `/api/ui/config` and `/api/ui/apply` are called and the view reflects it

### Requirement: Trace logging and debug/verbose mode

The SPA SHALL expose a visible trace log of client events (SSE receipt, store transitions, fetch errors, editor actions) and a debug/verbose mode revealing detail already present in REST/SSE payloads. Both SHALL be presentation-only: no backend changes, no invented data.

#### Scenario: Trace records events, debug shows only real data

- GIVEN an SSE event arrives
- THEN a trace entry records it
- AND debug mode shows only fields already in REST/SSE responses

### Requirement: SSE coverage and throttled refresh

The SSE service SHALL handle all eight event names (`execution:started`, `step:started`, `step:completed`, `step:failed`, `execution:completed`, `execution:failed`, `pipeline:reloaded`, `models:changed`) and SHALL throttle/batch list refreshes so high-frequency events do not block the main thread, preserving reconnect resilience.

#### Scenario: All eight events handled, including execution:failed

- GIVEN each of the eight event types arrives
- THEN each is handled, `execution:failed` included, with batched rather than per-event refetch

#### Scenario: Reconnect restores state

- GIVEN the SSE connection drops
- THEN it reconnects and resumes handling events

### Requirement: Bundle size and self-contained binary

The production app JS SHALL be ≤ 100 KB gzip, measured on the production build. The release binary SHALL embed the compiled UI via `--asset`, resolved through `import.meta.dir` from any working directory, with disk-served fallback when not embedded. The `UI_DIR` env override SHALL remain honored.

#### Scenario: Bundle stays within budget

- GIVEN a production build
- WHEN app JS gzip size is measured
- THEN it is ≤ 100 KB

#### Scenario: Binary is self-contained, UI_DIR honored

- GIVEN the compiled binary runs from an arbitrary working directory
- THEN UI assets load from the embedded store, or disk when not embedded
- AND an explicit `UI_DIR` overrides the resolved directory

### Requirement: Five-view parity and Rioplatense copy

The SPA SHALL retain the five views (Editor, Pipelines, Modelos, Ejecuciones, Agentes) with the full editor interaction set, and SHALL keep UI copy in Rioplatense Spanish (voseo).

#### Scenario: Five views navigate with Spanish copy

- GIVEN the SPA loads
- THEN all five hash-anchored views are reachable
- AND copy uses Rioplatense Spanish (e.g. "Validar", "Principal")
