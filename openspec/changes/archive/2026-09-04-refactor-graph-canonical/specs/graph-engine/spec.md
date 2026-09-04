# Delta for Graph Engine

## MODIFIED Requirements

### Requirement: Hybrid execution selection

The system SHALL execute ALL pipelines — linear and complex — through a single graph engine. There SHALL be no hybrid selector or linear engine dispatch. A pipeline with a single sequential path and a pipeline with conditionals and branches SHALL both execute via `runGraphEngine`.
(Previously: Linear-compatible graphs ran on `runChain`; complex graphs ran on the graph engine; selection was automatic.)

#### Scenario: Linear graph runs on the graph engine

- GIVEN a graph that reduces to a single sequential path with no conditionals or branches
- WHEN it is invoked
- THEN it executes on the graph engine (not on a separate linear engine)

#### Scenario: Complex graph runs on the graph engine

- GIVEN a graph containing a `condition` node and multiple branches
- WHEN it is invoked
- THEN it executes on the graph engine

#### Scenario: No hybrid selector exists

- GIVEN the codebase after refactor
- WHEN `hybrid-selector.ts`, `isLinearCompatible`, and `graphToParsedChain` are searched
- THEN none of these artifacts exist

### Requirement: Node types

The graph engine SHALL support node types `start`, `end`, `llm_call`, `condition` (if-else), `loop`, and `pipeline`, each with its required fields validated at admission. The `llm_call` node type SHALL support optional fields `on_429`, `tool_calls_route`, `mode`, `system`, `assistant`, `user`, `pos`, `ctx`, and `condition`.
(Previously: Node types were `start`, `end`, `llm_call`, `condition`, `loop` — without `pipeline`, `on_429`, `tool_calls_route`, or `mode`.)

#### Scenario: Every node type is executable

- GIVEN a graph containing each supported node type
- WHEN it is invoked
- THEN each node executes according to its type semantics

#### Scenario: on_429 field routes on rate limit

- GIVEN an `llm_call` node with `on_429: "fallback_node"`
- WHEN the LLM call returns HTTP 429
- THEN execution routes to `fallback_node` instead of failing

#### Scenario: tool_calls_route field routes on tool calls

- GIVEN an `llm_call` node with `tool_calls_route: "tool_handler"`
- WHEN the LLM response includes non-empty `tool_calls`
- THEN execution routes to `tool_handler` instead of the next sequential node

#### Scenario: mode field controls message construction

- GIVEN an `llm_call` node with `mode: "refine"` and a `ctx` field
- WHEN the node executes
- THEN `buildStepMessages` constructs the message payload using the previous step's `lastContent` as context

### Requirement: Message refeed in graph engine

The graph engine SHALL use `buildStepMessages` to construct the message payload for each `llm_call` step. For `refine` mode nodes, the engine SHALL refeed `GraphState.lastContent` as context input. The payload SHALL include the full message array, not just `{model, stream: false}`.
(Previously: `payloadFor` sent only `{model, stream: false}` with no messages, causing empty intermediate requests.)

#### Scenario: generate mode sends full messages

- GIVEN an `llm_call` node with `mode: "generate"` and a messages array in the request
- WHEN the node executes
- THEN `buildStepMessages` produces the message payload and the LLM receives the full messages

#### Scenario: refine mode refeeds previous content

- GIVEN an `llm_call` node with `mode: "refine"` and `GraphState.lastContent` containing prior output
- WHEN the node executes
- THEN `buildStepMessages` includes `lastContent` as context and the LLM receives the enriched payload

## REMOVED Requirements

### Requirement: (none removed — all existing requirements retained)

## ADDED Requirements

### Requirement: Conditional edge routing for on_429 and tool_calls_route

The graph engine SHALL evaluate `on_429` and `tool_calls_route` as conditional edges after each `llm_call` step. When the LLM response status is 429 and `on_429` is set, the engine SHALL follow the named fallback node. When the response contains `tool_calls` and `tool_calls_route` is set, the engine SHALL follow the named route node. Both checks SHALL be evaluated via the existing AST condition evaluator.
(Previously: These fields did not exist on graph nodes; fallback routing was only available in the linear engine.)

#### Scenario: on_429 triggers fallback edge

- GIVEN a graph where node A has `on_429: "fallback"` and node B is the sequential successor
- WHEN the LLM call at A returns 429
- THEN node B is skipped and execution continues at `fallback`

#### Scenario: tool_calls_route triggers tool edge

- GIVEN a graph where node A has `tool_calls_route: "executor"` and node B is the sequential successor
- WHEN the LLM call at A returns tool_calls in the response
- THEN node B is skipped and execution continues at `executor`

#### Scenario: Neither condition fires when not applicable

- GIVEN a graph where node A has `on_429: "fallback"` and `tool_calls_route: "executor"`
- WHEN the LLM call at A returns 200 with no tool_calls
- THEN execution continues to the sequential successor node B

### Requirement: Composition node execution

The graph engine SHALL support `pipeline` nodes that invoke another registered pipeline by name. The invoked pipeline's final output SHALL become the invoker's `lastResponse`. Composition depth SHALL be bounded (default 5). The `getPipeline` lookup SHALL resolve from the unified `graphMap` registry.
(Previously: composition was dead code — `getPipeline` returned `undefined` and the graph engine had no `pipeline` case in `walk`.)

#### Scenario: pipeline node invokes registered pipeline

- GIVEN a graph with a `pipeline` node referencing pipeline "thinker"
- WHEN execution reaches the `pipeline` node
- THEN "thinker" is resolved from the registry and executed; its output becomes `lastResponse`

#### Scenario: pipeline node exceeding depth fails

- GIVEN a pipeline that recursively invokes itself beyond depth 5
- WHEN composition depth is exceeded
- THEN execution fails with a clear depth-exceeded error

#### Scenario: Unregistered pipeline name fails at admission

- GIVEN a `pipeline` node referencing "nonexistent"
- WHEN admission validation runs
- THEN the pipeline is rejected with an error naming the unresolved reference
