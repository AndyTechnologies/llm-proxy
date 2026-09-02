# Delta for Gateway API

Preserved behaviors (auth, CORS, hop-by-hop stripping, 503/502 passthrough normalization, streaming passthrough integrity) are specced in `gateway-security` and `proxy-pipeline`; those capabilities are implementation-only for this change and carry no deltas. The migration MUST preserve them.

## ADDED Requirements

### Requirement: SSE idle timeout disabled on streaming routes

The system MUST serve SSE routes with the Bun.serve idle timeout disabled (`idleTimeout: 0` or `server.timeout(req, 0)`) so silent streams are never closed by the server. Slow non-SSE routes SHOULD be given explicit per-route timeouts.

#### Scenario: Stream survives long silence

- GIVEN an SSE stream with no frames for more than 10 seconds
- WHEN the stream continues producing no data
- THEN the connection stays open and `data: [DONE]` still arrives at completion

## MODIFIED Requirements

### Requirement: SSE streaming integrity

The system SHALL stream responses unbuffered. Each SSE message SHALL be a `data:` line terminated by `\n\n`. The stream SHALL end with exactly one `data: [DONE]` message, preceded by exactly one terminal chunk when the upstream sends no finish reason. On client disconnect the system MUST abort the upstream request.
(Previously: streamed via Express `res.pipe()`; transport is now Bun.serve with idle timeout disabled.)

#### Scenario: Chat completions streams via SSE

- GIVEN a chat completions request with `stream: true`
- WHEN the backend starts producing tokens
- THEN each token arrives as a `data: {...}\n\n` frame and the stream ends with exactly one `data: [DONE]\n\n`

#### Scenario: Client disconnect aborts upstream

- GIVEN an active SSE stream
- WHEN the client disconnects (TCP close)
- THEN the system aborts the upstream request and releases resources

#### Scenario: Terminal chunk synthesized exactly once

- GIVEN a stream whose upstream never sends a finish reason
- WHEN the stream reaches completion
- THEN exactly one synthesized chunk with `finish_reason: "stop"` is emitted before `data: [DONE]`

## RENAMED Requirements

### Requirement: SSE streaming via res.pipe → SSE streaming integrity

(Reason: `res.pipe` is Express transport; the name now states the guaranteed stream behavior.)
(Migration: tests and docs referencing `res.pipe` target the invariants: single terminal chunk, single `[DONE]`, abort on disconnect.)