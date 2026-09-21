# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-09-15

### Added

- Local backend runtime: managed `llama-server` processes are wired into boot — previously-activated models restore automatically and local model IDs now resolve through `/v1/*` and workflow `llm_call` nodes.
- Model lifecycle management: `POST /api/models/:id/activate` and `POST /api/models/:id/deactivate` with an idempotent activation flow, in-flight request drain on deactivation (30s timeout), and persisted active state in a new `models.active` column (auto-migrated idempotently on existing databases).
- Model status API: `GET /api/models` and `GET /api/models/:id/status` behind the existing auth gate, reporting a three-state projection (active / disabled / error) with pid, port, and error detail.
- `/api/health` now includes a `localModels` field listing active+healthy local model IDs when the local backend is wired.
- Dedicated embedding models: designating a model via the `settings` table (`embedding_model` key) spawns it with `--embeddings`, and `/v1/embeddings` serves vectors through the managed backend (404 preserved when no embedder is configured).
- `WEAVELLM_LLAMA_BIN` environment variable to configure the `llama-server` binary path (defaults to `llama`).

### Changed

- Local models are now callable end-to-end: requests gate on backend readiness (blocking up to 30s during spawn, returning 503 on error) and lazily re-spawn after idle-stop, replacing the un-wired boot path where local IDs answered the unknown-model 404 envelope.
- Idle-stop timeout for managed backends increased from 5 to 10 minutes (configurable).
- Startup version-floor preflight: a missing `llama-server` binary is now a per-model error that does not block boot (external providers and workflows unaffected), while a binary below b9908 fails fast with an actionable upgrade message.

## [0.1.0] - 2026-09-15

WeaveLLM — a full rewrite of the llm-proxy gateway: local llama.cpp models behind an OpenAI-compatible API on port 4317, workflows composed in a visual editor and exposed as virtual models, a desktop shell, and sandboxed code execution.

### Added

- Desktop app shell: single-binary builds for macOS 14+ (arm64/x64) and Linux x64 (Ubuntu 24.04+) under 100 MB via Electrobun v2 (Bun main process, Astro 7/Svelte 5 UI), Hutch auto-update checks, and a 2-second cold-start budget.
- Visual workflow editor: DAG canvas (@xyflow/svelte) with 10+ node types, inline cycle rejection, YAML import/export, and validation before save or execution.
- Workflow engine: topological DAG execution with parallel fan-out, a node taxonomy shared with the editor, mixture-of-agents (MoA 3+1) synthesis, and `on_429`/`tool_calls_route` conditional routing with cross-provider fallback.
- Virtual models: every named chain is exposed as `gateway/<chain-name>` on the OpenAI-compatible API and selectable via the `X-Chain-ID` header.
- Local model catalog: curated GGUF list, Hugging Face search and import, local-path registration with GGUF metadata parsing, a SQLite model registry, and NIAH context probes.
- Model downloads: gosh CLI-driven GGUF downloads with mandatory SHA256 verification (`sha256:<hex>`), resumable transfers, queueing, and cancellation.
- Per-model advanced configuration: automatic YaRN context scaling (with a rope-scale guard rejecting scale < 1), KV-cache quantization, and per-call sampler overrides.
- Backend management: one llama-server process per active model with per-model spawn flags (ctx size, KV quant, YaRN), restart on unexpected exit, and a llama.cpp b9908+ version floor with fail-fast startup.
- Keychain secrets: provider API keys and the optional proxy auth key sealed with AES-256-GCM under an OS-keychain-held master key; key material never appears in logs, exports, or error messages.
- External providers: adapters for OpenAI-compatible, Anthropic, and OpenRouter providers (plus the local llama-server backend) over the `Provider` seam, with provider fallback on 429/5xx/network errors that never duplicates streamed tokens.
- Gateway proxy: `/v1/chat/completions`, `/v1/completions`, `/v1/models`, and `/v1/embeddings` on localhost:4317 with OpenAI wire shapes, streaming SSE passthrough ending in exactly one `data: [DONE]`, and client-disconnect abort.
- Gateway security: optional keychain-backed Bearer auth (off by default) and localhost-only binding by default.
- Embeddings & RAG: local embeddings endpoint, SQLite vector store with top-k similarity search, conversation memory, and a `rag_local` grounded-generation node.
- Data & code sandbox: isolated subprocess execution for `data.code` nodes with no network access, a temp-only filesystem, hidden host secrets, enforced timeouts, and output caps.
- WebSocket streaming: `/ws` endpoint emitting typed run events (step_started, step_completed, token, status, error) scoped per workflow, delivered in causal order, with abort on disconnect.

### Changed

- The managed llama-server backend now spawns one process per active model on an ephemeral port (`--port 0`) detected from stdout, replacing the former fixed-port router mode, and restarts on unexpected exit.
- The OpenAI-compatible-only provider adapter becomes a multi-provider adapter; provider credentials now resolve from the keychain store instead of static config `apiKey` values, and an unconfigured provider is marked misconfigured instead of sending empty credentials.
- Optional auth is now off by default and validated against a keychain-stored key, replacing the `BEARER_TOKEN` environment-variable gate.
- Boot-time readiness is now gated on the spawned backend passing its health check before the proxy accepts traffic.

### Removed

- Router mode configuration (`models`/preset INI machinery) in favor of one process per active model, with per-model config persisted in SQLite.
- Native on-demand model swap and configurable autoload flags (router-only features).

> Known limitations at this release: the managed llama-server spawn-on-activation flow and local embeddings/RAG/NIAH end-to-end paths are unit-covered via injected fakes but not wired at boot; `/ws` token events relay a completed run's SSE in one chunk rather than live token deltas; the workflow editor has no Playwright E2E coverage yet.