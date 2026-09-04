# Delta for Pipeline Composition

## MODIFIED Requirements

### Requirement: Pipeline invocation as a step

A pipeline SHALL be able to invoke another pre-defined pipeline by name as a `pipeline` node. The invoked pipeline's final output SHALL become the invoker's `lastResponse`. The `getPipeline` lookup SHALL resolve from the unified `graphMap` registry; `getPipeline` SHALL NOT return `undefined` for registered pipelines.
(Previously: composition was dead code — `getPipeline` was passed as `()=>undefined` and the graph engine had no `pipeline` case in `walk`.)

#### Scenario: Invoked pipeline's output feeds the invoker

- GIVEN pipeline P1 has a `pipeline` node referencing pre-defined pipeline P2
- WHEN P1 executes
- THEN P2 runs to completion and its final output becomes P1's `lastResponse` for downstream nodes

#### Scenario: Unregistered pipeline name is rejected at admission

- GIVEN P1 has a `pipeline` node referencing "nonexistent"
- WHEN admission validation runs
- THEN admission fails with an error naming the unresolved pipeline reference

### Requirement: Bounded composition depth

Composition SHALL be bounded by a maximum depth (default 5). Exceeding the maximum SHALL fail with a clear error; the gateway SHALL NOT recurse without bound. The depth check SHALL be enforced both at admission and at runtime.
(Previously: depth validation existed but was dead code in runtime execution.)

#### Scenario: Composition within depth runs

- GIVEN a nesting of invocations at depth 3 (default max 5)
- WHEN P1 executes
- THEN the nested invocations run successfully

#### Scenario: Composition exceeding depth fails clearly

- GIVEN a nesting of invocations at depth 6 (default max 5)
- WHEN execution reaches the limit
- THEN execution fails with a clear depth-exceeded error and no infinite recursion occurs

### Requirement: Input parameters to the invoked pipeline

The invoking pipeline SHALL be able to pass input parameters/variables into the invoked pipeline via the `params` field on the `pipeline` node.
(Previously: parameter passing existed in spec but was not wired in runtime.)

#### Scenario: Parameters propagate into the invoked pipeline

- GIVEN P1 invokes P2 with `params: {topic: "x"}`
- WHEN P2 starts
- THEN P2 can read `topic` from its input variables

### Requirement: Depth validation at admission

Composition depth SHALL be validated at graph/pipeline admission so that an over-deep composition is rejected before it can run.
(Previously: admission existed but composition was dead code.)

#### Scenario: Over-deep composition is rejected at admission

- GIVEN a pipeline whose composition depth exceeds the maximum
- WHEN it is validated
- THEN admission fails with a clear error and the pipeline is not registered
