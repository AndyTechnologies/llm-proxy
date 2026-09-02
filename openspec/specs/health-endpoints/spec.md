# Health Endpoints Specification

## Purpose

Operational endpoints and hardening: liveness, backend-gated readiness, structured JSON logs, graceful shutdown drain on Bun.serve.

## Requirements

### Requirement: Liveness endpoint

The system MUST expose `GET /health/live` returning HTTP 200 whenever the process is alive, regardless of backend state.

#### Scenario: Live while process is up

- GIVEN the gateway process is running, whatever the backend state
- WHEN a client requests `GET /health/live`
- THEN the response is HTTP 200 indicating liveness

### Requirement: Readiness gated on backend state

The system MUST expose `GET /health/ready` returning HTTP 200 only when the managed backend state is `running`; otherwise the response MUST be HTTP 503 and include the current backend state.

#### Scenario: Ready when backend running

- GIVEN the manager reports backend state `running`
- WHEN a client requests `GET /health/ready`
- THEN the response is HTTP 200

#### Scenario: Not ready during startup or error

- GIVEN the manager reports `starting`, `stopped`, or `error`
- WHEN a client requests `GET /health/ready`
- THEN the response is HTTP 503 and reports the backend state

### Requirement: Legacy health endpoint preserved

The system MUST keep `GET /health` reporting aggregated status (backend state, pid, models, chains) for existing consumers.

#### Scenario: Health reports backend state

- GIVEN a running managed backend
- WHEN a client requests `GET /health`
- THEN the response includes state `running`, pid, and registered models

### Requirement: Structured JSON logs

The system MUST emit runtime log lines (startup, shutdown, fatal errors) as single-line JSON with `level` and `message` fields.

#### Scenario: Startup logs are JSON

- GIVEN the gateway boots
- WHEN config loads and the server listens
- THEN each emitted log line parses as JSON with `level` and `message` fields

### Requirement: Graceful shutdown with drain

The system MUST, on SIGINT/SIGTERM, stop accepting new connections, drain in-flight requests, stop the managed backend, and exit 0 leaving no orphan processes. A bounded force window MUST close hung connections.

#### Scenario: SIGTERM drains and exits clean

- GIVEN an in-flight request and a running backend
- WHEN the process receives SIGTERM
- THEN the request completes, the backend stops, no orphan remains, and the process exits 0

#### Scenario: Hung connection force-closed

- GIVEN a connection outliving the drain window
- WHEN the drain timeout expires
- THEN the connection is force-closed and shutdown completes