# llm-proxy

An **intelligent LLM gateway** that runs local [llama.cpp](https://github.com/ggerganov/llama.cpp)
models (via a managed `llama-server` backend) behind an **OpenAI-compatible
API**, and lets you compose those models into **chains** — ordered
orchestration pipelines exposed as virtual models.

> **Status:** early development (`0.1.x`, pre-1.0). The API surface is stable
> enough to use locally, but may evolve.

---

## Features

- **OpenAI-compatible API** — `POST /v1/chat/completions`, `POST /v1/completions`,
  `GET /v1/models`, with SSE streaming and normalized OpenAI-shaped errors.
- **Managed backend lifecycle** — `llm-proxy` spawns and supervises
  `llama-server`: health-checks, restart-on-exit, graceful shutdown, and
  dynamic ephemeral port handling.
- **Chain orchestration** — compose models into ordered pipelines
  (`generate` → `refine` → `refine`…) with conditional routing:
  - `on_429` — fall to another step when the upstream returns HTTP 429.
  - `tool_calls_route` — jump to a step when the response carries `tool_calls`.
- **Virtual models** — chains are invoked as `gateway/<chain-name>` or via the
  `X-Chain-ID` header.
- **Security layer** — optional Bearer auth, HTTP security headers, Zod request
  validation, and SSRF prevention.
- **Health endpoints** — liveness (`/health/live`) and backend-gated readiness
  (`/health/ready`).
- **Dashboard UI** — a static SPA at `/ui` for inspecting pipelines, models,
  and executions and building/validating/hot-applying pipeline graphs, backed
  by the `/api/ui/*` REST + SSE surface.
- **Graceful shutdown** — drains in-flight requests before exiting.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.4
- [llama.cpp](https://github.com/ggerganov/llama.cpp) — the `llama-server`
  binary (or `llama` on PATH, see [Configuration](#configuration))
- GGUF model files you want to serve

---

## Installation

```bash
git clone https://github.com/AndyTechnologies/llm-proxy.git
cd llm-proxy
bun install
```

## Quick start

```bash
# 1. Point the config at your llama-server binary and models.
cp config.example.yaml llm-proxy.config.yaml
# 2. Edit llm-proxy.config.yaml (model paths, ports, chains).
# 3. Start the gateway.
bun run dev
```

The gateway will spawn the managed `llama-server` backend and listen on
`http://127.0.0.1:8090` by default. On boot it logs the URL and the list of
virtual models (e.g. `gateway/orchestrator`).

### Try it

```bash
# List available (real + virtual) models
curl http://127.0.0.1:8090/v1/models

# Chat via a chain (non-streaming)
curl http://127.0.0.1:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gateway/orchestrator",
    "messages": [{"role": "user", "content": "Explain what a gateway is"}]
  }'

# Stream
curl -N http://127.0.0.1:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway/orchestrator","stream":true,"messages":[{"role":"user","content":"Hi"}]}'

# Use a chain via header instead of model name
curl http://127.0.0.1:8090/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Chain-ID: coder" \
  -d '{"model":"ignored","messages":[{"role":"user","content":"Write a function"}]}'
```

---

## Configuration

Configuration is loaded from `llm-proxy.config.yaml` or
`llm-proxy.config.json` (or the `CONFIG_FILE` env var). Start from
[`config.example.yaml`](config.example.yaml) — it is the reference.

Top-level shape:

```yaml
server:
  host: 127.0.0.1
  port: 8090
  corsOrigins: "*"
  jsonLimit: 10mb

llama:          # managed llama-server backend
  binary: llama
  port: 8080    # 0 = dynamic ephemeral port read from process output
  autoStart: true
  modelsDir: /path/to/gguf/models
  router: { ctx: 8192, n: 2048, nGpuLayers: -1, ... }
  models: { SmolLM3-3B: { file: model.gguf, ctx: 65536, temp: 0.1 }, ... }

defaultChain: orchestrator

chains:
  orchestrator:
    displayName: "Orchestrator"
    provider: llama-server
    steps:
      - name: generate
        type: generate
        model: SmolLM3-3B
      - name: refine-coder
        type: refine
        model: Qwen2.5-Coder-3B-Instruct
```

### Chain steps

| Step          | Behavior                                                              |
| ------------- | --------------------------------------------------------------------- |
| `generate`    | Seed with the incoming user messages (optionally `system`/`assistant`). |
| `refine`      | Refeed the previous step's output for verification / improvement.     |
| `passthrough` | Forward the request to the provider without transformation.           |

### Conditional routing

- `on_429: <step>` — run `<step>` when this step returns HTTP 429.
- `tool_calls_route: <step>` — run `<step>` when the response carries
  `tool_calls`.

### Environment variables

| Variable       | Purpose                                        |
| -------------- | ---------------------------------------------- |
| `CONFIG_FILE`  | Override the config file path.                 |
| `BEARER_TOKEN` | When set, require `Authorization: Bearer <token>` on every request. |
| `UI_DIR`       | Override the dashboard SPA directory served at `/ui` (default `./src/ui`). |

---

## Scripts

| Command            | Description                            |
| ------------------ | -------------------------------------- |
| `bun run dev`      | Run with watch / hot reload.           |
| `bun run build`    | Bundle to `dist/`.                     |
| `bun run build:binary` | Compile a standalone binary `dist/llm-proxy`. |
| `bun start`        | Run from source.                       |
| `bun test`         | Run tests (`bun:test`).                |
| `bun run typecheck`| Type-check with `tsc --noEmit`.        |
| `bun run lint`     | Lint with ESLint.                      |
| `bun run format`   | Autofix lint issues.                   |

---

## Endpoints

| Method | Path                   | Description                                       |
| ------ | ---------------------- | ------------------------------------------------- |
| POST   | `/v1/chat/completions` | OpenAI-compatible chat (SSE when `stream:true`).  |
| POST   | `/v1/completions`      | Legacy text completions.                          |
| GET    | `/v1/models`           | List real + virtual models.                       |
| GET    | `/health`              | Aggregate health (legacy).                        |
| GET    | `/health/live`         | Liveness.                                         |
| GET    | `/health/ready`        | Readiness (gated on backend running).             |
| GET    | `/ui`                  | Dashboard SPA (static, always open).              |
| GET    | `/api/ui/pipelines`    | Registered pipeline summaries.                    |
| GET    | `/api/ui/models`       | Merged registered + detected models.              |
| GET    | `/api/ui/executions`   | Recent execution history (bounded).               |
| POST   | `/api/ui/pipelines/:id/validate` | Validate a graph draft.                 |
| POST   | `/api/ui/apply`        | Zod-validate + atomically apply a config.         |
| POST   | `/api/ui/executions/:id/steps/:node/retry` | Retry a failed `llm_call` step. |
| GET    | `/api/ui/events`       | SSE event stream (live updates).                  |

---

## Dashboard

The gateway ships a **dashboard SPA** at [`/ui`](http://127.0.0.1:8090/ui) —
a vanilla HTML/CSS/JS editor (no framework, no D3) for inspecting and managing
pipelines:

- Browse **pipelines**, **models**, and **executions**.
- Build a pipeline graph via drag-and-drop (or keyboard: press 1–6 with the
  canvas focused) from `start`, `llm_call`, `condition`, `loop`, `pipeline`,
  and `end` nodes, and connect them.
- Configure `condition` nodes with a **closed-set AST builder** — only
  `compare`, `logical`, `not`, and `exists` over `lastResponse.status`,
  `lastResponse.content`, `error`, and variables. There is **no free-form code
  entry**.
- **Validate** the graph against the `/api/ui/pipelines/:id/validate` endpoint,
  which checks cyclicity (except loop boundaries), model existence, exactly one
  `start` and ≥1 `end`, and required fields per node type.
- **Apply** the composed config via `/api/ui/apply`, which zod-validates and
  writes atomically (a failed apply writes nothing and the editor retains its
  previous state).

The SPA subscribes to `/api/ui/events` (SSE) for live updates: execution
progress, `pipeline:reloaded`, and `models:changed`.

The dashboard REST + SSE surface (`/api/ui/*`) is protected by the same Bearer
auth as the rest of the API when `BEARER_TOKEN` is set; the static `/ui` SPA
remains open (see [Security](#security)).

### Model list semantics (`/api/ui/models`)

`GET /api/ui/models` returns `{ models, modelsDir, autoRefresh }`, where each
model is `{ id, file, loaded }`. The list **merges** two sources:

- **Registered** models from `config.llama.models` — reported with `loaded: true`.
- **Detected** `.gguf` files on disk in `modelsDir` that are **not** in config —
  reported with `loaded: false` as **candidates only**. Detection never
  auto-registers a model; to serve a detected file you must add it to
  `config.llama.models` and **apply** the config (e.g. through the Dashboard).

---

## Architecture

```
src/index.ts       boot: config → backend → chains → providers → Bun.serve
src/server.ts      createApp: single fetch handler (security, auth, routes)
src/shutdown.ts    graceful shutdown / in-flight drain
src/config/        config loading + zod schema
src/backend/       managed llama-server lifecycle (manager, preset, validation)
src/providers/     Provider contract (+ llama-server implementation)
src/orchestrator/  chain parsing (parser) + execution (engine)
src/routes/        HTTP handlers: chat, completions, health, models
src/middleware/    auth guard, error handling, passthrough proxy
src/dashboard/     /api/ui/* REST+SSE, apply, tracker, metrics, retry
src/ui/            dashboard SPA (static HTML/CSS/JS served at /ui)
src/types/         shared + OpenAI types
src/utils/         logging, ids, content extraction, sanitization
```

Notes:

- **Provider abstraction** (`src/providers/types.ts`) isolates all backend
  network interaction, so future providers (OpenAI, Anthropic, …) can plug in
  behind one contract.
- **Managed backend** (`src/backend/manager.ts`) is the source of truth for
  readiness, base URL, and the model registry. The provider derives the
  upstream URL from it.
- **Bun.serve** replaces Express; all handler code is plain fetch functions
  returning `Response`.

The behavior of each capability is specified in
`openspec/specs/<capability>/spec.md`.

---

## Security

- By default the gateway binds to `127.0.0.1` and (without `BEARER_TOKEN`) is
  **unsecured** — keep it on loopback unless you harden it.
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
