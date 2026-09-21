# WebSocket Streaming Specification

## Purpose

Real-time event streaming for the app over WebSocket: chain step lifecycle (step_started/step_completed), status, error, and run-output events on a `/ws` endpoint. Run-output `token` events relay a completed run's OpenAI-wire SSE in a single message; per-token delta streaming is a future engine feature, not part of this capability.

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

### Requirement: Run output relay over WS

A completed run's OpenAI-wire SSE output SHALL be relayed inside a WS `token` message, ending with exactly one `data: [DONE]`. Step lifecycle events (`step_started`, `step_completed`, `status`, `error`) SHALL stream live from the engine as the run progresses; per-token delta streaming is a future engine feature and is NOT required by this capability.

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