# Delta for proxy-pipeline

## MODIFIED Requirements

### Requirement: Streaming produces valid SSE without ReferenceError

The streaming pipeline MUST complete a chat/completions request without throwing a ReferenceError from pipeline scope. The system SHALL use `res.pipe()` unbuffered for SSE streaming toward the llama-server backend.

(Previously: Streaming completed with scope-related ReferenceError bugs in pipeline variables)

#### Scenario: Streaming completes cleanly

- GIVEN an OpenAI-compatible streaming request through the chain engine
- WHEN the stream runs to normal completion
- THEN the response is a valid SSE stream with no ReferenceError raised

#### Scenario: Terminal chunk marks finish reason

- GIVEN a streaming request that reaches a finish reason
- WHEN the pipeline assigns the finish reason
- THEN the variable is declared and readable in stream scope

### Requirement: Request payload is normalized for llama.cpp

The outbound payload MUST normalize `developer` roles to `system` and flatten array-form `content` into scalar text before reaching llama-server. The system SHALL proxy to llama-server at the configured `:8080` address via http-proxy-middleware.

(Previously: Normalized payloads for llama-swap; now targets llama-server directly)

#### Scenario: Developer role reaches system

- GIVEN a message with role `developer` and scalar string content
- WHEN the payload is sanitized for llama-server
- THEN the outbound role is `system` and content is unchanged

#### Scenario: Array content is flattened

- GIVEN a message whose `content` is an array of text parts
- WHEN the payload is sanitized for llama-server
- THEN array content is flattened to a single concatenated string

### Requirement: Catch path emits a single terminal SSE chunk

On an error thrown mid-stream, the pipeline MUST NOT emit both a terminal chunk and a duplicate error payload.

(Previously: Same invariant; unchanged behavior)

#### Scenario: Error yields one terminal chunk

- GIVEN a stream that raises after the final chunk has been sent
- WHEN the catch block executes
- THEN exactly one terminal SSE chunk is emitted and no contradictory error payload follows

### Requirement: Outbound params never contain NaN

`temperature`, `top_p`, and `max_tokens` MUST NOT be sent as `NaN` in the outbound payload when input values are missing or non-numeric.

(Previously: Same invariant; unchanged behavior)

#### Scenario: Non-numeric temperature defaults safely

- GIVEN a request whose `temperature` is missing or non-numeric
- WHEN the payload is sanitized for llama-server
- THEN outbound `temperature` is a finite numeric default, never NaN

#### Scenario: Non-numeric top_p and max_tokens default safely

- GIVEN a request whose `top_p` and/or `max_tokens` are non-numeric
- WHEN the payload is sanitized for llama-server
- THEN the outbound values are finite numeric defaults, never NaN

### Requirement: Streaming passes the resolved config to the backend

The streaming function SHALL be called with the resolved provider config as its first argument from every streaming call site. The config SHALL reference the llama-server backend host/port, not the removed llama-swap binary.

(Previously: Streaming passed config referencing `config.llamaSwap.host` for the llama-swap binary)

#### Scenario: Streaming call uses llama-server config

- GIVEN a streaming chat completion through a pipeline
- WHEN the final-stage stream is opened
- THEN the resolved config points to the llama-server backend address
- AND streaming reaches llama-server instead of the removed llama-swap binary

## REMOVED Requirements

### Requirement: llama-swap process management

(Reason: The rewrite drops llama-swap entirely; llama-server owns process/model management.)
(Migration: All references to `config.llamaSwap` replaced with `config.llamaServer` pointing to llama-server at `:8080`.)
