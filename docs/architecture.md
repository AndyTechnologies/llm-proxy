# WeaveLLM architecture

WeaveLLM is a **local AI desktop runtime**: one Bun process that runs a
managed `llama.cpp` backend, exposes an OpenAI-compatible proxy, executes
workflows as DAGs, and serves its own web UI from the same origin. Everything
is local-first: models, data, and secrets live on the machine.

- **Runtime:** Bun >= 1.4 (`engines.bun`), TypeScript strict mode, ESM with
  NodeNext resolution — imports use explicit `.js` extensions.
- **Server:** a fetch handler on `Bun.serve` (not Express). Entry point:
  `src/main.ts` (boot), `src/app/server.ts` (`createWebServer`).
- **Language of this doc set:**
  - [api.md](./api.md) — HTTP/WS surface and error envelopes
  - [local-backend.md](./local-backend.md) — managed `llama-server` lifecycle
  - [providers.md](./providers.md) — external providers behind one contract
  - [workflows.md](./workflows.md) — the DAG engine and `gateway/<name>` models
  - [desktop-ui.md](./desktop-ui.md) — frontend and desktop shell

## Core design principles

1. **One process, one origin.** The proxy serves the compiled UI from the same
   origin that hosts `/v1`, `/api`, and `/ws`. No separate CORS setup, no
   split domains. API namespaces never serve assets and static assets never
   serve JSON.
2. **Local-first, supervised.** Local inference is a managed `llama-server`
   child per active model with health polling, exponential-backoff restarts,
   and an idle timeout. The hub gates every local request on readiness
   (`503` while a backend is not ready).
3. **One `Provider` contract.** All model backends — local and external —
   implement `chat` / `chatStream` (`src/providers/types.ts`). The orchestrator
   and routes never talk to a vendor SDK; new providers plug in behind the
   same interface.
4. **Workflows are data.** Stored graphs (YAML) become `gateway/<name>`
   virtual models on the OpenAI surface. The engine executes the DAG; routes
   treat it like any other chat model.
5. **Environment-driven config, SQLite state.** Runtime config comes from env
   vars (`src/app/config.ts`); persistent state lives in one SQLite file
   (`<appData>/weavellm.db`, 10 tables, `src/db/schema.ts`). There is no
   config file loaded by the app.
6. **Injectable seams for tests.** Pure factories with injected dependencies
   (`spawnFn`, `now`, `sleep`, `healthCheck`, stores) keep units testable with
   lightweight fakes — no real `llama-server` needed.

## Boot order

`src/main.ts` → `boot()`:

```
appData dirs  →  SQLite (schema)  →  env config  →  keychain secrets
→  provider registry  →  LocalBackendHub.preflight() + restoreActive()
→  workflow store + runtime services + runner  →  auth gate
→  /api handler + /v1 handler + websocket hub  →  HTTP server
→  background update check (non-blocking, offline silent)  →  server.start()
```

Key ordering constraints:

- **`preflight()` runs before the HTTP server starts.** It enforces a
  llama.cpp **b9908+** version floor and fails fast with an actionable boot
  log message when the binary is too old or unparseable. A *missing* binary is
  a per-model error, not a boot blocker.
- **`restoreActive()` also runs before the server starts.** Models persisted
  with `models.active = 1` are re-spawned so the first request never races a
  cold backend.
- The update check is fire-and-forget (`void checkForUpdate(...)`); offline is
  silent.
- Shutdown order (SIGINT/SIGTERM): drain in-flight work and stop all
  llama-server children (`hub.stopAll()`), then stop the HTTP server.

## Module map

| Directory | Responsibility |
| --- | --- |
| `src/main.ts` | Boot: wiring everything together, handshake with the desktop shell |
| `src/app/` | `server.ts` (Bun.serve fetch handler, graceful drain), `config.ts` (env config), `static-ui.ts` (`serveStaticUi`), `ws.ts` (WsHub), `update.ts`, `startup.ts` (cold-start budget), `types.ts` |
| `src/backend/` | Managed llama-server: `hub.ts` (LocalBackendHub), `manager.ts` (LlamaProcessManager), `spawn-args.ts` (spawn flags + version floor) |
| `src/catalog/` | GGUF model catalog + curated metadata |
| `src/db/` | SQLite schema (`schema.ts`), model config mapping |
| `src/downloads/` | Checksum-verified model downloads via the `gosh` engine |
| `src/orchestrator/` | Workflow store, graph validation, engine, runner, YAML parsing |
| `src/providers/` | `Provider` contract, registry, OpenAI/Anthropic/OpenRouter adapters, fallback chains, local llama-server provider, embeddings |
| `src/rag/` | Embeddings, chunking, memory (store backends currently stubbed at boot) |
| `src/routes/` | `/v1` OpenAI-compatible dispatcher, `/api` dispatcher, auth gate, SSE relay |
| `src/sandbox/` | `runSandbox` — code nodes run with `unshare -n` (no network) on Linux |
| `src/secrets/` | `SecretStore` keychain (AES-256-GCM sealed, master key in OS keychain), redaction |
| `src/types/` | Shared + OpenAI wire types |
| `src/ui-svelte/` | Svelte components shared with the renderer |
| `src/utils/` | Logging, ids, content extraction, GGUF helpers, sanitization |
| `frontend/` | Astro 7 static shell (Svelte 5 islands) — compiled by `astro build` and served by the proxy |

