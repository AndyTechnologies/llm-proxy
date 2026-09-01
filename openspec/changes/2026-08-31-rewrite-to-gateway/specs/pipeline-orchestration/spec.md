# Pipeline Orchestration Specification

## Purpose

Configurable chain engine that runs sequential steps with conditional logic, context passing between steps, and 429 fallback routing.

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

The system SHALL execute chain steps in order. Each step SHALL receive the previous step's response as input context. The final step's response SHALL be returned to the client.

#### Scenario: Three-step chain executes in order

- GIVEN a chain with steps A -> B -> C
- WHEN the chain is invoked
- THEN step B receives A's response, step C receives B's response, and the client receives C's output

#### Scenario: Step failure stops the chain

- GIVEN a chain with steps A -> B -> C
- WHEN step B returns a non-2xx response
- THEN step C is not executed and the error is returned to the client

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

The system SHALL pass the full response body of each step to the next step as context. The engine SHALL NOT lose or truncate intermediate results.

#### Scenario: Large context survives full chain

- GIVEN a chain where step A produces a 4KB response
- WHEN step B is invoked
- THEN step B receives the complete 4KB response as its input context
