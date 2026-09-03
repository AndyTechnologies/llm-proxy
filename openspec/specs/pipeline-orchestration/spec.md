# Pipeline Orchestration Specification

## Purpose

Configurable chain engine that runs sequential steps with conditional logic, context passing between steps, 429 fallback routing, runtime-reloadable chain registry, atomic graph/AST admission, and streaming on the final executed step.

## Requirements

### Requirement: Chain configuration format

The system SHALL load chain definitions from JSON or YAML config files. Each chain SHALL define an ordered list of steps, where each step specifies a provider/model target and optional conditional routing.

#### Scenario: Valid chain config loads successfully

- GIVEN a config file containing a chain with 3 steps
- WHEN the system starts
- THEN the chain is registered and each step's provider/model mapping is resolved

#### Scenario: Invalid chain config fails startup

- GIVEN a config file with a chain referencing a non-existent provider
- WHEN the system starts
- THEN the system logs an error and refuses to serve that chain

### Requirement: Sequential step execution

The system SHALL execute chain steps in order. Each step SHALL receive the previous step's response as input context. The final step's response SHALL be returned to the client. When a pipeline is a complex graph, execution SHALL instead be delegated to the graph engine, which propagates `lastResponse`/`variables` along the executed branch.

#### Scenario: Three-step chain executes in order

- GIVEN a chain with steps A -> B -> C
- WHEN the chain is invoked
- THEN step B receives A's response, step C receives B's response, and the client receives C's output

#### Scenario: Step failure stops the chain

- GIVEN a chain with steps A -> B -> C
- WHEN step B returns a non-2xx response
- THEN step C is not executed and the error is returned to the client

#### Scenario: Complex pipeline delegates to the graph engine

- GIVEN a pipeline with a condition node and multiple branches
- WHEN the pipeline is invoked
- THEN execution runs on the graph engine and the executed branch's final output is returned

### Requirement: Conditional routing on 429 status

The system SHALL support a fallback step triggered when a step returns HTTP 429 (rate limited). The fallback SHALL be specified per step via an `on_429` field.

#### Scenario: 429 triggers fallback step

- GIVEN a chain where step A has `on_429: step_A_fallback`
- WHEN step A returns HTTP 429
- THEN the system executes `step_A_fallback` instead of aborting

#### Scenario: Non-429 error does not trigger fallback

- GIVEN a chain where step A has `on_429: step_A_fallback`
- WHEN step A returns HTTP 500
- THEN `step_A_fallback` is NOT executed and the error propagates

### Requirement: Conditional routing on tool_calls in response

The system SHALL support routing based on whether the step response contains `tool_calls`. A step MAY specify a `tool_calls_route` field naming the next step to execute when tool_calls are present.

#### Scenario: tool_calls route activated

- GIVEN a step with `tool_calls_route: "tool_handler"`
- WHEN the step response includes a non-empty `tool_calls` array
- THEN the system executes `tool_handler` next

#### Scenario: No tool_calls continues normal flow

- GIVEN a step with `tool_calls_route: "tool_handler"`
- WHEN the step response has no `tool_calls` or an empty array
- THEN the system continues to the next sequential step

### Requirement: Context passing between steps

The system SHALL pass the full response body of each step to the next step as context. The engine SHALL NOT lose or truncate intermediate results. For complex graphs, the executed branch SHALL carry a `lastResponse` that becomes the invoked pipeline's output, and a failed step SHALL record a failed execution available for manual retry.

#### Scenario: Large context survives full chain

- GIVEN a chain where step A produces a 4KB response
- WHEN step B is invoked
- THEN step B receives the complete 4KB response as its input context

### Requirement: Runtime-reloadable chain registry

The system MUST expose chains through a mutable in-memory registry that keeps a `Map<string, ParsedChain>`-compatible surface. The registry SHALL support an atomic `reload()` that recompiles and validates all chains and swaps the active reference only when every chain validates successfully.

#### Scenario: Apply swaps the active registry without restart

- GIVEN a running gateway with a mutable registry and a valid new chain draft
- WHEN an apply calls `reload()` with the built chains
- THEN the new chain becomes available under `gateway/<name>` immediately with no process restart

#### Scenario: Failed reload keeps the previous registry

- GIVEN a running gateway with chain `A`, and an apply that yields an invalid chain `B`
- WHEN `reload()` fails to validate `B`
- THEN chain `A` remains active, chain `B` is not served, and the error is returned without swapping the registry

### Requirement: Atomic graph/AST admission gate

The system MUST admit a pipeline only after graph and condition-AST validation succeeds. A pipeline whose graph is linear-compatible SHALL be served as a `ParsedChain` for the linear engine; a pipeline with conditionals and multiple branches SHALL be routed to the graph engine. Unsafe conditions (any `eval`/`new Function`/URL/file/network access) MUST be rejected at admission.

#### Scenario: Linear-compatible graph routes to the linear engine

- GIVEN an editor draft whose graph reduces to a single sequential step path with no branches
- WHEN validation and admission run
- THEN the pipeline is served as a `ParsedChain` and executed by the existing `runChain` linear engine

#### Scenario: Complex graph with a condition routes to the graph engine

- GIVEN a draft with a `condition` node and multiple branches
- WHEN the pipeline is admitted and invoked
- THEN it executes on the graph engine, not the linear engine

#### Scenario: Unsafe AST condition is rejected

- GIVEN a draft whose condition uses `eval`/`new Function` or references a URL/file/network target
- WHEN the pipeline is validated
- THEN admission fails with a normalized error and the pipeline is not registered

### Requirement: Streaming on the final executed step

The system SHALL stream only the LAST step of the executed path with a single terminal chunk, and MUST NOT buffer or transform `/v1/*` streams. Intermediate steps of a complex graph SHALL run non-streaming to the client and emit progress events (`step:*`).

#### Scenario: Linear chain streams only the final step

- GIVEN a linear chain requested with `stream: true`
- WHEN the chain is invoked
- THEN only the last step streams to the client with exactly one terminal `[DONE]` chunk

#### Scenario: Complex graph streams only the last step of the executed path

- GIVEN a complex pipeline requested with `stream: true` whose executed path has three steps
- WHEN the pipeline runs
- THEN the first two steps run non-streaming and emit `step:*` progress events, and only the third step streams

#### Scenario: /v1/* streams are never buffered or transformed

- GIVEN an inbound `/v1/*` streaming request
- WHEN the gateway passes it through
- THEN the upstream SSE body is relayed unbuffered with no re-encoding or transformation
