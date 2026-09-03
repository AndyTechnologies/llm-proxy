# Delta for Pipeline Orchestration

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Sequential step execution

The system SHALL execute chain steps in order. Each step SHALL receive the previous step's response as input context. The final step's response SHALL be returned to the client. When a pipeline is a complex graph, execution SHALL instead be delegated to the graph engine, which propagates `lastResponse`/`variables` along the executed branch.
(Previously: only linear sequential steps with context refeed; no graph delegation.)

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

### Requirement: Context passing between steps

The system SHALL pass the full response body of each step to the next step as context. The engine SHALL NOT lose or truncate intermediate results. For complex graphs, the executed branch SHALL carry a `lastResponse` that becomes the invoked pipeline's output, and a failed step SHALL record a failed execution available for manual retry.

#### Scenario: Large context survives full chain

- GIVEN a chain where step A produces a 4KB response
- WHEN step B is invoked
- THEN step B receives the complete 4KB response as its input context

### Requirement: Streaming on the final executed step

The system SHALL stream only the LAST step of the executed path with a single terminal chunk, and MUST NOT buffer or transform `/v1/*` streams. Intermediate steps of a complex graph SHALL run non-streaming to the client and emit progress events (`step:*`).
(Previously: only the last linear step streamed; no progress events, no complex-path streaming.)

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

## REMOVED Requirements

(none)

## RENAMED Requirements

(none)
