# Delta for Pipeline Orchestration

## MODIFIED Requirements

### Requirement: Chain configuration format

The system SHALL load pipeline definitions from JSON or YAML config files. Each pipeline SHALL define a list of `nodes` and `edges` forming a directed graph, where each node specifies a type, a provider/model target, and optional conditional routing. The `steps` array format SHALL be removed from the schema.
(Previously: Chains defined an ordered `steps` array; nodes/edges were stripped by zod on apply.)

#### Scenario: Valid graph config loads successfully

- GIVEN a config file containing a pipeline with 3 nodes and 2 edges
- WHEN the system starts
- THEN the pipeline is registered and each node's provider/model mapping is resolved

#### Scenario: steps array is rejected

- GIVEN a config file with a chain using `steps` instead of `nodes`/`edges`
- WHEN schema validation runs
- THEN validation fails with a clear error indicating `steps` is no longer accepted

#### Scenario: Invalid graph config fails startup

- GIVEN a config file with a pipeline referencing a non-existent provider
- WHEN the system starts
- THEN the system logs an error and refuses to serve that pipeline

### Requirement: Sequential step execution

The system SHALL execute pipeline nodes in graph order as defined by edges. Each node SHALL receive the previous node's response as input context. The final node's response SHALL be returned to the client. ALL pipelines — linear and complex — execute through the graph engine; there is no linear engine dispatch.
(Previously: Linear chains executed via `runChain`; complex graphs delegated to the graph engine.)

#### Scenario: Three-node pipeline executes in order

- GIVEN a pipeline with nodes A → B → C via edges
- WHEN the pipeline is invoked
- THEN node B receives A's response, node C receives B's response, and the client receives C's output

#### Scenario: Node failure stops the pipeline

- GIVEN a pipeline with nodes A → B → C
- WHEN node B returns a non-2xx response
- THEN node C is not executed and the error is returned to the client

### Requirement: Conditional routing on 429 status

The system SHALL support a fallback node triggered when an `llm_call` node returns HTTP 429. The fallback SHALL be specified per node via an `on_429` field naming the target node. This routing SHALL be implemented as a conditional edge in the graph engine.
(Previously: `on_429` was a step-level field evaluated by the linear engine only.)

#### Scenario: 429 triggers fallback node

- GIVEN a pipeline where node A has `on_429: "fallback"`
- WHEN node A returns HTTP 429
- THEN the system executes `fallback` instead of aborting

#### Scenario: Non-429 error does not trigger fallback

- GIVEN a pipeline where node A has `on_429: "fallback"`
- WHEN node A returns HTTP 500
- THEN `fallback` is NOT executed and the error propagates

### Requirement: Conditional routing on tool_calls in response

The system SHALL support routing based on whether an `llm_call` node response contains `tool_calls`. A node MAY specify a `tool_calls_route` field naming the next node to execute when tool_calls are present.
(Previously: `tool_calls_route` was a step-level field in the linear engine only.)

#### Scenario: tool_calls route activated

- GIVEN a node with `tool_calls_route: "tool_handler"`
- WHEN the node response includes a non-empty `tool_calls` array
- THEN the system executes `tool_handler` next

#### Scenario: No tool_calls continues normal flow

- GIVEN a node with `tool_calls_route: "tool_handler"`
- WHEN the node response has no `tool_calls` or an empty array
- THEN the system continues to the next sequential node

### Requirement: Context passing between steps

The system SHALL pass the full response body of each node to the next node as context via `GraphState.lastResponse`/`lastContent`. The engine SHALL NOT lose or truncate intermediate results. A failed node SHALL record a failed execution available for manual retry.
(Previously: context passing existed in the linear engine; now it is unified in the graph engine via `GraphState`.)

#### Scenario: Large context survives full pipeline

- GIVEN a pipeline where node A produces a 4KB response
- WHEN node B is invoked
- THEN node B receives the complete 4KB response as its input context

### Requirement: Runtime-reloadable chain registry

The system MUST expose pipelines through a mutable in-memory registry backed by a single `graphMap` (`Map<string, GraphPipeline>`). There SHALL be no `chainMap`, `ParsedChain`, or union surface. The registry SHALL support an atomic `reload()` that recompiles and validates all pipelines and swaps the active reference only when every pipeline validates successfully.
(Previously: Registry maintained both `chainMap` and `graphMap` with a union `asMap` surface.)

#### Scenario: Apply swaps the active registry without restart

- GIVEN a running gateway with a mutable registry and a valid new pipeline draft
- WHEN an apply calls `reload()` with the built pipelines
- THEN the new pipeline becomes available under `gateway/<name>` immediately with no process restart

#### Scenario: Failed reload keeps the previous registry

- GIVEN a running gateway with pipeline `A`, and an apply that yields an invalid pipeline `B`
- WHEN `reload()` fails to validate `B`
- THEN pipeline `A` remains active, pipeline `B` is not served, and the error is returned without swapping the registry

### Requirement: Atomic graph/AST admission gate

The system MUST admit a pipeline only after graph and condition-AST validation succeeds. ALL pipelines — linear-compatible and complex — are routed to the graph engine. There SHALL be no `ParsedChain` or linear-engine route. Unsafe conditions (any `eval`/`new Function`/URL/file/network access) MUST be rejected at admission.
(Previously: Linear-compatible graphs produced `ParsedChain` for the linear engine; complex graphs routed to the graph engine.)

#### Scenario: Simple linear pipeline routes to graph engine

- GIVEN a draft whose graph is a single sequential path with no branches
- WHEN validation and admission run
- THEN the pipeline is admitted and executed by the graph engine (not a linear engine)

#### Scenario: Complex graph with a condition routes to graph engine

- GIVEN a draft with a `condition` node and multiple branches
- WHEN the pipeline is admitted and invoked
- THEN it executes on the graph engine

#### Scenario: Unsafe AST condition is rejected

- GIVEN a draft whose condition uses `eval`/`new Function` or references a URL/file/network target
- WHEN the pipeline is validated
- THEN admission fails with a normalized error and the pipeline is not registered

### Requirement: Streaming on the final executed step

The system SHALL stream only the LAST node of the executed path with a single terminal chunk, and MUST NOT buffer or transform `/v1/*` streams. Intermediate nodes of a complex graph SHALL run non-streaming to the client and emit progress events (`step:*`).
(Previously: same behavior; retained as-is for reference.)

#### Scenario: Linear pipeline streams only the final node

- GIVEN a linear pipeline requested with `stream: true`
- WHEN the pipeline is invoked
- THEN only the last node streams to the client with exactly one terminal `[DONE]` chunk

#### Scenario: Complex graph streams only the last node of the executed path

- GIVEN a complex pipeline requested with `stream: true` whose executed path has three nodes
- WHEN the pipeline runs
- THEN the first two nodes run non-streaming and emit `step:*` progress events, and only the third node streams

#### Scenario: /v1/* streams are never buffered or transformed

- GIVEN an inbound `/v1/*` streaming request
- WHEN the gateway passes it through
- THEN the upstream SSE body is relayed unbuffered with no re-encoding or transformation
