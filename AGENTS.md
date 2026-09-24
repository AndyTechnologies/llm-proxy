# AGENTS.md

Guidance for LLM coding agents and automated tooling working in this
repository. Read this before editing code.

## Project overview

`weavellm` (WeaveLLM) is a **local AI desktop runtime**: a managed
`llama.cpp` backend (`llama-server`), a visual workflow editor, model
management, and an OpenAI-compatible proxy. Workflows are DAGs
(`nodes` + `edges`) executed by a graph engine and exposed as virtual models
`gateway/<name>`; external providers (openai/anthropic/openrouter) plug in
behind one `Provider` contract.

- **Runtime:** Bun ≥ 1.4 (not Node — do not add Node-specific assumptions).
- **Language:** TypeScript, strict mode. No implicit `any`.
- **Module system:** ESM with NodeNext resolution — imports use explicit `.js`
  extensions.
- **Architecture:** fetch-handler on `Bun.serve` (not Express). Start with
  `src/main.ts` (boot), `src/app/server.ts` (server).

## Stack commands

```bash
bun install            # install dependencies
bun run dev            # backend (watch) + astro dev in parallel, shared terminal
bun run dev:frontend   # astro dev --root frontend
bun run build          # bundle to dist/
bun run build:frontend # astro build --root frontend
bun run build:binary   # compile to dist/weavellm
bun run build:binaries # all platform binaries (scripts/build-binaries.ts)
bun start              # build the UI, then run the Electrobun desktop bundle
                       # via hutch (scripts/start-desktop.ts, --env=dev)
bun test               # run tests (bun:test)
bun run typecheck      # tsc --noEmit (backend only)
bun run typecheck:frontend  # astro check --root frontend
bun run lint           # eslint
bun run format         # eslint --fix
```

Verify with `bun run typecheck && bun run typecheck:frontend && bun run lint && bun test` after any change.

## Architecture map

```
src/main.ts        boot: appData → SQLite → config → secrets → providers →
                   local hub (preflight/restoreActive) → workflows → server →
                   background update check
src/app/           server.ts (createWebServer, graceful shutdown / in-flight
                   drain), config.ts (env config), ws.ts (WsHub), update.ts,
                   startup.ts (cold-start budget), types.ts
src/backend/       managed llama-server lifecycle: hub.ts (LocalBackendHub:
                   preflight, restoreActive, activation, readiness gating),
                   manager.ts (LlamaProcessManager), spawn-args.ts
src/catalog/       GGUF model catalog + curated metadata
src/db/            app-data SQLite schema (schema.ts), model config
src/downloads/     gosh CLI model downloads (checksum-verified)
src/orchestrator/  workflow store (store.ts), graph validation (graph.ts),
                   engine (engine.ts), runner (runner.ts), YAML parsing
                   (workflow-yaml.ts)
src/providers/     Provider contract (types.ts), registry.ts, adapters.ts,
                   llama-server.ts, fallback.ts, embeddings.ts
src/rag/           embeddings, chunking, memory
src/routes/        v1.ts (/v1 OpenAI-compatible dispatcher), api.ts (/api
                   workflow dispatcher), auth.ts (gate), relay.ts (SSE)
src/sandbox/       code execution (runner.ts, unshare -n)
src/secrets/       keychain.ts SecretStore, redact.ts
src/types/         shared + OpenAI types
src/ui-svelte/     Svelte components shared with the renderer
src/utils/         logging (logger.ts), ids, content extraction, GGUF,
                   sanitization
frontend/          Astro 7 renderer shell (Svelte 5 islands, @xyflow/svelte
                   WorkflowEditor) — served COMPILED by the proxy
                   (serveStaticUi from frontend/dist or WEAVELLM_UI_DIR) and
                   dev-served via `bun run dev:frontend` (astro dev, proxies
                   /api, /v1, /ws to the backend)
scripts/           build binaries (build-binaries.ts)
```

Key contracts to respect:

- `Provider` (`src/providers/types.ts`) isolates all backend network
  interaction behind `chat` / `chatStream` — new providers plug in without
  touching the orchestrator or routes.
- `buildProviderRegistry` (`src/providers/registry.ts`) builds the external
  adapters (openai/anthropic/openrouter) from the `providers` DB rows
  (source of truth for kinds, base URLs, fallback links) plus `models` rows;
  keys resolve once from the keychain store (scope `provider:<kind>`), and a
  provider without a stored key is marked `misconfigured` and refuses calls.
- `LlamaProcessManager` (`src/backend/manager.ts`) is the source of truth for
  local backend readiness, base URL, and spawn flags — spawns one
  `llama-server` per active model with `--port 0`, parses the bound port from
  stdout, gates readiness on a health poll, restarts with exponential backoff,
  and stops after an idle timeout. DI seams: `spawnFn`/`now`/`sleep`/
  `healthCheck` (tests inject fakes, no real llama-server needed).
