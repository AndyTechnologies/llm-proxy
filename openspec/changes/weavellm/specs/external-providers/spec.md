# Delta for External Providers

Delta over `openspec/specs/external-providers/spec.md`: the single OpenAI-compatible adapter becomes a four-provider adapter with keychain-backed credentials and provider fallback.

## RENAMED Requirements

### Requirement: OpenAI-compatible provider adapter → Multi-provider adapter

(Reason: the adapter now covers four providers, not only OpenAI-compatible.)
(Migration: tests/docs referencing the adapter should use the multi-provider name.)

## MODIFIED Requirements

### Requirement: Multi-provider adapter

The system MUST provide adapters implementing the `Provider` seam (`chat` and `chatStream`) for four providers — OpenAI-compatible, Anthropic, Google, Groq — on the ai@7 SDK families. Non-streaming calls SHALL produce an OpenAI-shaped JSON response; streaming calls SHALL emit OpenAI wire-format SSE chunks (tool_calls, finish_reason, usage) that the existing `buildStreamBody` contract relays unchanged. The local llama-server backend SHALL remain on its current fetch path.
(Previously: single OpenAI-compatible adapter on `@ai-sdk/openai-compatible@3.0.44` over `ai@7.0.93`.)

#### Scenario: Non-streaming round-trip across providers

- GIVEN any of the four providers configured with credentials and a model
- WHEN a non-streaming chat request targets that model
- THEN the response is OpenAI-shaped JSON with choices, finish_reason, usage, and upstream tool_calls when present

#### Scenario: Streaming round-trip

- GIVEN any provider and a `stream: true` chat request
- WHEN the upstream streams tokens
- THEN OpenAI-wire SSE chunks flow through `buildStreamBody` and the stream ends with exactly one `data: [DONE]`

#### Scenario: Tool calls survive the adapter

- GIVEN an upstream response containing tool_calls
- WHEN the adapter reconstructs the wire shape
- THEN `tool_calls` are OpenAI-shaped so `tool_calls_route` keeps routing on them

### Requirement: Keychain-backed authentication

The adapters MUST authenticate using provider credentials resolved from the keychain store (keychain-secrets), sent as `Authorization: Bearer <key>` where the provider expects it, plus static custom headers resolved at config load with `${ENV}` interpolation for non-secret values. A provider without a stored key SHALL be marked misconfigured rather than sending empty credentials.
(Previously: static `apiKey` and `headers` resolved entirely from config with ENV interpolation.)

#### Scenario: Bearer auth from keychain

- GIVEN a provider with a keychain-stored key
- WHEN the adapter calls upstream
- THEN the request carries `Authorization: Bearer <key>` plus the static headers

#### Scenario: Missing key marks provider misconfigured

- GIVEN a provider with no stored key
- WHEN a call targets it
- THEN the adapter reports a misconfigured-provider error and sends no Authorization header

## ADDED Requirements

### Requirement: Provider fallback

When a provider call fails with 429, 5xx, or a network error and a fallback provider is configured, the system SHALL retry the request on the next provider. Streaming fallback MUST NOT duplicate already-emitted tokens.

#### Scenario: 429 falls back

- GIVEN a primary returning 429 and a fallback configured
- WHEN the call fails
- THEN the request retries on the fallback and its result is returned

#### Scenario: Streaming fallback without duplication

- GIVEN a stream failing mid-stream and a fallback configured
- WHEN fallback restarts the request
- THEN the client receives one complete stream with no duplicated prefix