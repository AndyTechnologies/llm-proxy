# External Providers Specification

## Purpose

Plug external OpenAI-compatible APIs into the gateway behind the existing `Provider` seam (`chat`/`chatStream`) through an adapter built on `ai@7` + `@ai-sdk/openai-compatible@3`. The adapter translates OpenAI payloads and responses across the seam, reconstructs the OpenAI wire shape (tool_calls, finish_reason, usage), forwards abort signals, and maps SDK errors to the gateway error contract. `Provider`, the graph engine, and the SSE output boundary (`buildStreamBody`) stay frozen; the managed local llama-server backend is NOT migrated by this change.

## Requirements

### Requirement: OpenAI-compatible provider adapter

The system MUST provide an adapter implementing the `Provider` seam (`chat` and `chatStream`) for external OpenAI-compatible APIs, built on `@ai-sdk/openai-compatible@3.0.44` over `ai@7.0.93`. Non-streaming calls SHALL produce an OpenAI-shaped JSON response; streaming calls SHALL emit OpenAI wire-format SSE chunks (tool_calls, finish_reason, usage) that the existing `buildStreamBody` contract relays unchanged. The local llama-server backend SHALL remain on its current fetch path.

#### Scenario: Non-streaming external round-trip

- GIVEN an external provider configured with baseURL and a model
- WHEN a non-streaming chat request targets that model
- THEN the response is OpenAI-shaped JSON with choices, finish_reason, usage, and upstream tool_calls when present

#### Scenario: Streaming external round-trip

- GIVEN an external provider and a `stream: true` chat request
- WHEN the upstream streams tokens
- THEN OpenAI-wire SSE chunks flow through `buildStreamBody` and the stream ends with exactly one `data: [DONE]`

#### Scenario: Tool calls survive the adapter

- GIVEN an upstream response containing tool_calls
- WHEN the adapter reconstructs the wire shape
- THEN `tool_calls` are OpenAI-shaped so `tool_calls_route` keeps routing on them

### Requirement: Retries disabled for 429 observability

The adapter MUST issue each call with SDK retries disabled (`maxRetries: 0`) so the first upstream 429 reaches the gateway untouched and `on_429` fallback routing decides.

#### Scenario: First 429 is surfaced, not retried

- GIVEN an upstream that answers 429
- WHEN the adapter calls it
- THEN the adapter surfaces a 429 error immediately with no SDK retry

### Requirement: SDK error translation

The adapter MUST translate SDK errors into the gateway error contract (`Error & { status }`): `TooManyRequestsError` and stream/API errors carrying 429 map to `status: 429`; `NoSuchModelError` maps to `status: 404`; other `APICallError`s map to their upstream status; `RetryError` and unclassified failures map to `500` (retries being disabled, exhaustion handling is defensive).

#### Scenario: 429 maps to status 429

- GIVEN the SDK throws `TooManyRequestsError` (or a `StreamProviderError`/`APICallError` carrying 429)
- WHEN the adapter translates it
- THEN the error carries `status: 429` and `on_429` routing triggers

#### Scenario: Unknown model maps to status 404

- GIVEN the SDK throws `NoSuchModelError`
- WHEN the adapter translates it
- THEN the error carries `status: 404` and the gateway produces the model 404 envelope

#### Scenario: Upstream 5xx maps to its status

- GIVEN an `APICallError` with status 502
- WHEN the adapter translates it
- THEN the error carries `status: 502`

### Requirement: Sampler pass-through via providerOptions

The adapter MUST pass llama.cpp-specific samplers (`min_p`, `typical_p`, `top_k`, `repeat_penalty`) supplied through `providerOptions` under the camelCase provider name as top-level chat-completions body fields. Standard OpenAI parameters (temperature, top_p, max_tokens, stop) SHALL map directly.

#### Scenario: Samplers land top-level in the request body

- GIVEN a call configured with sampler values via providerOptions
- WHEN the adapter builds the request
- THEN `min_p`, `typical_p`, `top_k`, and `repeat_penalty` are top-level body fields

#### Scenario: Standard parameters map directly

- GIVEN a payload with temperature, top_p, max_tokens, and stop
- WHEN the adapter builds the request
- THEN those fields are sent under their standard OpenAI names

### Requirement: Static authentication

The adapter MUST authenticate with a static `apiKey` sent as `Authorization: Bearer <apiKey>` and static custom `headers`, both resolved at config load with `${ENV}` interpolation. Dynamic per-call auth SHALL NOT be part of this change.

#### Scenario: Bearer auth is sent with static headers

- GIVEN a provider with `apiKey` and `headers` configured
- WHEN the adapter calls the upstream
- THEN the request carries `Authorization: Bearer <apiKey>` plus the static headers

#### Scenario: No apiKey means no Authorization header

- GIVEN a provider without `apiKey`
- WHEN the adapter calls the upstream
- THEN no `Authorization` header is sent

### Requirement: Abort forwarding

The adapter MUST forward the caller's `abortSignal` to the SDK call so a client disconnect aborts the external upstream request.

#### Scenario: Client disconnect aborts the external upstream

- GIVEN an in-flight external stream
- WHEN the client disconnects
- THEN the upstream request is aborted and resources are released