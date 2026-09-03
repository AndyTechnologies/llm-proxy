# Pipeline Composition Specification

## Purpose

Enabling a pipeline to invoke another pre-defined pipeline as a step, with bounded depth and input parameters, and with the invoked pipeline's output becoming the invoker's `lastResponse`.

## Requirements

### Requirement: Pipeline invocation as a step

A pipeline SHALL be able to invoke another pre-defined pipeline by name as a step. The invoked pipeline's final output SHALL become the invoker's `lastResponse`.

#### Scenario: Invoked pipeline's output feeds the invoker

- GIVEN pipeline P1 invokes pre-defined pipeline P2 in the middle of its path
- WHEN P1 executes
- THEN P2 runs to completion and its final output becomes P1's `lastResponse` for downstream steps

### Requirement: Bounded composition depth

Composition SHALL be bounded by a maximum depth (default 5). Exceeding the maximum SHALL fail with a clear error; the gateway SHALL NOT recurse without bound.

#### Scenario: Composition within depth runs

- GIVEN a nesting of invocations at depth 3 (default max 5)
- WHEN P1 executes
- THEN the nested invocations run successfully

#### Scenario: Composition exceeding depth fails clearly

- GIVEN a nesting of invocations at depth 6 (default max 5)
- WHEN execution reaches the limit
- THEN execution fails with a clear depth-exceeded error and no infinite recursion occurs

### Requirement: Input parameters to the invoked pipeline

The invoking pipeline SHALL be able to pass input parameters/variables into the invoked pipeline.

#### Scenario: Parameters propagate into the invoked pipeline

- GIVEN P1 invokes P2 with input parameters `{topic: "x"}`
- WHEN P2 starts
- THEN P2 can read `topic` from its input variables

### Requirement: Depth validation at admission

Composition depth SHALL also be validated at graph/pipeline admission so that an over-deep composition is rejected before it can run.

#### Scenario: Over-deep composition is rejected at admission

- GIVEN a pipeline whose composition depth exceeds the maximum
- WHEN it is validated
- THEN admission fails with a clear error and the pipeline is not registered
