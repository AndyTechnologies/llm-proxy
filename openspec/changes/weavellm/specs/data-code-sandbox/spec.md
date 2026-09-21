# Data & Code Sandbox Specification

## Purpose

Safe execution of user code in the `data.code` workflow node: isolated process, no network, temp-only filesystem, enforced timeout.

## Requirements

### Requirement: Isolated execution

`data.code` nodes SHALL execute in an isolated subprocess with no network access and a temp-only writable filesystem.

#### Scenario: Code runs isolated

- GIVEN a data.code node with valid code
- WHEN it executes
- THEN output is produced and written only within its temp sandbox

#### Scenario: Network attempt blocked

- GIVEN code attempting a network call
- WHEN it executes
- THEN the call fails inside the sandbox and the node reports the network denial

### Requirement: Host isolation

The sandbox MUST NOT expose the host filesystem, environment secrets, or host process memory.

#### Scenario: Host filesystem denied

- GIVEN code reading an absolute host path
- WHEN it executes
- THEN the read is denied by the sandbox

#### Scenario: Secrets not exposed

- GIVEN code enumerating environment variables
- WHEN it executes
- THEN only the minimal allowed env subset is visible and API keys are absent

### Requirement: Enforced timeout

The system MUST impose a configurable timeout on sandbox execution, killing runaway code and returning a timeout error to the workflow.

#### Scenario: Infinite loop killed

- GIVEN code that loops forever
- WHEN it executes
- THEN the sandbox is killed at the timeout and the node errors with a timeout message

#### Scenario: Normal completion

- GIVEN code completing normally
- WHEN it executes
- THEN it finishes within the timeout and results flow onward

### Requirement: Resource caps

The system SHOULD cap sandbox memory and output size to protect the host.

#### Scenario: Output cap

- GIVEN code producing an oversized output
- WHEN it executes
- THEN output is truncated at the cap with a warning