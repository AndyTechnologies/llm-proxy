# Gateway API Specification

## Purpose

OpenAI-compatible HTTP endpoints exposing `/v1/chat/completions`, `/v1/completions`, and `/v1/models` with SSE streaming and normalized error responses.

## Requirements

### Requirement: OpenAI-compatible chat completions endpoint

The system SHALL expose `POST /v1/chat/completions` accepting an OpenAI-shaped request body (messages array, model, stream flag, temperature, top_p, max_tokens) and returning an OpenAI-shaped response.

#### Scenario: Non-streaming chat completion

- GIVEN a valid OpenAI chat completions request with `stream: false`
- WHEN the request reaches `/v1/chat/completions`
- THEN the response body is a JSON object with `id`, `object: "chat.completion"`, `choices`, `model`, and `usage`

#### Scenario: Unknown model returns 404

- GIVEN a request whose `model` does not match any configured provider
- WHEN the request reaches `/v1/chat/completions`
- THEN the system responds with HTTP 404 and an OpenAI-shaped error object

### Requirement: OpenAI-compatible completions endpoint

The system SHALL expose `POST /v1/completions` accepting an OpenAI-shaped request body (prompt, model, stream, temperature, max_tokens) and returning an OpenAI-shaped response.

#### Scenario: Non-streaming text completion

- GIVEN a valid completions request with `stream: false`
- WHEN the request reaches `/v1/completions`
- THEN the response body is a JSON object with `id`, `object: "text_completion"`, `choices`, and `model`

### Requirement: OpenAI-compatible models listing endpoint

The system SHALL expose `GET /v1/models` returning a list of all available real and virtual models.

#### Scenario: Models list returns all models

- GIVEN a client requests `GET /v1/models`
- WHEN the system resolves configured providers and virtual chains
- THEN the response contains `object: "list"` with entries for each model and each virtual chain prefixed `gateway/`

### Requirement: SSE idle timeout disabled on streaming routes

The system MUST serve SSE routes with the Bun.serve idle timeout disabled (`idleTimeout: 0` or `server.timeout(req, 0)`) so silent streams are never closed by the server. Slow non-SSE routes SHOULD be given explicit per-route timeouts.

#### Scenario: Stream survives long silence

- GIVEN an SSE stream with no frames for more than 10 seconds
- WHEN the stream continues producing no data
- THEN the connection stays open and `data: [DONE]` still arrives at completion

### Requirement: SSE streaming integrity

The system SHALL stream responses unbuffered. Each SSE message SHALL be a `data:` line terminated by `\n\n`. The stream SHALL end with exactly one `data: [DONE]` message, preceded by exactly one terminal chunk when the upstream sends no finish reason. On client disconnect the system MUST abort the upstream request.
(Previously: streamed via Express `res.pipe()`; transport is now Bun.serve with idle timeout disabled.)

#### Scenario: Chat completions streams via SSE

- GIVEN a chat completions request with `stream: true`
- WHEN the backend starts producing tokens
- THEN each token arrives as a `data: {...}\n\n` frame and the stream ends with exactly one `data: [DONE]\n\n`

#### Scenario: Client disconnect aborts upstream

- GIVEN an active SSE stream
- WHEN the client disconnects (TCP close)
- THEN the system aborts the upstream request and releases resources

#### Scenario: Terminal chunk synthesized exactly once

- GIVEN a stream whose upstream never sends a finish reason
- WHEN the stream reaches completion
- THEN exactly one synthesized chunk with `finish_reason: "stop"` is emitted before `data: [DONE]`

### Requirement: Normalized error responses

The system SHALL return errors as JSON objects matching the OpenAI shape: `{ error: { message, type, param, code } }`.

#### Scenario: Validation error returns 400

- GIVEN a request with invalid body (missing required fields, wrong types)
- WHEN zod validation fails
- THEN the system responds with HTTP 400 and `{ error: { message, type: "invalid_request_error", param, code: null } }`

#### Scenario: Server error returns 500

- GIVEN an unhandled exception during request processing
- WHEN the error handler catches it
- THEN the system responds with HTTP 500 and `{ error: { message: "...", type: "server_error", param: null, code: null } }`
