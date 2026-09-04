# Graph Engine Specification

## Purpose

Runtime execution of all pipelines as directed graphs — including sequential, conditional, parallel, looping, and composable pipelines — using a safe AST interpreter and a single unified graph engine (`runGraphEngine`).

## Requirements

### Requirement: Unified graph execution

The system SHALL execute ALL pipelines through the graph engine (`runGraphEngine`). There is no separate linear engine. The graph engine traverses nodes following directed edges, propagating `lastResponse`/`variables` along the executed branch.

#### Scenario: Linear graph runs on the graph engine

- GIVEN a graph that reduces to a single sequential path with no conditionals or branches
- WHEN it is invoked
- THEN it executes on the graph engine and produces the expected output

#### Scenario: Complex graph runs on the graph engine

- GIVEN a graph containing a `condition` node and multiple branches
- WHEN it is invoked
- THEN it executes on the graph engine and the executed branch's output is returned

### Requirement: Node types

The graph engine SHALL support node types `start`, `end`, `llm_call`, `condition` (if-else), `loop`, `fan` (parallel opt-in), `join` (parallel recombine), and `pipeline` (composition invocation), each with its required fields validated at admission.

#### Scenario: Every node type is executable

- GIVEN a graph containing each supported node type
- WHEN it is invoked
- THEN each node executes according to its type semantics

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
