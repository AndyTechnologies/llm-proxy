# Virtual Model Routing Specification

## Purpose

Expose pipeline chains as virtual models invocable via the `model` field with a `gateway/` prefix or via the `X-Chain-ID` HTTP header.

## Requirements

### Requirement: Virtual model invocation via model prefix

The system SHALL treat any request whose `model` field starts with `gateway/` as a chain invocation. The text after `gateway/` SHALL be the chain identifier.

#### Scenario: Gateway-prefixed model invokes chain

- GIVEN a chat completions request with `model: "gateway/thinker"`
- WHEN the orchestrator resolves the model
- THEN the system executes the `thinker` chain instead of routing to a provider

#### Scenario: Unknown chain name returns 404

- GIVEN a request with `model: "gateway/nonexistent"`
- WHEN the chain is not found in config
- THEN the system responds with HTTP 404 and an error message indicating the chain was not found

### Requirement: Virtual model invocation via X-Chain-ID header

The system SHALL accept an `X-Chain-ID` HTTP header as an alternative invocation mechanism. When present, it SHALL override the `model` field for chain resolution.

#### Scenario: X-Chain-ID header routes to chain

- GIVEN a chat completions request with `model: "gpt-4"` and header `X-Chain-ID: thinker`
- WHEN the orchestrator evaluates the header
- THEN the system executes the `thinker` chain, ignoring the `model` field

#### Scenario: X-Chain-ID with no matching chain returns 404

- GIVEN a request with header `X-Chain-ID: unknown`
- WHEN the chain is not found in config
- THEN the system responds with HTTP 404

### Requirement: Virtual models appear in /v1/models listing

The system SHALL include all configured virtual chains in the `GET /v1/models` response. Each virtual model entry SHALL have `id: "gateway/<chain-name>"` and `owned_by: "gateway"`.

#### Scenario: Models list includes virtual chains

- GIVEN the config defines chains `thinker`, `coder`, `verifier`
- WHEN a client requests `GET /v1/models`
- THEN the response includes entries with `id` values `gateway/thinker`, `gateway/coder`, `gateway/verifier`
- AND each entry has `owned_by: "gateway"`

### Requirement: Virtual model passthrough support

The system SHALL support a `passthrough` step type that forwards the request directly to a provider without transformation, used for final stages in multi-step chains.

#### Scenario: Passthrough step streams directly

- GIVEN a chain whose final step is `type: "passthrough"` targeting `llama-server`
- WHEN the chain reaches the final step
- THEN the response is proxied directly to the client without additional processing
