# WeaveLLM

**WeaveLLM** is a local AI desktop runtime (0.1.0) that bundles a
[llama.cpp](https://github.com/ggerganov/llama.cpp) backend manager, a visual
workflow editor, model management, and an OpenAI-compatible proxy into one app.

> **Status:** early development (`0.1.x`, pre-1.0). The core paths work today —
> the managed local `llama-server` backend is wired end-to-end, external
> providers and workflow/gateway virtual models run through `/v1` and `/api`,
> and the desktop console is served by the app itself. Remaining gaps are
> listed in [Current status](#current-status--known-limitations).

---

## Features

- **OpenAI-compatible API** — `POST /v1/chat/completions`, `POST
  /v1/completions`, `POST /v1/embeddings`, `GET /v1/models` with SSE streaming,
  client-disconnect abort, and normalized OpenAI-shaped errors.
- **DAG workflow engine** — saved workflows are directed node/edge graphs
  (`start`, `llm_call`, `condition`, …) executed by a graph engine and exposed
  as virtual models `gateway/<workflow-name>` (or selected via the
  `X-Chain-ID` header).
- **External provider adapters** — OpenAI, Anthropic, and OpenRouter plug in
  behind one `Provider` contract, with keychain-backed credentials and
  configurable fallback links (`chatWithFallback` / `chatStreamWithFallback`).
- **Managed backend lifecycle** — `LocalBackendHub` + `LlamaProcessManager`
  spawn one `llama-server` per active model on an ephemeral port (`--port 0`),
  gate readiness on a health poll, supervise restarts with exponential
  backoff, and stop the process after an idle timeout (10 minutes).
  Previously-activated models are restored at boot; a request to a stopped
  backend lazily re-spawns it.
- **Model lifecycle API** — activate and deactivate models on the fly via
  `POST /api/models/:id/activate` / `POST /api/models/:id/deactivate`;
  deactivation drains in-flight requests (30 s cap) before stopping the
  backend.
- **Model catalog + downloads** — GGUF catalog with curated metadata and a
  checksum-verified download engine (gosh).
- **Keychain secrets** — provider API keys and the gateway auth key live in
  the OS keychain-backed `SecretStore`, never in plaintext config.
- **Sandboxed code execution** — `data.code` nodes run in a restricted
  sandbox (`unshare -n`; no network).
- **Embeddings** — designate a model as the embedding model (stored in the
  `settings` table) and it spawns with `--embeddings`; `/v1/embeddings` then
  serves vectors through the managed backend.
- **Custom WebSocket surface** — `/ws` runs workflows live with typed
  `status` / `step_started` / `step_completed` / `token` events.
- **Desktop console** — an Astro 7 + Svelte 5 admin console (`frontend/`)
  served by the app itself: overview, model registry, providers, workflow
  editor with a live run panel, executions, runtime status, settings, and an
  API playground. Single-binary desktop builds via `bun run build:binary` /
  `build:binaries` (Electrobun; the main-process entry is `src/main.ts`).
- **Security** — loopback bind by default, optional keychain-backed Bearer
  auth (off by default), JSON-lines logging, constant-time token comparison.
- **Health** — `GET /api/health` (reports the active local model ids).

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.4 (Node ≥ 22.12.0 only as a fallback engine; the
  runtime targets Bun)
- [llama.cpp](https://github.com/ggerganov/llama.cpp) — the `llama-server`
  binary, build **b9908 or newer** (enforced at boot via `--version`), either
  on `PATH` as `llama` or pointed to with `WEAVELLM_LLAMA_BIN`.
- GGUF model files you want to serve

---

## Installation

```bash
git clone https://github.com/AndyTechnologies/llm-proxy.git
cd llm-proxy
bun install
```

---

## Quick start

The runtime is environment-configured; there is no required config file.

```bash
bun run dev
```

The app listens on `http://127.0.0.1:4317` by default (loopback only). On boot
it logs the app-data directory and the bound URL.

### Try it

```bash
# List registered models (external provider ids + local + gateway/<workflow> virtuals)
curl http://127.0.0.1:4317/v1/models

# Chat via a saved workflow (non-streaming)
curl http://127.0.0.1:4317/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gateway/my-workflow",
    "messages": [{"role": "user", "content": "Explain what a workflow is"}]
  }'

# Stream
curl -N http://127.0.0.1:4317/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway/my-workflow","stream":true,"messages":[{"role":"user","content":"Hi"}]}'

# Use a workflow via header instead of model name
curl http://127.0.0.1:4317/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Chain-ID: my-workflow" \
  -d '{"model":"ignored","messages":[{"role":"user","content":"Write a function"}]}'
```

`gateway/<name>` models exist for every workflow saved in the app database;
external provider models (e.g. `gpt-4o`) are served for the ids registered to
that provider. Local `llama-server` models answer requests once activated (in
the console's Models page or via `POST /api/models/:id/activate`); until then
their ids answer the unknown-model 404 envelope.

---

## Configuration

The runtime configuration is resolved from the environment at boot
(`src/app/config.ts`, `resolveAppConfig`); there is no YAML config file loaded
by the app.

### Environment variables

| Variable           | Default       | Purpose                                                        |
| ------------------ | ------------- | -------------------------------------------------------------- |
| `WEAVELLM_HOST`    | `127.0.0.1`   | Bind host (loopback by default).                               |
| `WEAVELLM_PORT`    | `4317`        | Proxy port (`0` selects an ephemeral port).                    |
| `WEAVELLM_AUTH`    | *(unset)*     | `1`/`true` enables the Bearer auth gate (off by default).      |
| `WEAVELLM_APP_DATA`| platform app-data dir | Override the data directory (SQLite, logs, models).     |
| `WEAVELLM_UI_DIR`  | *(probe)*     | Compiled UI directory (default: `frontend/dist`, else bundled `ui/`). |
| `WEAVELLM_LLAMA_BIN`| `llama`       | Path to the `llama-server` binary.                             |

Provider and workflow state is **database-backed** (SQLite, see
[Architecture](#architecture)):

- `providers` rows define external provider kinds, base URLs, and fallback
  links; credentials resolve from the keychain store (scope `provider:<kind>`).
- `workflows` rows hold named workflows as YAML node/edge graphs.
- The gateway auth key, when `WEAVELLM_AUTH` is enabled, is the keychain
  entry scoped `auth`.

### Workflow YAML shape

Workflows are DAGs of `nodes` + `edges`: a `start` node, one `llm_call` node
per orchestration step, and an `end` node.

```yaml
name: orchestrator
nodes:
  - id: start
    type: start
  - id: generate
    type: llm_call
    mode: generate
    model: SmolLM3-3B
  - id: refine-coder
    type: llm_call
    mode: refine
    model: Qwen2.5-Coder-3B-Instruct
  - id: end
    type: end
edges:
  - from: start
    to: generate
  - from: generate
    to: refine-coder
  - from: refine-coder
    to: end
```

`llm_call` modes:

| Mode          | Behavior                                                              |
| ------------- | --------------------------------------------------------------------- |
| `generate`    | Seed with the incoming user messages (optionally prefix `system`/`assistant`). |
| `refine`      | Refeed the previous node's output for verification / improvement.     |
| `passthrough` | Forward the request to the provider without transformation.           |

Conditional routing (fields on an `llm_call` node):

- `on_429: <node-id>` — run `<node-id>` when this node returns HTTP 429.
- `tool_calls_route: <node-id>` — run `<node-id>` when the response carries
  `tool_calls`.

The full node taxonomy (14 types) is `start`, `end`, `llm_call`, `condition`,
`loop`, `fan`, `join`, `pipeline`, `rag_local`, `data.code`, `memory`,
`embeddings`, `router`, `output`.

---

## Scripts

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `bun run dev`        | Backend (`bun run --watch src/main.ts`) + Astro dev in parallel, shared terminal (`scripts/dev.ts`); Ctrl+C kills both. |
| `bun run dev:frontend` | Astro dev server for the console shell (proxies `/api`, `/v1`, `/ws` to the backend). |
| `bun run build`      | Bundle the backend to `dist/` (`bun build src/main.ts`). |
| `bun run build:frontend` | Build the Astro console shell.                |
| `bun run build:binary`  | Compile a standalone binary `dist/weavellm` (`scripts/build-binary.ts`). |
| `bun run build:binaries`| Build all platform binaries (`scripts/build-binaries.ts`). |
| `bun start`          | Build the UI, then run the Electrobun desktop bundle via hutch (`scripts/start-desktop.ts`, `--env=dev`). |
| `bun test`           | Run the tests (`bun:test`; discovers `src/` — 42 colocated files). |
| `bun run typecheck`  | Type-check the backend with `tsc --noEmit`.      |
| `bun run typecheck:frontend` | Type-check the console with `astro check --root frontend`. |
| `bun run lint`       | Lint with ESLint.                                 |
| `bun run format`     | Autofix lint issues.                              |

---

## Endpoints

The app server (`src/app/server.ts`) is a single `Bun.serve` fetch handler.
Default port: **4317**.

| Method | Path                        | Description                                             |
| ------ | --------------------------- | ------------------------------------------------------- |
| GET    | `/api/health`               | Liveness probe → `{"status":"ok","localModels":[...]}`. |
| GET    | `/api/models`               | Model statuses `{id, state: active\|disabled\|error, pid?, port?, error?}` (auth-gated when enabled). |
| GET    | `/api/models/:id`           | One model status (404 when unknown).                    |
| GET    | `/api/models/:id/status`    | Alias of the single-model status.                       |
| POST   | `/api/models/:id/activate`  | Activate a model (idempotent; spawns `llama-server`).   |
| POST   | `/api/models/:id/deactivate`| Deactivate a model (drains in-flight, 30 s cap, then stops). |
| GET    | `/v1/models`                | List external + local + `gateway/<workflow>` virtual models. |
| POST   | `/v1/chat/completions`      | OpenAI-compatible chat (SSE when `stream:true`).        |
| POST   | `/v1/completions`           | Legacy text completions (prompt→chat wrapper).          |
| POST   | `/v1/embeddings`            | Embeddings via the designated embedding model (404 until one is configured). |
| GET    | `/api/workflows`            | List saved workflows (`[{name, version, updatedAt}]`).  |
| GET    | `/api/workflows/:name`      | Fetch a workflow incl. its YAML.                        |
| PUT    | `/api/workflows/:name`      | Upsert a workflow from YAML (validates the graph).      |
| DELETE | `/api/workflows/:name`      | Delete a workflow (204 \| 404).                         |
| POST   | `/api/workflows/:name/run`  | Run the workflow with an OpenAI chat body.              |
| GET    | `/api/workflows/:name/logs` | Execution history.                                      |
| WS     | `/ws`                       | Live workflow runs: client `{type:"bind",workflow}` / `{type:"run",messages}`; server `status`, `step_started`, `step_completed`, `token` (completed run's SSE, then `data: [DONE]`), `error`. Events scoped to the bound workflow; disconnect aborts the run. |

Unmatched paths answer a JSON 404 (or 426 for non-upgrade requests to `/ws`).
All `/v1` responses are normalized OpenAI-shaped envelopes.

---

## Architecture

```
src/main.ts        boot: appData → SQLite → config → secrets → providers →
                   local hub (preflight/restoreActive) → workflows → server →
                   background update check
src/app/           server.ts (Bun.serve createWebServer, graceful drain,
                   serveStaticUi), config.ts, ws.ts (WsHub), update.ts,
                   startup.ts, types.ts
src/backend/       managed llama-server lifecycle: hub.ts (LocalBackendHub:
                   preflight, restoreActive, activation, readiness gating),
                   manager.ts (LlamaProcessManager), spawn-args.ts
src/catalog/       GGUF model catalog + curated metadata
src/db/            app-data SQLite schema (10 tables) + model config
src/downloads/     gosh CLI model downloads (checksum-verified)
src/orchestrator/  workflow store, graph validation, engine, runner, YAML parse
src/providers/     Provider contract, registry, llama-server provider,
                   adapters (openai/anthropic/openrouter), fallback, embeddings
src/rag/           embeddings, chunking, memory
src/routes/        v1.ts (/v1 dispatcher), api.ts (/api dispatcher),
                   auth.ts (gate), relay.ts (SSE)
src/sandbox/       code execution (unshare -n)
src/secrets/       keychain.ts SecretStore + redaction
src/types/         shared + OpenAI types
src/ui-svelte/     Svelte components shared with the renderer
src/utils/         logging, ids, content extraction, GGUF, sanitization
frontend/          Astro 7 renderer shell (Svelte 5, @xyflow workflow editor);
                   served compiled by the app server (serveStaticUi) from
                   frontend/dist or WEAVELLM_UI_DIR, and has its own dev server
scripts/           dev launcher, build binaries, start-desktop
```

Notes:

- **Boot order** (`src/main.ts`): resolve app-data dir → mkdir
  logs/models/sandbox → open the SQLite DB → resolve config → `SecretStore`
  → `buildProviderRegistry` (external adapters) → `LocalBackendHub`
  (`preflight()` + `restoreActive()`) → `WorkflowStore` →
  `makeRuntimeServices` → `makeWorkflowRunner` → `makeApiHandler` →
  `makeV1Handler` (optional auth gate) → `createWebServer` → update check →
  `server.start()`. Shutdown: `hub.stopAll()` then `server.stop()`.
- **Provider abstraction** (`src/providers/types.ts`) isolates all backend
  network interaction behind `chat` / `chatStream`; external adapters plug in
  without touching the orchestrator or routes.
- **Managed backend** (`src/backend/hub.ts` + `manager.ts`) is the source of
  truth for local backend readiness, base URL, and spawn flags
  (`buildLlamaSpawnArgs`). `restoreActive()` must complete before the server
  accepts traffic, so previously-active models are back up at first request.
- **Bun.serve** replaces Express; all handler code is plain fetch functions
  returning `Response`, and `/ws` upgrades ride the same server.
- **Persisted state**: SQLite at `<appData>/weavellm.db` — `models`,
  `model_config`, `workflows`, `execution_log`, `providers`, `secrets`,
  `kv_memory`, `chunks`, `downloads`, `settings`.

The behavior of each capability is specified under
`openspec/specs/<capability>/spec.md` (25 capability specs).

---

## Desktop console

The app serves its own compiled admin console (Astro 7 + Svelte 5) from the
same origin — `http://127.0.0.1:<port>` (GET/HEAD only; `/api/*` and `/v1/*`
stay API-only). It is served from `frontend/dist` or the `WEAVELLM_UI_DIR`
override, and it has its own dev server (`bun run dev:frontend`, which proxies
`/api`, `/v1`, and `/ws` to the backend).

Main pages:

| Page | Route |
| ---- | ----- |
| Overview | `/` |
| Models — registry, catalog, downloads | `/models`, `/models/catalog`, `/models/downloads`, `/models/:id` |
| Providers — openai / anthropic / openrouter | `/providers`, `/providers/:kind` |
| Workflows — list + editor with live WS run panel and YAML save | `/workflows`, `/workflows/:name` |
| Executions | `/executions` |
| Runtime | `/runtime` |
| Settings | `/settings` |
| API Playground | `/playground` (legacy alias `/api`) |
| About | `/about` |

See [docs/desktop-ui.md](docs/desktop-ui.md) for the console's design and
architecture.

---

## Current status / known limitations

- **Local backend: wired.** `LocalBackendHub` boots before the HTTP server:
  `preflight()` enforces the b9908+ version floor (fail-fast) and
  `restoreActive()` re-spawns previously-activated models. Requests to local
  ids gate on readiness — lazy re-spawn with a 30 s cap, **503** on error.
  Embeddings serve through a designated embedding model; `/v1/embeddings`
  answers the 404 envelope until one is configured.
- **RAG stores not wired:** `makeRuntimeServices` receives `chunks: () => null`
  and `memory: () => null` — `rag_local` retrieval and conversation memory
  resolve to empty/absent until those services are connected at boot.
- **WS `token` events relay the completed run** in one chunk (the run finishes
  first, then its OpenAI-wire SSE is emitted plus exactly one `data: [DONE]`);
  live per-token deltas are not streamed yet.
- **No Playwright e2e coverage:** the CI e2e job is still disabled; the
  console is covered by unit tests on its typed clients and state machines.
- **Electrobun builds are host-only:** `bun run build:binary` /
  `build:binaries` produce bundles for the host platform (no cross-compile).

## Documentation

- [docs/architecture.md](docs/architecture.md) — system overview and component map
- [docs/api.md](docs/api.md) — HTTP and WebSocket surface reference
- [docs/local-backend.md](docs/local-backend.md) — managed `llama-server` lifecycle, activation, embeddings
- [docs/providers.md](docs/providers.md) — external providers, keychain, fallback
- [docs/workflows.md](docs/workflows.md) — workflow YAML, node taxonomy, engine
- [docs/desktop-ui.md](docs/desktop-ui.md) — the admin console

---

## Security

- By default the app binds to `127.0.0.1` and, without `WEAVELLM_AUTH`, the
  API is **unsecured** — keep it on loopback unless you harden it.
- Auth, when enabled, requires `Authorization: Bearer <key>` on `/v1`
  requests; the key is stored in the keychain store (scope `auth`) and
  compared in constant time (SHA-256 + `timingSafeEqual`).
- Provider secrets are keychain-backed; `data.code` nodes run sandboxed
  (`unshare -n`, no network).
- See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and a
  deployment hardening checklist.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and pull
request guidance. This project uses Spec-Driven Development (SDD) under
`openspec/` and strict TDD.

---

## License

[MIT](LICENSE.md) © [AndyTechnologies](https://github.com/AndyTechnologies)