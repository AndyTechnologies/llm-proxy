# Pipeline Orchestration Specification

## Purpose

Configurable graph engine that runs pipeline graphs with sequential nodes, conditional logic, 429 fallback routing, tool_calls rerouting, context passing between nodes, runtime-reloadable pipeline registry, atomic graph/AST admission, composition with bounded depth, and streaming on the final executed node.

## Requirements

### Requirement: Chain configuration format

The system SHALL load pipeline definitions from JSON or YAML config files. Each pipeline SHALL define a list of `nodes` and `edges` forming a directed graph, where each node specifies a type, a provider/model target, and optional conditional routing. The `steps` array format SHALL be removed from the schema.

#### Scenario: Valid graph config loads successfully

- GIVEN a config file containing a pipeline with 3 nodes and 2 edges
- WHEN the system starts
- THEN the pipeline is registered and each node's provider/model mapping is resolved

#### Scenario: steps array is rejected

- GIVEN a config file with a chain using `steps` instead of `nodes`/`edges`
- WHEN schema validation runs
- THEN validation fails with a clear error indicating `steps` is no longer accepted

#### Scenario: Invalid graph config fails startup

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

The system MUST expose pipelines through a mutable in-memory registry backed by a single `graphMap` (`Map<string, GraphPipeline>`). There SHALL be no `chainMap`, `ParsedChain`, or union surface. The registry SHALL support an atomic `reload()` that recompiles and validates all pipelines and swaps the active reference only when every pipeline validates successfully.

#### Scenario: Apply swaps the active registry without restart

- GIVEN a running gateway with a mutable registry and a valid new pipeline draft
- WHEN an apply calls `reload()` with the built graphs
- THEN the new pipeline becomes available under `gateway/<name>` immediately with no process restart

#### Scenario: Failed reload keeps the previous registry

- GIVEN a running gateway with pipeline `A`, and an apply that yields an invalid pipeline `B`
- WHEN `reload()` fails to validate `B`
- THEN pipeline `A` remains active, pipeline `B` is not served, and the error is returned without swapping the registry

### Requirement: Atomic graph/AST admission gate

The system MUST admit a pipeline only after graph and condition-AST validation succeeds. ALL pipelines — linear-compatible and complex — are routed to the graph engine. There SHALL be no `ParsedChain` or linear-engine route. Unsafe conditions (any `eval`/`new Function`/URL/file/network access) MUST be rejected at admission.

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

### Requirement: Streaming on the final executed node

The system SHALL stream only the LAST node of the executed path with a single terminal chunk, and MUST NOT buffer or transform `/v1/*` streams. Intermediate nodes of a complex graph SHALL run non-streaming to the client and emit progress events (`step:*`).

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

### Requirement: Named-provider targeting on llm_call

The system SHALL resolve an `llm_call` node's execution provider from its `provider` field, falling back to the chain-level `defaultProvider` (or `provider`), and to the local llama-server when neither is set. When the resolved provider is an external provider from the `providers` config section, the node SHALL execute against that external API with the node's `model`. When the resolved provider is the local backend, execution SHALL remain on the managed llama-server fetch path.

#### Scenario: Node targets a configured external provider

- GIVEN a node with `provider: "external-a"` and `model: "m1"` and `providers.external-a` configured
- WHEN the graph engine executes the node
- THEN the call goes to external-a's baseURL with model `m1`

#### Scenario: Chain default resolves the external provider

- GIVEN a chain with `defaultProvider: "external-a"` and a node without `provider`
- WHEN the graph engine executes the node
- THEN the node executes against external-a

#### Scenario: No provider configured keeps the local path

- GIVEN a node without `provider` and a chain without provider defaults
- WHEN the graph engine executes the node
- THEN the call goes to the local llama-server exactly as today

#### Scenario: External final node streams over the same contract

- GIVEN a graph requested with `stream: true` whose last executed node targets an external provider
- WHEN the graph runs
- THEN only that final node streams, with exactly one terminal chunk followed by `data: [DONE]`