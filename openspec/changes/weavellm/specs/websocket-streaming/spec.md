# WebSocket Streaming Specification

## Purpose

Real-time event streaming for the app over WebSocket: token deltas, chain step transitions, and status events on a `/ws` endpoint.

## Requirements

### Requirement: WebSocket endpoint

The system SHALL expose a `/ws` endpoint accepting upgrades and emitting typed events (step_started, step_completed, token, status, error) for active workflows.

#### Scenario: Connect and receive events

- GIVEN a client connected to /ws
- WHEN a workflow starts
- THEN the client receives step and token events in order

#### Scenario: Non-WebSocket request rejected

- GIVEN a non-WebSocket request to /ws
- WHEN the request arrives
- THEN it is rejected with a 400/426 response

### Requirement: Token streaming over WS

Streaming responses SHALL be relayed as OpenAI-wire SSE chunks inside WS messages, ending with exactly one `data: [DONE]`.

#### Scenario: Terminal chunk exactly once

- GIVEN a completed stream on /ws
- WHEN the final chunk arrives
- THEN exactly one `data: [DONE]` terminates the stream

#### Scenario: Client disconnect aborts

- GIVEN an active stream
- WHEN the client disconnects
- THEN the upstream invocation is aborted and resources are released

### Requirement: Event ordering and reliability

Events for a single workflow SHALL be delivered in causal order over the same socket.

#### Scenario: Order preserved

- GIVEN a workflow with sequential steps
- WHEN events are emitted
- THEN step_completed for step N arrives before step_started for step N+1

### Requirement: Workflow-to-endpoint binding

The `/ws` consumer SHALL bind to a workflow via a client-supplied workflow ID and SHALL NOT observe other workflows' events.

#### Scenario: Scoped binding

- GIVEN two concurrent workflows on two sockets
- WHEN both emit events
- THEN each socket receives only its bound workflow's events