# Delta for Backend Management

Delta over `openspec/specs/backend-management/spec.md` (llama.cpp min b9908+): router mode is replaced by single-model spawn with YaRN/KV flags.

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Spawn and supervise the llama-server process

The system MUST locate, spawn, supervise, and gracefully stop the `llama-server` process. The binary path SHALL be configurable, defaulting to `llama` on PATH. On unexpected exit, the system MUST restart the process. The system MUST support `--port 0`, detecting the bound port from process stdout via the regex `listening on ...:(\d+)`.
(Previously: fixed configured port, no version floor.)

#### Scenario: Spawn with ephemeral port and wait-ready at boot

- GIVEN the config defines a valid `llama-server` binary path
- WHEN the proxy starts
- THEN the binary is spawned with `--port 0` and the system waits until the parsed stdout port is healthy before accepting traffic

#### Scenario: Restart on crash

- GIVEN a running managed backend
- WHEN the process exits abruptly
- THEN the system restarts it and resumes the ready state

### Requirement: Boot-time readiness gate

The system MUST start the backend (spawn + wait-ready via health check) before accepting traffic. Readiness SHALL be determined from the port parsed from stdout (`listening on ...:(\d+)`) when `--port 0` is used. If the backend fails to start, the system MUST fail startup with a clear message.
(Previously: readiness on a fixed configured port.)

#### Scenario: Backend becomes ready before traffic

- GIVEN a healthy backend on `--port 0`
- WHEN the proxy boots
- THEN traffic is accepted only after the parsed stdout port passes the health check

#### Scenario: Backend fails to boot

- GIVEN a backend that never becomes ready
- WHEN the proxy attempts startup
- THEN the proxy fails with a clear actionable message and refuses to serve

## REMOVED Requirements

### Requirement: Configure router mode from config

(Reason: router mode replaced by single-model spawn. Migration: per-model spawn flags from the SQLite model config.)

### Requirement: Per-model instances via generated preset

(Reason: `--models-preset` INI mechanism dropped. Migration: per-model config lives in SQLite via model-advanced-config.)

### Requirement: Native on-demand model swap

(Reason: no router; one process per active model. Migration: the app's spawn controller manages model lifetime.)

### Requirement: Configurable autoload

(Reason: `--no-models-autoload` is router-only. Migration: None.)