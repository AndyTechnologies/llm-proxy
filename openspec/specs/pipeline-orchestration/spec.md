# Pipeline Orchestration Specification

## Purpose

Configurable graph engine that runs pipeline graphs with sequential nodes, conditional logic, 429 fallback routing, tool_calls rerouting, context passing between nodes, runtime-reloadable pipeline registry, atomic graph/AST admission, composition with bounded depth, and streaming on the final executed node.

## Requirements

### Requirement: Chain configuration format

The system SHALL load chain definitions from JSON or YAML config files. Each chain SHALL define a graph with ordered `nodes` and `edges`, where each node specifies a type (`start`, `end`, `llm_call`, `condition`, `loop`, `pipeline`, `fan`, `join`) and optional fields for provider/model targets, conditional routing, and context overrides.

#### Scenario: Valid chain config loads successfully

- GIVEN a config file containing a chain with nodes and edges
- WHEN the system starts
- THEN the chain is registered and each node's provider/model mapping is resolved

#### Scenario: Invalid chain config fails startup

- GIVEN a config file with a chain referencing a non-existent model
- WHEN the system starts
- THEN the system logs an error and refuses to serve that chain

### Requirement: Graph execution

The system SHALL execute all pipelines through the graph engine (`runGraphEngine`). The graph engine traverses nodes following directed edges, propagating `lastResponse`/`variables` along the executed branch. There is no separate linear engine; all execution is graph-native.

#### Scenario: Linear graph executes nodes in order

- GIVEN a graph with nodes start → A → B → end
- WHEN the graph is invoked
- THEN node B receives A's response, and the client receives B's output

#### Scenario: Node failure stops the graph

- GIVEN a graph with nodes A → B → C
- WHEN node B returns a non-2xx response or throws an error
- THEN node C is not executed and the error is returned to the client

#### Scenario: Complex graph with condition branches

- GIVEN a graph with a condition node and multiple branches
- WHEN the graph is invoked
- THEN the executed branch's final output is returned

### Requirement: Conditional routing on 429 status

The system SHALL support a fallback node triggered when an `llm_call` node's provider throws an HTTP 429 error. The fallback SHALL be specified per node via an `on_429` field naming the target node id.

#### Scenario: 429 triggers fallback node

- GIVEN an `llm_call` node A with `on_429: "fallback"`
- WHEN A's provider throws a 429 error
- THEN the system executes the `fallback` node instead of aborting

#### Scenario: Non-429 error does not trigger fallback

- GIVEN an `llm_call` node A with `on_429: "fallback"`
- WHEN A's provider throws a 500 error
- THEN `fallback` is NOT executed and the error propagates

### Requirement: Conditional routing on tool_calls in response

The system SHALL support routing based on whether an `llm_call` node's response contains `tool_calls`. A node MAY specify a `tool_calls_route` field naming the target node id to execute when tool_calls are present.

#### Scenario: tool_calls route activated

- GIVEN an `llm_call` node with `tool_calls_route: "tool_handler"`
- WHEN the node's response includes a non-empty `tool_calls` array
- THEN the system executes `tool_handler` next instead of following the normal edge

#### Scenario: No tool_calls continues normal flow

- GIVEN an `llm_call` node with `tool_calls_route: "tool_handler"`
- WHEN the node's response has no `tool_calls` or an empty array
- THEN the system continues to the next node via the normal edge

### Requirement: Context passing between nodes

The system SHALL pass the full response body of each `llm_call` node to the next node as `lastResponse`/`lastContent` context. The engine SHALL NOT lose or truncate intermediate results. A failed step SHALL record a failed execution available for manual retry.

#### Scenario: Large context survives full graph

- GIVEN a graph where node A produces a 4KB response
- WHEN node B is invoked
- THEN node B receives the complete 4KB response as its input context

### Requirement: Runtime-reloadable pipeline registry

The system MUST expose pipelines through a mutable in-memory registry (`PipelineRegistry`) storing `GraphPipeline` objects. The registry SHALL support an atomic `reload()` that validates all graphs and swaps the active reference only when every graph validates successfully.

#### Scenario: Apply swaps the active registry without restart

- GIVEN a running gateway with a mutable registry and a valid new pipeline draft
- WHEN an apply calls `reload()` with the built graphs
- THEN the new pipeline becomes available under `gateway/<name>` immediately with no process restart

#### Scenario: Failed reload keeps the previous registry

- GIVEN a running gateway with pipeline `A`, and an apply that yields an invalid pipeline `B`
- WHEN `reload()` fails to validate `B`
- THEN pipeline `A` remains active, pipeline `B` is not served, and the error is returned without swapping the registry

### Requirement: Atomic graph/AST admission gate

The system MUST admit a pipeline only after graph and condition-AST validation succeeds. All pipelines are served and executed as `GraphPipeline` objects through the graph engine. Unsafe conditions (any `eval`/`new Function`/URL/file/network access) MUST be rejected at admission.

#### Scenario: Valid graph is admitted

- GIVEN a draft with a valid acyclic graph and safe AST conditions
- WHEN validation and admission run
- THEN the pipeline is registered as a `GraphPipeline` and served by the graph engine

#### Scenario: Unsafe AST condition is rejected

- GIVEN a draft whose condition uses `eval`/`new Function` or references a URL/file/network target
- WHEN the pipeline is validated
- THEN admission fails with a normalized error and the pipeline is not registered

### Requirement: Streaming on the final executed node

The system SHALL stream only the LAST `llm_call` node of the executed path with a single terminal chunk, and MUST NOT buffer or transform `/v1/*` streams. Intermediate nodes of a complex graph SHALL run non-streaming to the client and emit progress events (`step:*`).

#### Scenario: Graph streams only the final step

- GIVEN a graph requested with `stream: true` whose executed path has three `llm_call` nodes
- WHEN the graph runs
- THEN the first two nodes run non-streaming and emit `step:*` events, and only the third node streams

#### Scenario: /v1/* streams are never buffered or transformed

- GIVEN an inbound `/v1/*` streaming request
- WHEN the gateway passes it through
- THEN the upstream SSE body is relayed unbuffered with no re-encoding or transformation
