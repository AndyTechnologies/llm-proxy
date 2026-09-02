# AGENTS.md

Guidance for LLM coding agents and automated tooling working in this
repository. Read this before editing code.

## Project overview

`llm-proxy` is an **intelligent LLM gateway**: it runs local `llama.cpp`
models (via a managed `llama-server` backend) behind an OpenAI-compatible API,
and lets you compose those models into **chains** (ordered orchestration
pipelines) that are exposed as virtual models.

- **Runtime:** Bun ≥ 1.4 (not Node — do not add Node-specific assumptions).
- **Language:** TypeScript, strict mode. No implicit `any`.
- **Module system:** ESM with NodeNext resolution — imports use explicit `.js`
  extensions.
- **Architecture:** fetch-handler on `Bun.serve` (not Express). Start with
  `src/index.ts`, `src/server.ts`.

## Stack commands

```bash
bun install          # install dependencies
bun run dev          # dev with watch
bun run build        # bundle to dist/
bun run build:binary # compile to dist/llm-proxy binary
bun start            # run from source
bun test             # run tests (bun:test)
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
bun run format       # eslint --fix
```

Verify with `bun run typecheck && bun run lint && bun test` after any change.

## Architecture map

```
src/index.ts       boot: config → backend → chains → providers → Bun.serve
src/server.ts      createApp: single fetch handler (security, auth, routes)
src/shutdown.ts    graceful shutdown / in-flight drain (pure, testable)
src/config/        config loading + zod schema
src/backend/       managed llama-server lifecycle (manager, preset, validation)
src/providers/     Provider contract (+ llama-server implementation)
src/orchestrator/  chain parsing (parser) + execution (engine)
src/routes/        HTTP handlers: chat, completions, health, models
src/middleware/    auth guard, error handling, passthrough proxy
src/types/         shared + OpenAI types
src/utils/         logging, ids, content extraction, sanitization
```

Key contracts to respect:

- `Provider` (`src/providers/types.ts`) isolates all backend network
  interaction — new providers plug in behind it without touching the
  orchestrator or routes.
- `runChain` (`src/orchestrator/engine.ts`) interprets chain steps and
  conditional routing; it is the core orchestration path invoked by the
  chat/completions routes.
- The managed backend state lives in `src/backend/manager.ts` and is the
  source of truth for readiness, base URL, and model registry.

## Configuration model

- Config is loaded from `llm-proxy.config.yaml`/`.json` (or the `CONFIG_FILE`
  env var). `config.example.yaml` is the reference.
- Top-level shape: `server`, `llama` (managed backend), `defaultChain`,
  `chains`.
- A **chain** is a list of ordered steps (`generate`, `refine`, `passthrough`)
  with optional conditional routing (`on_429`, `tool_calls_route`).
- Chains are exposed as virtual models `gateway/<chain-name>` or selected via
  the `X-Chain-ID` header.
- Behavior is specified in `openspec/specs/<capability>/spec.md`; keep specs in
  sync with behavior.

## Conventions

- **Strict type safety** is non-negotiable: explicit interfaces, no `any`,
  no implicit any.
- **Pure functions + injected dependencies** are preferred over classes and
  global mocking. The provider/manager seams exist so units can be tested
  with lightweight fakes.
- **No inline eslint disables.** Use underscore-prefixed params (`_x`) for
  unused signature-parity arguments rather than disabling rules.
- **Tests live next to code** (`manager.ts` → `manager.test.ts`), run with
  `bun test`. Cover the SSE contract (terminal chunk, client-disconnect abort,
  429 fallback, unknown-model 404) and the drain/shutdown paths.
- Use **conventional commits**; keep commits small, cohesive units. Never add
  `Co-Authored-By` or AI attribution lines.

## Routing / tests

- Follow the SDD artifacts under `openspec/` when implementing a planned
  capability.
- Do not hand candidate bytes to reviewers through `/tmp` or scratch files;
  use provider-issued inspection paths.
- Review and delivery follow ordinary repository policy.
