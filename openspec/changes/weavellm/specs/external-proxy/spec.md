# External Proxy Specification

## Purpose

Expose the gateway as an OpenAI-compatible API on localhost port 4317: /v1/chat/completions, /v1/completions, /v1/models (and /v1/embeddings), routing to four providers with optional keychain-backed auth.

## Requirements

### Requirement: OpenAI-compatible endpoints

The system SHALL serve `/v1/chat/completions`, `/v1/completions`, and `/v1/models` on port 4317 with OpenAI wire shapes.

#### Scenario: Chat round-trip

- GIVEN a client posting to /v1/chat/completions
- WHEN the request is valid
- THEN an OpenAI-shaped JSON (or SSE when streaming) response is returned

#### Scenario: Model listing

- GIVEN a GET /v1/models
- WHEN the request is valid
- THEN the response lists virtual models and provider models

### Requirement: Provider routing

The proxy SHALL route requests across the four supported providers (OpenAI-compatible, Anthropic, Google, Groq) according to model mapping.

#### Scenario: Model resolves to provider

- GIVEN a model mapped to the Anthropic provider
- WHEN a chat request targets it
- THEN the request is translated and routed to that provider

#### Scenario: Unmapped model returns 404

- GIVEN a model name with no mapping
- WHEN a request targets it
- THEN the proxy returns 404 with the OpenAI unknown-model envelope

### Requirement: Optional authentication

Auth SHALL be OFF by default. When enabled, requests MUST carry a valid key from the keychain store or receive 401.

#### Scenario: Default open

- GIVEN auth disabled (default)
- WHEN any request arrives
- THEN it proceeds without credentials

#### Scenario: Auth enforced

- GIVEN auth enabled with a stored key
- WHEN a request lacks the valid key
- THEN the proxy answers 401 with the OpenAI authentication_error envelope

### Requirement: Streaming passthrough

Streaming SHALL relay OpenAI-wire SSE through the /v1 endpoints, ending with exactly one `data: [DONE]`, and SHALL abort upstream on client disconnect.

#### Scenario: SSE relay with terminal chunk

- GIVEN a streaming request
- WHEN the upstream streams
- THEN chunks are relayed and the stream ends with exactly one `data: [DONE]`

#### Scenario: Client disconnect aborts

- GIVEN an in-flight stream
- WHEN the client disconnects
- THEN the upstream invocation is aborted and resources are released