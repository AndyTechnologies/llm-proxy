# Delta for Backend Management

**Files:** `openspec/specs/backend-management/spec.md`

### Changes

1. Remove all "intentionally deferred" / "local provider is not connected at boot" markers.
2. Introduce `LocalBackendHub` as the single orchestrator for all local model managers.
3. Replace the single-manager model with per-model `LlamaProcessManager` instances stored in a `Map<string, LlamaProcessManager>`.
4. Add version-floor preflight: ENOENT → per-model error + boot continues; below b9908 → `process.exit(1)`.
5. Add activate/deactivate endpoints with state transitions.
6. Add in-flight drain on deactivation (30s safety timeout).
7. Add idle-stop 10 min (configurable, up from 5 min).
8. Add spawn failure → error state + 503 propagation.

## ADDED Requirements

### Requirement: Activate and deactivate endpoints

`POST /api/models/:id/activate` SHALL create a `LlamaProcessManager`, spawn the process, persist `active=1` in SQLite, and return `{state: "active", pid, port}`. `POST /api/models/:id/deactivate` SHALL drain in-flight requests, stop the process, persist `active=0` in SQLite, and return `{state: "disabled"}`. All management endpoints SHALL be behind the existing auth gate.

#### Scenario: Activate a model

- GIVEN a registered model with a valid GGUF file and `active=0`
- WHEN `POST /api/models/:id/activate` is called
- THEN the process starts, the response is `{state: "active", pid: <number>, port: <number>}`, and `active=1` is persisted in SQLite

#### Scenario: Activate an already-active model

- GIVEN a model already in active state
- WHEN `POST /api/models/:id/activate` is called
- THEN the response returns the current `{state: "active", pid, port}` without re-spawning

#### Scenario: Deactivate a model

- GIVEN an active model with no in-flight requests
- WHEN `POST /api/models/:id/deactivate` is called
- THEN the process stops, the response is `{state: "disabled"}`, and `active=0` is persisted in SQLite

#### Scenario: Activate with missing GGUF returns error

- GIVEN a model whose GGUF file does not exist
- WHEN `POST /api/models/:id/activate` is called
- THEN the response is an error with a clear message naming the missing file

### Requirement: Version-floor ENOENT handling

The version-floor preflight SHALL distinguish between ENOENT (binary not found) and version-too-old:

- ENOENT → per-model error state with actionable message; boot continues.
- Parseable but below b9908 → `process.exit(1)` (global fail-fast).
- Parseable and current → proceed.

#### Scenario: ENOENT is per-model, not global

- GIVEN a binary path that does not exist
- WHEN the app runs preflight
- THEN all models enter error state with "llama-server binary not found at '<path>'" and boot continues (the system remains operational for external providers and workflows)

---


## MODIFIED Requirements

### Requirement: Spawn and supervise the llama-server process

The system SHALL own the lifecycle of `llama-server` as an internal component via `LocalBackendHub`. One `LlamaProcessManager` instance SHALL exist per active model (no router mode). On unexpected exit, the manager SHALL restart the process with exponential backoff (max 5 attempts). The system SHALL support `--port 0`, detecting the bound port from process stdout via the regex `listening on ...:(\d+)`.

#### Scenario: Spawn with ephemeral port and wait-ready on activation

- GIVEN the config defines a valid `llama-server` binary path
- WHEN a model is activated via `POST /api/models/:id/activate`
- THEN one `LlamaProcessManager` is created for that model, the binary is spawned with `--port 0`, and traffic is accepted only after the parsed stdout port passes the health check

#### Scenario: Restart on crash

- GIVEN a running managed backend for a model
- WHEN the process exits abruptly
- THEN the manager restarts it with exponential backoff (max 5 attempts) and resumes the ready state

#### Scenario: Spawn failure enters error state

- GIVEN a model whose GGUF file exists but spawn fails (e.g., OOM, permissions)
- WHEN activation is attempted
- THEN the model enters `error` state and subsequent requests receive HTTP 503 (Service Unavailable)

### Requirement: Spawn-time readiness gate

