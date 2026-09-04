# Backend Management Specification

## Purpose

llm-proxy SHALL NOT assume an external `llamaServer`. Instead it SHALL own the lifecycle of the `llama-server` binary (`llama serve`) as an internal component — spawning, supervising, configuring in router mode, and shutting it down. All backend/model configuration SHALL come from the single `llm-proxy.config.yaml`; the end user only defines chains in YAML and never touches llama.cpp directly. This capability makes the tool self-hosting its backend, unblocking runtime verification.

## Requirements

### Requirement: Spawn and supervise the llama-server process

The system MUST locate, spawn, supervise, and gracefully stop the `llama-server` process. The binary path SHALL be configurable in `llm-proxy.config.yaml`, defaulting to `llama` on PATH. On unexpected exit, the system MUST restart the process.

#### Scenario: Spawn and wait-ready at boot

- GIVEN the config defines a valid `llama-server` binary path and host/port
- WHEN the proxy starts
- THEN the binary is spawned and the system waits for the backend health to become ready before accepting traffic

#### Scenario: Restart on crash

- GIVEN a running managed backend
- WHEN the process exits abruptly
- THEN the system restarts it and resumes the ready state

### Requirement: Configure router mode from config

The system MUST launch `llama-server` in router mode (no `--model`; using `--models-dir` and/or `--models-preset`), passing global args (default `--ctx-size`/`-n`, GPU, host/port, flash-attn, batch) derived entirely from `llm-proxy.config.yaml`.

#### Scenario: Router mode with global args

- GIVEN config declares a models dir, default context, port, and GPU flags
- WHEN the backend is spawned
- THEN it is launched in router mode with those args and registers available GGUF models

### Requirement: Per-model instances via generated preset

The system SHOULD let each model declare its own GGUF file, context, temperature, and args. The tool MUST be able to generate/manipulate the `--models-preset` INI mechanism (or equivalent) to express per-model settings.

#### Scenario: Per-model preset generated

- GIVEN config defines two models with distinct ctx and temp
- WHEN the backend initializes
- THEN a preset is generated/loaded so each model inherits its own ctx and args

#### Scenario: Model with per-instance overrides

- GIVEN a model declared with `ctx` larger than the default
- WHEN a request loads that model
- THEN the model instance runs with its own ctx, not the global default

### Requirement: Native on-demand model swap

The system MUST use llama-server's native router-mode swap (autoload on-demand), NOT a process-per-model approach. The system MUST inject the correct `model` field into each request for every step of a chain.

#### Scenario: Autoload on first request

- GIVEN a model not yet loaded
- WHEN a request targeting it arrives
- THEN llama-server autoloads it on demand and serves the request

#### Scenario: Model field injected per node

- GIVEN a chain with `llm_call` nodes targeting different models
- WHEN each node is issued
- THEN the outbound request carries that node's target `model`

### Requirement: Boot-time readiness gate

The system MUST start the backend (spawn + wait-ready via health check) before accepting traffic. If the backend fails to start, the system MUST fail startup with a clear message.

#### Scenario: Backend becomes ready before traffic

- GIVEN a healthy backend
- WHEN the proxy boots
- THEN traffic is accepted only after the backend health check passes

#### Scenario: Backend fails to boot

- GIVEN a backend that never becomes ready (bad binary, wrong port)
- WHEN the proxy attempts startup
- THEN the proxy fails with a clear actionable message and refuses to serve

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

### Requirement: Configurable autoload

The system SHOULD allow disabling global autoload (`--no-models-autoload`) or per-request autoload when the user needs it.

#### Scenario: Global autoload disabled

- GIVEN config sets autoload off
- WHEN the backend is spawned
- THEN llama-server is launched with `--no-models-autoload`

#### Scenario: Per-request autoload override

- GIVEN a request passing an autoload query param
- WHEN routing to the backend
- THEN the param is forwarded accordingly

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
