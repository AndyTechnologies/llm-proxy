# Delta for Virtual Model Routing

## MODIFIED Requirements

### Requirement: Virtual model invocation via model prefix

The system SHALL treat any request whose `model` field starts with `gateway/` as a pipeline invocation. The text after `gateway/` SHALL be the pipeline identifier. The pipeline SHALL be resolved from the unified `graphMap` registry (not from a `chainMap` + `graphMap` union).
(Previously: Virtual models were resolved from a union of `chainMap` and `graphMap`.)

#### Scenario: Gateway-prefixed model invokes pipeline

- GIVEN a chat completions request with `model: "gateway/thinker"`
- WHEN the orchestrator resolves the model
- THEN the system executes the `thinker` pipeline from `graphMap`

#### Scenario: Unknown pipeline name returns 404

- GIVEN a request with `model: "gateway/nonexistent"`
- WHEN the pipeline is not found in `graphMap`
- THEN the system responds with HTTP 404 and an error message indicating the pipeline was not found

### Requirement: Virtual model invocation via X-Chain-ID header

The system SHALL accept an `X-Chain-ID` HTTP header as an alternative invocation mechanism. When present, it SHALL override the `model` field for pipeline resolution from `graphMap`.
(Previously: header resolved from union registry.)

#### Scenario: X-Chain-ID header routes to pipeline

- GIVEN a chat completions request with `model: "gpt-4"` and header `X-Chain-ID: thinker`
- WHEN the orchestrator evaluates the header
- THEN the system executes the `thinker` pipeline from `graphMap`, ignoring the `model` field

#### Scenario: X-Chain-ID with no matching pipeline returns 404

- GIVEN a request with header `X-Chain-ID: unknown`
- WHEN the pipeline is not found in `graphMap`
- THEN the system responds with HTTP 404

### Requirement: Virtual models appear in /v1/models listing

The system SHALL include all configured virtual pipelines in the `GET /v1/models` response. Each virtual model entry SHALL have `id: "gateway/<pipeline-name>"` and `owned_by: "gateway"`. The listing SHALL be derived from `graphMap` only.
(Previously: listing merged from both `chainMap` and `graphMap`.)

#### Scenario: Models list includes virtual pipelines

- GIVEN the config defines pipelines `thinker`, `coder`, `verifier` in `graphMap`
- WHEN a client requests `GET /v1/models`
- THEN the response includes entries with `id` values `gateway/thinker`, `gateway/coder`, `gateway/verifier`
- AND each entry has `owned_by: "gateway"`

### Requirement: Virtual model passthrough support

The system SHALL support a `passthrough` node type that forwards the request directly to a provider without transformation, used for final stages in multi-step pipelines.
(Previously: passthrough was a step type; now it is a node type in the graph.)

#### Scenario: Passthrough node streams directly

- GIVEN a pipeline whose final node is `type: "passthrough"` targeting `llama-server`
- WHEN the pipeline reaches the final node
- THEN the response is proxied directly to the client without additional processing
