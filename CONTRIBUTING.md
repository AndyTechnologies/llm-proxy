# Contributing to WeaveLLM

Thanks for your interest in contributing. WeaveLLM is a local AI desktop
runtime built with care for solid architecture, strong type safety, and clean,
testable design. This guide covers the setup, layout, conventions, and checks
that keep the codebase consistent and reviewable.

## Quick path

1. `bun install`
2. `bun run dev` — backend (watch) + Astro dev console in parallel, shared
   terminal; Ctrl+C kills both.
3. Make a change and update its colocated test.
4. Check everything before opening a PR:

```bash
bun run typecheck
bun run typecheck:frontend
bun run lint
bun test
```

## Development setup

- **Bun ≥ 1.4** is required — the runtime targets Bun (not Node; do not add
  Node-specific assumptions).
- **Strict TypeScript** everywhere (ESM, NodeNext resolution, explicit `.js`
  import extensions).
- **llama-server** (`llama.cpp` **b9908+**) is needed to exercise local
  models: either on `PATH` as `llama`, or via `WEAVELLM_LLAMA_BIN`.
- **No config file.** The runtime is environment-configured (see
  [README → Configuration](README.md#configuration)); all six
  `WEAVELLM_*` variables have safe defaults.

| Command              | What it runs                                                        |
| -------------------- | ------------------------------------------------------------------- |
| `bun run dev`        | Backend (`bun run --watch src/main.ts`) + Astro dev in parallel (`scripts/dev.ts`) |
| `bun run dev:frontend` | Astro dev server for the console (proxies `/api`, `/v1`, `/ws` to the backend) |
| `bun run build`      | Bundle the backend to `dist/`                                        |
| `bun run build:frontend` | Build the Astro console shell                                    |
| `bun run build:binary` / `build:binaries` | Desktop binaries (`scripts/build-binary.ts` / `build-binaries.ts`) |
| `bun start`          | Build the UI, then run the Electrobun desktop bundle via hutch (`scripts/start-desktop.ts`, `--env=dev`) |
| `bun test`           | Unit/integration tests (`bun:test`, scoped to `src/` via `bunfig.toml`) |
| `bun run typecheck`  | `tsc --noEmit` (backend; does NOT cover `frontend/`)                 |
| `bun run typecheck:frontend` | `astro check --root frontend` (the frontend type gate)         |
| `bun run lint` / `format` | ESLint (report / autofix)                                       |

## Project layout

```
src/main.ts        boot: appData → SQLite → config → secrets → providers →
                   local hub (preflight/restoreActive) → workflows → server →
                   background update check
src/app/           server.ts (createWebServer, graceful drain, serveStaticUi),
                   config.ts (env config), ws.ts (WsHub), update.ts,
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
                   WorkflowEditor) — served compiled by the app server
                   (serveStaticUi from frontend/dist or WEAVELLM_UI_DIR); its
                   own dev server proxies /api, /v1, /ws to the backend
scripts/           dev launcher (dev.ts), desktop start (start-desktop.ts),
                   build binaries (build-binary.ts, build-binaries.ts)
```

Key contracts to respect (details in [AGENTS.md](AGENTS.md)):

- `Provider` (`src/providers/types.ts`) isolates all backend network
  interaction behind `chat` / `chatStream` — new providers plug in without
  touching the orchestrator or routes.
- `LocalBackendHub` (`src/backend/hub.ts`) owns the managed llama-server
  lifecycle, is the source of truth for local readiness/base URLs, and gates
  every local request (`ensureReady`, 30 s cap, 503 on failure).
- Fetch-handler on `Bun.serve` — no Express.

## Development workflow

This project follows **Spec-Driven Development (SDD)** with **strict TDD**.
Before implementing a change, understand the spec that governs it:

1. Read the relevant spec under `openspec/specs/<capability>/spec.md`.
2. Write a failing test first (TDD), then make it pass.
3. Keep changes focused and reviewable (see the PR budgets below).

Significant structural changes are planned through SDD artifacts under
`openspec/`. If you are planning a non-trivial change, propose it first so the
design can be reviewed before implementation.

## Code style

- **Strict TypeScript everywhere.** No `any` leakage, no implicit `any`.
  Every interface is explicit.
- **ESM with NodeNext** resolution — imports use explicit `.js` extensions.
- **Pure functions + injected dependencies** are preferred over classes and
  global mocking. The provider/manager seams exist so units can be tested
  with lightweight fakes (no real llama-server or network calls needed).
- **No inline eslint disables** (`noInlineConfig`). Underscore-prefixed
  params (`_x`) signal unused signature-parity arguments.

```bash
bun run lint        # report
bun run format      # autofix
```

## Testing

All tests are colocated with the code they cover (`manager.ts` →
`manager.test.ts`), behavior-first, with fakes injected through the existing
seams — never network calls.

- **Backend:** `bun test` discovers `src/` via `bunfig.toml` (`[test] root =
  "./src"`, 42 colocated files). Real examples: `src/routes/v1.test.ts`
  (dispatcher + SSE contract), `src/backend/manager.test.ts` (spawn/restart/
  idle with an injected fake spawn), `src/routes/api.test.ts` (workflow + model
  surface).
- **Frontend:** 25 colocated tests — 24 under `frontend/src/lib/` plus
  `frontend/astro.config.test.ts` — covering the typed API clients, the WS/SSE
  state machine, and UI state. Run by explicit path:
  `bun test frontend/src/lib`.
- **No Playwright e2e yet** — the CI `e2e` job is disabled until a console
  e2e suite lands. Do not claim e2e coverage exists.
- Make sure your changes do not regress the streaming and drain tests
  (terminal SSE chunk, client-disconnect abort, 429 fallback, unknown-model
  404).

Before submitting, run the full gates: `bun run typecheck &&
bun run typecheck:frontend && bun run lint && bun test`.

## Specs and SDD

Capabilities live under `openspec/specs/` (25 directories):

- `backend-management`, `config-load`, `dashboard-api`, `dashboard-ui`,
  `data-code-sandbox`, `desktop-app-shell`, `embeddings-rag`,
  `external-providers`, `external-proxy`, `gateway-api`, `gateway-security`,
  `gguf-metadata`, `graph-engine`, `health-endpoints`, `keychain-secrets`,
  `local-model-catalog`, `model-advanced-config`, `model-downloads`,
  `pipeline-composition`, `pipeline-orchestration`, `proxy-pipeline`,
  `virtual-model-routing`, `websocket-streaming`, `workflow-editor`,
  `workflow-engine`

When a change touches a capability, update its spec so docs and behavior stay
in sync.

## Commit conventions

We use [conventional commits](https://www.conventionalcommits.org/):

- `feat(...)` — a new capability
- `fix(...)` — a bug fix
- `refactor(...)` — behavior-preserving restructuring
- `test(...)` — test-only changes
- `build(...)` / `chore(...)` / `docs(...)` / `style(...)` — supporting changes

Keep each commit a single, coherent unit of work with its tests and docs. Do
not add `Co-Authored-By` or AI attribution lines.

## Pull requests

- Keep PRs **focused**. A change that adds or modifies a capability should stay
  under ~400 changed lines unless discussed; larger changes should be split
  into reviewable slices.
- Include a short description of the problem and the approach.
- Run `typecheck`, `typecheck:frontend`, `lint`, and `test` and confirm they
  pass before requesting review.
- Update any affected spec in `openspec/specs/`.
- CI runs the same gates on every PR to `master` (install with a frozen
  lockfile → lint → typecheck → `bun run test`); the Playwright `e2e` job is
  currently disabled.

## Reporting issues

- Search existing issues first; the same bug may already be tracked.
- Include: the environment (OS, Bun version), the configuration shape
  (environment variables, sanitized), the expected vs. actual behavior, and a
  minimal reproduction.
- Do not include secrets, tokens, API keys, or absolute paths in issue
  reports.