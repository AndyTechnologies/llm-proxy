# Delta for Dashboard Api

**Files:** `openspec/specs/dashboard-api/spec.md`

### Changes

1. Add `/api/models` route group (distinct from `/api/ui/models` which serves the legacy UI).
2. Add 3D model state (loaded/unloaded × active/disabled × healthy/error).
3. Add activate/deactivate endpoints.
4. Extend `/api/health` with `localModels` field.

## ADDED Requirements

### Requirement: Local model management API

The system SHALL expose a `/api/models` route group for managing local model lifecycle. All routes SHALL be behind the existing auth gate. `ApiDeps` SHALL include a `hub: LocalBackendHub` dependency.

#### Scenario: List all models with state

- GIVEN three registered models (two active, one disabled)
- WHEN `GET /api/models` is called
- THEN a JSON array of `ModelStatus` objects is returned, each with `id`, `state` ("active" | "disabled" | "error"), optional `pid`, optional `port`, and optional `error`

#### Scenario: Get model status

- GIVEN an active model with pid and port
- WHEN `GET /api/models/:id/status` is called
- THEN `{id, state: "active", pid: <number>, port: <number>}` is returned

#### Scenario: Unknown model returns 404

- GIVEN no model with id "nonexistent"
- WHEN `GET /api/models/nonexistent/status` is called
- THEN a 404 error envelope is returned

### Requirement: Model activation endpoint

`POST /api/models/:id/activate` SHALL start the llama-server process for the given model and return the runtime state.

#### Scenario: Activate returns pid and port

- GIVEN a registered model with valid GGUF and `active=0`
- WHEN `POST /api/models/:id/activate` is called
- THEN `{state: "active", pid: <number>, port: <number>}` is returned with HTTP 200

#### Scenario: Activate failure returns 503

- GIVEN a model whose spawn fails
- WHEN `POST /api/models/:id/activate` is called
- THEN an error response with HTTP 503 (Service Unavailable) is returned

### Requirement: Model deactivation endpoint

`POST /api/models/:id/deactivate` SHALL drain in-flight requests, stop the process, and return the disabled state.

#### Scenario: Deactivate returns disabled state

- GIVEN an active model with no in-flight requests
- WHEN `POST /api/models/:id/deactivate` is called
- THEN `{state: "disabled"}` is returned with HTTP 200

#### Scenario: Deactivate unknown model returns 404

- GIVEN no model with id "nonexistent"
- WHEN `POST /api/models/nonexistent/deactivate` is called
- THEN a 404 error envelope is returned

### Requirement: Health endpoint includes local models

`GET /api/health` SHALL include an optional `localModels` field listing IDs of active+healthy local models. The field SHALL only be present when the hub is wired.

#### Scenario: Health includes localModels

- GIVEN one active+healthy local model and one disabled model
- WHEN `GET /api/health` is called
- THEN the response includes `localModels: ["<active-id>"]`

#### Scenario: Health omits localModels when no hub

- GIVEN the hub is not wired (legacy boot path)
- WHEN `GET /api/health` is called
- THEN the response does not include a `localModels` field

---
