# Backend Management Specification

## Purpose

llm-proxy SHALL NOT assume an external `llamaServer`. Instead it SHALL own the lifecycle of the `llama-server` binary (`llama serve`) as an internal component — spawning one process per active model (no router mode), supervising it, and shutting it down. Per-model configuration SHALL come from the app's model configuration (model-advanced-config, SQLite-backed) driven through the UI; workflows are authored as YAML graphs in the workflow editor. This capability makes the tool self-hosting its backend, unblocking runtime verification.

## Requirements

### Requirement: Spawn and supervise the llama-server process

The system MUST locate, spawn, supervise, and gracefully stop the `llama-server` process. The binary path SHALL be configurable, defaulting to `llama` on PATH. On unexpected exit, the system MUST restart the process. The system MUST support `--port 0`, detecting the bound port from process stdout via the regex `listening on ...:(\d+)`.
(Previously: fixed configured port, no version floor.)

#### Scenario: Spawn with ephemeral port and wait-ready on activation

- GIVEN the config defines a valid `llama-server` binary path
- WHEN a model is activated
- THEN the binary is spawned with `--port 0` and traffic is accepted only after the parsed stdout port passes the health check

#### Scenario: Restart on crash

- GIVEN a running managed backend
- WHEN the process exits abruptly
- THEN the system restarts it and resumes the ready state

### Requirement: Spawn-time readiness gate

When a model is activated, the system MUST spawn its backend (spawn + wait-ready via health check) before any traffic routes to it. Readiness SHALL be determined from the port parsed from stdout (`listening on ...:(\d+)`) when `--port 0` is used. If the backend fails to become ready, activation SHALL fail with a clear actionable message. The gateway itself does NOT wait at boot for a managed backend: models are spawned on activation, and wiring the managed backend into the boot path is intentionally deferred (the local provider is not connected at boot).
(Previously: readiness on a fixed configured port at boot.)

#### Scenario: Backend becomes ready before traffic

- GIVEN a healthy backend spawned on `--port 0` for an active model
- WHEN a request targets that model
- THEN traffic is accepted only after the parsed stdout port passes the health check

#### Scenario: Backend fails to become ready

- GIVEN a backend that never becomes ready
- WHEN the model is activated
- THEN activation fails with a clear actionable message and no traffic is routed to it

### Requirement: Graceful shutdown

The system MUST stop the managed backend process cleanly when the proxy stops.

#### Scenario: Clean stop on shutdown

- GIVEN a running managed backend
- WHEN the proxy receives a shutdown signal
- THEN the backend process is terminated cleanly and no orphan persists

### Requirement: Health and status reporting

The health endpoint MUST report managed-backend status (running/stopped, pid, available models).

#### Scenario: Health reports managed backend state

- GIVEN a running managed backend
- WHEN a client queries the health endpoint
- THEN the response includes state `running`, the pid, and the registered models

### Requirement: Fail-fast config validation at startup

The system MUST validate backend/model config at startup (missing GGUF, missing binary, invalid preset) and fail with a clear actionable message — not mid-request.

#### Scenario: Missing GGUF fails fast

- GIVEN a config referencing a non-existent GGUF file
- WHEN the proxy starts
- THEN startup fails with a message naming the missing file

#### Scenario: Missing binary fails fast

- GIVEN a configured binary not found on PATH or at the given path
- WHEN the proxy starts
- THEN startup fails with an actionable message

### Requirement: Integration with the provider adapter

The capability MUST integrate with the existing provider adapter, which SHALL use the managed process and know which models are registered, replacing any external-host assumption.

#### Scenario: Provider uses managed process

- GIVEN a configured provider targeting the gateway's managed backend
- WHEN a step routes to that provider
- THEN it forwards to the managed llama-server address, not an assumed external host

#### Scenario: Existing capabilities unaffected

- GIVEN the other five capabilities are applied
- WHEN backend-management is active
- THEN gateway-api, pipeline-orchestration, virtual-model-routing, gateway-security, and proxy-pipeline behavior is preserved
### Requirement: Single-model spawn per active model

The system MUST launch one `llama-server` process per active model (no router mode), passing per-model flags derived from the SQLite model config (model-advanced-config): GGUF path, `--ctx-size`, KV quant, YaRN. When a model becomes inactive, the system SHOULD stop it.

#### Scenario: Spawn with per-model flags

- GIVEN a model configured with ctx 8192 and q8_0 KV
- WHEN the model is activated
- THEN one llama-server spawns with `--model <gguf> --ctx-size 8192 --cache-type-k q8_0 --cache-type-v q8_0`

#### Scenario: Inactive model stopped

- GIVEN an activated model with no requests
- WHEN the model is deactivated
- THEN its process is stopped and it leaves the running registry

### Requirement: YaRN and KV cache flags at spawn

The system SHALL pass context-scaling and KV flags at spawn: `--rope-scaling yarn` with the target `--ctx-size` when YaRN is configured, `--cache-type-k`/`--cache-type-v`, and `--n-cache-gpu` when offload is set. `--cache-ram` SHALL cap only the HOST prompt cache and MUST NOT cap the KV cache.

#### Scenario: YaRN flags at spawn

- GIVEN a model with automatic YaRN 32K→128K
- WHEN it spawns
- THEN args include `--ctx-size 131072 --rope-scaling yarn`

#### Scenario: cache-ram semantics

- GIVEN a configured `--cache-ram` cap
- WHEN it spawns
- THEN the cap applies to the host prompt cache only; KV sizing is unchanged

### Requirement: llama.cpp version floor

Managed llama-server SHALL be llama.cpp b9908+ (2026-07-08); the system MUST fail fast at startup when the binary is older.

#### Scenario: Old binary rejected

- GIVEN a llama-server below b9908
- WHEN the app checks versions
- THEN startup fails with an actionable upgrade message