When a model is activated, the system SHALL spawn its backend and gate traffic on readiness. Readiness SHALL be determined from the port parsed from stdout when `--port 0` is used. `LocalBackendHub.localProvider()` SHALL return a provider wrapper whose `chat`/`chatStream` methods await the manager's health poll before forwarding. If the manager is not yet ready (still spawning), the request SHALL block until ready or time out (30s). If in error state, the wrapper SHALL throw immediately with `err.status = 503`. The gateway SHALL wait at boot only for models with `active=1` in SQLite (restored via `hub.restoreActive()`).

#### Scenario: Backend becomes ready before traffic

- GIVEN a healthy backend spawned on `--port 0` for an active model
- WHEN a request targets that model
- THEN traffic is accepted only after the parsed stdout port passes the health check

#### Scenario: Backend fails to become ready

- GIVEN a backend that never becomes ready within 30s
- WHEN the model is activated
- THEN the model enters error state, activation returns 503, and no traffic is routed to it

#### Scenario: Request during spawn blocks on readiness

- GIVEN a model being spawned (health check not yet passing)
- WHEN a `/v1/chat/completions` request arrives for that model
- THEN the request blocks until the health check passes or 30s timeout, then proceeds or fails with 503

### Requirement: Graceful shutdown

The system SHALL stop all managed backend processes cleanly when the proxy stops. `LocalBackendHub.stopAll()` SHALL iterate all managers, drain in-flight requests (up to 30s per model), and call `stop()` on each.

#### Scenario: Clean stop on shutdown

- GIVEN running managed backends for multiple models
- WHEN the proxy receives a shutdown signal
- THEN all backend processes are drained and terminated cleanly, and no orphan persists

### Requirement: Health and status reporting

The health endpoint SHALL report managed-backend status per model (state, pid, port, error). `GET /api/health` SHALL include a `localModels` field listing IDs of active+healthy models.

#### Scenario: Health reports managed backend state

- GIVEN running managed backends
- WHEN a client queries the health endpoint
- THEN the response includes `localModels` with the IDs of active+healthy models

### Requirement: Fail-fast config validation at startup

The system SHALL validate the llama-server binary at startup via a `--version` preflight check. The `active` column in SQLite SHALL be read to restore previously-activated models.

#### Scenario: Version floor — old binary rejected

- GIVEN a llama-server below b9908
- WHEN the app checks versions at boot
- THEN the process exits immediately with `process.exit(1)` and an actionable upgrade message (global fail-fast)

#### Scenario: Version floor — binary not found (ENOENT)

- GIVEN a configured binary path that does not exist
- WHEN the app checks versions at boot
- THEN all models enter error state with message "llama-server binary not found at '<path>'" and boot continues

#### Scenario: Missing GGUF does not block boot

- GIVEN a model with `active=1` in SQLite but a missing GGUF file
- WHEN the app restores active models at boot
- THEN that model enters error state, boot continues, and `/v1/models` omits it

#### Scenario: Active models restored from SQLite on boot

- GIVEN two models with `active=1` in SQLite
- WHEN the app starts
- THEN `hub.restoreActive()` spawns both models and they appear in `/v1/models`

### Requirement: Single-model spawn per active model

The system SHALL launch one `llama-server` process per active model, passing per-model flags derived from the SQLite model config: GGUF path, `--ctx-size`, KV quant, YaRN. `LocalBackendHub` SHALL maintain exactly one manager per model at any time (no duplicate spawn). Idle-stop SHALL default to 10 minutes (configurable), resetting on every request.

#### Scenario: Spawn with per-model flags

- GIVEN a model configured with ctx 8192 and q8_0 KV
- WHEN the model is activated
- THEN one llama-server spawns with `--model <gguf> --ctx-size 8192 --cache-type-k q8_0 --cache-type-v q8_0`

#### Scenario: Idle-stop after 10 minutes

- GIVEN an active model with no requests for 10 minutes
- WHEN the idle timer expires
- THEN the process is stopped; the next request re-spawns and succeeds

#### Scenario: In-flight drain on deactivation

- GIVEN an active model with 3 in-flight requests
- WHEN deactivation is requested
- THEN the system polls every 1s for up to 30s until in-flight count reaches 0, then calls `stop()`

#### Scenario: Deactivation timeout forces stop

- GIVEN an active model with in-flight requests that do not complete within 30s
- WHEN deactivation is requested
- THEN `stop()` is called anyway after the 30s timeout; in-flight requests fail with connection reset
