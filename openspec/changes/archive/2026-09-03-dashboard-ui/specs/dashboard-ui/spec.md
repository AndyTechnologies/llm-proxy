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

The SPA SHALL display executions and models via the `/api/ui/*` endpoints and update live through the SSE events bus (execution progress, `pipeline:reloaded`, `models:changed`).

#### Scenario: Execution progress updates live

- GIVEN the SPA is subscribed to SSE and an execution starts
- WHEN `step:*` events arrive
- THEN the executions view updates to reflect the current step and status

#### Scenario: Model list refreshes on models:changed

- GIVEN the SPA has loaded the model list
- WHEN a `models:changed` SSE event arrives
- THEN the model list refreshes to include the newly detected or registered models
