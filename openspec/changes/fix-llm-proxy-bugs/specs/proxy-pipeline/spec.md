# Delta for proxy-pipeline

## Non-Regression Specification

The proposal (fix-llm-proxy-bugs) declares **New Capabilities: None** and **Modified Capabilities: None**. All four fixes restore already-expected behavior that regressed — no new, modified, removed, or renamed requirements exist at the contract level, and no main spec exists to delta against (openspec/specs/ is empty). This delta therefore carries no `## ADDED/MODIFIED/REMOVED/RENAMED Requirements` sections.

Instead it locks down the **non-regression invariants** the fixes must preserve. These are testable quality/behavior gates for apply and verify; none introduces externally observable contract change.

## Invariants

### Invariant: Streaming produces valid SSE without ReferenceError

The streaming pipeline MUST complete a chat/completions request without throwing a `ReferenceError` from pipeline scope.

#### Scenario: Streaming completes cleanly

- GIVEN an OpenAI-compatible streaming request through `runPipelineStream`
- WHEN the stream runs to normal completion
- THEN the response is a valid SSE stream with no `ReferenceError` raised

#### Scenario: Terminal chunk marks finish reason

- GIVEN a streaming request that reaches a finish reason
- WHEN the pipeline assigns `finishReasonRecibido`
- THEN the variable is declared and readable in `runPipelineStream` scope

### Invariant: Request payload is normalized for llama.cpp

The outbound payload MUST normalize `developer` roles to `system` and flatten array-form `content` into scalar text before reaching llama.cpp.

#### Scenario: Developer role reaches system

- GIVEN a message with role `developer` and scalar string content
- WHEN the payload is sanitized for llama.cpp
- THEN the outbound role is `system` and content is unchanged

#### Scenario: Array content is flattened

- GIVEN a message whose `content` is an array of `{type:"text",text:"..."}` parts and/or plain strings
- WHEN the payload is sanitized for llama.cpp
- THEN array content is flattened to a single concatenated string with no grammar parse failure

### Invariant: Catch path emits a single terminal SSE chunk

On an error thrown mid-stream, the pipeline MUST NOT emit both a terminal chunk and a duplicate error payload.

#### Scenario: Error yields one terminal chunk

- GIVEN a stream that raises after `enviarChunkFinal()` has sent the final chunk
- WHEN the catch block executes
- THEN exactly one terminal SSE chunk is emitted and no contradictory error payload follows

### Invariant: Outbound params never contain NaN

`temperature`, `top_p`, and `max_tokens` MUST NOT be sent as `NaN` in the outbound payload when input values are missing or non-numeric.

#### Scenario: Non-numeric temperature defaults safely

- GIVEN a request whose `temperature` is missing or non-numeric
- WHEN the payload is sanitized for llama.cpp
- THEN outbound `temperature` is a finite numeric default, never `NaN`

#### Scenario: Non-numeric top_p and max_tokens default safely

- GIVEN a request whose `top_p` and/or `max_tokens` are non-numeric
- WHEN the payload is sanitized for llama.cpp
- THEN the outbound values are finite numeric defaults, never `NaN`

## Rules Applied

- Given/When/Then scenarios and RFC 2119 keywords per `openspec/config.yaml rules.specs`.
- No requirements invented beyond proposal scope (Success Criteria, Scope).