- The workflow runner sits behind `gateway/<name>` virtual models and the
  `X-Chain-ID` header: `makeWorkflowRunner` (`src/orchestrator/runner.ts`) is
  the core execution path invoked by the chat/completions routes.
- `makeV1Handler` (`src/routes/v1.ts`) dispatches the /v1 surface — model
  resolution: external adapter ids → local backend ids → `gateway/<workflow>`;
  unmapped models get the OpenAI unknown-model 404 envelope. Streaming relays
  OpenAI-wire SSE with exactly one terminal `data: [DONE]` and aborts the
  upstream call on client disconnect.
- **Local backend wiring:** boot constructs a `LocalBackendHub`
  (`src/backend/hub.ts`, `binary: config.llamaBin`) and runs `preflight()`
  + `restoreActive()` BEFORE the HTTP server starts. `preflight()` enforces a
  llama.cpp **b9908+** version floor (fail-fast with an actionable message); a
  MISSING binary is a per-model error that does NOT block boot.
  `restoreActive()` re-spawns previously-activated models from the
  `models.active` column. `makeRuntimeServices` receives
  `localProvider`/`localModels`/`embedder` from the hub — and
  **`chunks: () => null`, `memory: () => null`** (RAG chunk/memory stores
  remain unwired). Per-request readiness gating (`ensureReady`): lazy
  re-spawn, concurrent requests join one spawn, up to 30 s, then **503** on
  failure. Embeddings serve through `hub.embedder()` when a model is
  designated via the `settings` table (`embedding_model` key); `/v1/embeddings`
  answers the 404 envelope when none is configured.

## Configuration model

- Runtime config is **environment-driven** (`src/app/config.ts`,
  `resolveAppConfig`): `WEAVELLM_HOST` (default `127.0.0.1`),
  `WEAVELLM_PORT` (default `4317`, `0` = ephemeral, invalid → default),
  `WEAVELLM_AUTH` (`1`/`true` enables the Bearer gate), `WEAVELLM_APP_DATA`,
  `WEAVELLM_UI_DIR` (compiled UI override; else `frontend/dist` then bundled
  `ui/`), `WEAVELLM_LLAMA_BIN` (llama-server path; default `llama` on PATH).
  There is no config file loaded by the app.
- Persistent state is SQLite at `<appData>/weavellm.db` (10 tables: `models`,
  `model_config`, `workflows`, `execution_log`, `providers`, `secrets`,
  `kv_memory`, `chunks`, `downloads`, `settings`). `providers` rows hold
  kinds/base URLs/fallbacks; `workflows` rows hold YAML node/edge graphs; the
  gateway auth key is the keychain secret scoped `auth`. Model lifecycle state
  lives in the `models.active` column (idempotent migration) and is driven by
  the `/api/models/:id/activate|deactivate` routes.
- A **workflow** is a DAG of `nodes` + `edges`: `start` → `llm_call`(s) →
  `end`, with `llm_call` modes `generate`/`refine`/`passthrough` and
  conditional routing (`on_429`, `tool_calls_route`). The full node taxonomy
  (14 types): `start`, `end`, `llm_call`, `condition`, `loop`, `fan`, `join`,
  `pipeline`, `rag_local`, `data.code`, `memory`, `embeddings`, `router`,
  `output`.
- Behavior is specified in `openspec/specs/<capability>/spec.md` (25
  capability specs); keep specs in sync with behavior.

## Conventions

- **Strict type safety** is non-negotiable: explicit interfaces, no `any`,
  no implicit any.
- **Pure functions + injected dependencies** are preferred over classes and
  global mocking. The provider/manager seams exist so units can be tested
  with lightweight fakes.
- **No inline eslint disables.** Use underscore-prefixed params (`_x`) for
  unused signature-parity arguments rather than disabling rules.
- **Tests live next to code** (`manager.ts` → `manager.test.ts`), run with
  `bun test` — `bunfig.toml` scopes discovery to `src/` (`[test] root =
  "./src"`, 42 colocated files). Frontend colocated tests live under
  `frontend/src/lib/` (24 files, plus `frontend/astro.config.test.ts`) and are
  run by explicit path (`bun test frontend/src/lib`), together with
  `bun run typecheck:frontend` — both are local gates today: CI currently runs
  only lint, backend typecheck, and `bun run test`. Cover the SSE contract
  (terminal chunk, client-disconnect abort, 429 fallback, unknown-model 404),
  the /v1 dispatcher, the /api workflow surface, the WS protocol, and the
  drain/shutdown paths.
- Use **conventional commits**; keep commits small, cohesive units. Never add
  `Co-Authored-By` or AI attribution lines.

## Routing / tests

- Follow the SDD artifacts under `openspec/` when implementing a planned
  capability.
- Do not hand candidate bytes to reviewers through `/tmp` or scratch files;
  use provider-issued inspection paths.
- Review and delivery follow ordinary repository policy.