## State model

### SQLite (`src/db/schema.ts`)

One database at `<appData>/weavellm.db` with 10 tables:

| Table | Holds |
| --- | --- |
| `models` | Registered models; `active` column drives restore-on-boot |
| `model_config` | Per-model runtime settings (context size, KV cache, layers, flash attention) |
| `workflows` | Stored DAGs as YAML (`name`, `version`, `yaml_graph`) |
| `execution_log` | Workflow run history (status, error, duration) |
| `providers` | External provider rows: kind, base URL, fallback link |
| `secrets` | Sealed secrets (nonce + ciphertext only — see [providers.md](./providers.md)) |
| `kv_memory` | Key/value memory for workflows |
| `chunks` | Document chunks for RAG |
| `downloads` | Model download bookkeeping |
| `settings` | Key/value app settings (e.g. the embedding model designation) |

### Environment config (`src/app/config.ts`)

| Env var | Default | Meaning |
| --- | --- | --- |
| `WEAVELLM_HOST` | `127.0.0.1` | Bind host |
| `WEAVELLM_PORT` | `4317` (`0` = ephemeral) | Bind port |
| `WEAVELLM_AUTH` | off (`0`) | `1`/`true` enables the Bearer auth gate |
| `WEAVELLM_APP_DATA` | OS default (macOS `~/Library/Application Support/weavellm`, Linux `$XDG_DATA_HOME|~/.local/share/weavellm`) | Data dir |
| `WEAVELLM_UI_DIR` | `frontend/dist`, then bundled `ui/` | Compiled UI override |
| `WEAVELLM_LLAMA_BIN` | `llama` on PATH | `llama-server` binary path |

## Request flow

```
Browser / desktop webview / OpenAI client
        │
        ▼
Bun.serve (src/app/server.ts)  ── static? ──► serveStaticUi (GET/HEAD assets,
        │                                        /ui alias, SPA fallback)
        │
        ▼  ┌────────────────────────────────────────────────────────┐
        ├──► /v1/*   → makeV1Handler  → providers → llama-server      │
        ├──► /api/*  → makeApiHandler → hub / workflow store / runner │
        ├──► /ws     → WsHub upgrade → workflow run over websocket    │
        └──► /api/health, update state handled inline in the server   │
                                                                      └
        (auth gate: /v1  and  /api/models only — see api.md)
```

Every `/v1` model request resolves in this order: **external adapter ids →
local backend ids → `gateway/<workflow>`**, then either streams OpenAI-wire
SSE (exactly one terminal `data: [DONE]`, aborting the upstream call on client
disconnect) or answers the OpenAI unknown-model 404 envelope.

## Subsystems at a glance

- **Local backend** — `LocalBackendHub` + `LlamaProcessManager` own spawn,
  readiness, restart, idle-stop, and per-request gating. Details in
  [local-backend.md](./local-backend.md).
- **External providers** — one `Provider` contract; registry built from
  `providers` rows; keychain-backed keys; 3-hop fallback on 429/5xx/network
  errors. Details in [providers.md](./providers.md).
- **Workflow engine** — stored DAGs executed by a wave scheduler; exposed as
  `gateway/<name>` virtual models. Details in [workflows.md](./workflows.md).
- **UI + desktop** — compiled Astro app served from the same origin;
  Electrobun webview shell. Details in [desktop-ui.md](./desktop-ui.md).

## Testing strategy

- Tests live next to code (`manager.ts` → `manager.test.ts`), run with
  `bun test` (scoped to `src/`, 42 colocated files). Frontend colocated tests
  live under `frontend/src/lib/` (24 files) and run by explicit path
  (`bun test frontend/src/lib`), together with `bun run typecheck:frontend`.
- DI seams exist so units run on fakes: `LlamaProcessManager`
  (`spawnFn`/`now`/`sleep`/`healthCheck`), provider adapters (injected
  `fetcher`), stores (injected `db`).
- The SSE contract (terminal chunk, client-disconnect abort, 429 fallback,
  unknown-model 404), the `/v1` dispatcher, the `/api` workflow surface, the
  WS protocol, and the drain/shutdown paths are all covered by colocated
  tests.

## Verification commands

```bash
bun run typecheck          # backend tsc --noEmit
bun run typecheck:frontend # astro check --root frontend
bun run lint               # eslint .
bun test                   # backend tests (bunfig.toml scopes to src/)
bun test frontend/src/lib  # frontend lib tests
```