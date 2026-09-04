# Graph Engine Specification

## Purpose

Runtime execution of all pipelines as directed graphs — including sequential, conditional, parallel, looping, and composable pipelines — using a safe AST interpreter and a single unified graph engine (`runGraphEngine`).

## Requirements

### Requirement: Unified graph execution

The system SHALL execute ALL pipelines — linear and complex — through a single graph engine (`runGraphEngine`). There SHALL be no hybrid selector or linear engine dispatch. A pipeline with a single sequential path and a pipeline with conditionals and branches SHALL both execute via `runGraphEngine`.

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

### Requirement: Node fields for llm_call

Each `llm_call` node SHALL support the following optional fields: `on_429` (429 fallback target node id), `tool_calls_route` (tool_calls reroute target node id), `ctx` (per-node context window override passed as `params.ctx`), `mode` (`generate`/`refine`/`passthrough`), `system`/`assistant` (message scaffolds).

#### Scenario: on_429 triggers fallback on HTTP 429

- GIVEN an `llm_call` node with `on_429: "fallback"`
- WHEN the provider throws a 429 error
- THEN execution reroutes to the `fallback` node

#### Scenario: tool_calls_route reroutes when tool_calls present

- GIVEN an `llm_call` node with `tool_calls_route: "handler"`
- WHEN the response contains non-empty `tool_calls`
- THEN execution reroutes to the `handler` node instead of following the normal edge

#### Scenario: ctx override passes context window to the provider

- GIVEN an `llm_call` node with `ctx: 4096`
- WHEN the node is invoked
- THEN `params.ctx` is set to 4096 on the payload sent to the provider

### Requirement: Message refeed in graph engine

The graph engine SHALL use `buildStepMessages` to construct the message payload for each `llm_call` step. For `refine` mode nodes, the engine SHALL refeed `GraphState.lastContent` as context input. The payload SHALL include the full message array, not just `{model, stream: false}`.

#### Scenario: generate mode sends full messages

- GIVEN an `llm_call` node with `mode: "generate"` and a messages array in the request
- WHEN the node executes
- THEN `buildStepMessages` produces the message payload and the LLM receives the full messages

#### Scenario: refine mode refeeds previous content

- GIVEN an `llm_call` node with `mode: "refine"` and `GraphState.lastContent` containing prior output
- WHEN the node executes
- THEN `buildStepMessages` includes `lastContent` as context and the LLM receives the enriched payload

### Requirement: Conditional edge routing for on_429 and tool_calls_route

The graph engine SHALL evaluate `on_429` and `tool_calls_route` as conditional edges after each `llm_call` step. When the LLM response status is 429 and `on_429` is set, the engine SHALL follow the named fallback node. When the response contains `tool_calls` and `tool_calls_route` is set, the engine SHALL follow the named route node.

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

### Requirement: Sequential-guarded branch semantics

Branching SHALL default to sequential-guarded: exactly one branch is chosen by its condition and the chosen branch propagates `lastResponse`/`variables` forward.

#### Scenario: Only the matching branch executes

- GIVEN a `condition` node with branch X guarded by a true condition and branch Y guarded by a false condition
- WHEN execution reaches the condition
- THEN branch X executes and branch Y does not

#### Scenario: Executed branch's output propagates forward

- GIVEN a branch whose final step sets `lastResponse`
- WHEN that branch completes
- THEN `lastResponse` is carried forward to the downstream nodes

### Requirement: Parallel opt-in with explicit join

The graph engine SHALL run a subgraph in parallel only when it is explicitly marked for parallel execution, and SHALL recombine the branches at an explicit `join` node.

#### Scenario: Marked subgraph runs branches in parallel and joins

- GIVEN a subgraph explicitly marked parallel with branch A and branch B and a `join`
- WHEN execution reaches the subgraph
- THEN branches A and B run concurrently and their outputs recombine at the join

#### Scenario: Unmarked subgraph runs sequentially

- GIVEN a subgraph with two branches not marked for parallel
- WHEN execution reaches the subgraph
- THEN the two branches do not run concurrently; only the guarded path proceeds

### Requirement: Safe AST condition evaluation

Condition expressions SHALL be evaluated only through a typed AST interpreter supporting `compare`, `logical` (AND/OR), `not`, and `exists`, over the minimal context `lastResponse.status`, `lastResponse.content`, `error`, and `variables`. The interpreter MUST forbid `eval`/`new Function` and MUST NOT allow URL, file, or network access.

#### Scenario: AST compare decides a branch

- GIVEN a condition `compare(lastResponse.status, "==", 200)`
- WHEN the last step returns status 200
- THEN the AST evaluates true and the corresponding branch runs

#### Scenario: Logical AND/OR and not combine conditions

- GIVEN a condition `logical(AND, [compare(...), not(exists(error))])`
- WHEN both sub-terms are satisfied
- THEN the AST evaluates true

#### Scenario: Unsafe AST usage is rejected

- GIVEN a condition attempting `eval`/`new Function` or referencing a URL/file/network target
- WHEN it is validated
- THEN evaluation/validation fails and the pipeline is not admitted

### Requirement: Loop execution

The graph engine SHALL bound loop execution and treat loop boundaries as valid cycles in validation.

#### Scenario: Loop iterates within its boundary

- GIVEN a `loop` node over a bounded subgraph
- WHEN it executes
- THEN the body runs for the specified iterations and then exits the loop

#### Scenario: Unbounded loop is prevented

- GIVEN a loop without a terminating condition
- WHEN execution reaches it
- THEN execution stops with an error to prevent an infinite cycle

### Requirement: Manual retry of failed llm_call steps

The graph engine SHALL allow manual retry of a failed `llm_call` step (max 1 retry/step), non-streaming, storing the retried result.

#### Scenario: Failed llm_call step is retried once

- GIVEN a failed execution whose `llm_call` step A failed
- WHEN a manual retry is issued for step A
- THEN one non-streaming retry runs and its result is stored

### Requirement: Single-terminal streaming on the executed path

The graph engine SHALL run intermediate steps non-streaming to the client while emitting `step:*` progress events, and SHALL stream only the LAST step of the executed path with exactly one terminal chunk. It MUST NOT buffer or transform `/v1/*` streams.

#### Scenario: Executed path streams only its final step

- GIVEN a complex pipeline requested with `stream: true` whose executed path has steps S1, S2, S3
- WHEN the pipeline runs
- THEN S1 and S2 run non-streaming and emit `step:*` events, and only S3 streams with one terminal chunk
