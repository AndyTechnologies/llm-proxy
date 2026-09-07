# Delta for Dashboard UI

Amends `dashboard-ui` (no new capabilities): Svelte 5 re-platform supersedes static-serving and vanilla-frontend; theme, accessibility, copy, and 5-view parity carry over unchanged.

## MODIFIED Requirements

### Requirement: Compiled SPA serving (was "Static SPA serving")

The system SHALL serve the compiled Svelte 5 CSR SPA at `/ui` with correct content types and a per-segment traversal guard (`..`, leading dots, backslashes, absolute paths rejected). Hashed asset subdirectories (`/ui/assets/*`) SHALL resolve. Unknown `/ui/*` paths SHALL fall back to `index.html`; `/api/*` SHALL NOT fall back, returning non-200 for unknown paths.
(Previously: hand-written SPA, no build step, single-segment assets, no fallback.)

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
(Previously: vanilla HTML/CSS/JS, no runtime framework.)

#### Scenario: Editor renders the graph as native SVG

- GIVEN a pipeline graph loaded in the editor
- THEN nodes and edges render as SVG with no external graph library

#### Scenario: Graph-model TS port preserves behavior

- GIVEN `graph-model` logic ported 1:1 to framework-free TypeScript
- WHEN its unit suite runs
- THEN every original case passes (suite is the port oracle)

## ADDED Requirements

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