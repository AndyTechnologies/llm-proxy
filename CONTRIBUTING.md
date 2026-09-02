# Contributing to llm-proxy

Thanks for your interest in contributing. This project is built with care for
solid architecture, strong type safety, and clean, testable design. The
guidelines below keep the codebase consistent and reviewable.

## Table of contents

- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Development workflow](#development-workflow)
- [Code style](#code-style)
- [Testing](#testing)
- [Specs and SDD](#specs-and-sdd)
- [Commit conventions](#commit-conventions)
- [Pull requests](#pull-requests)
- [Reporting issues](#reporting-issues)

## Development setup

llm-proxy runs on [Bun](https://bun.sh) (≥ 1.4) with strict TypeScript.

```bash
# Install dependencies
bun install

# Development (hot reload)
bun run dev

# Check everything before opening a PR
bun run typecheck
bun run lint
bun test
```

Copy `config.example.yaml` to `llm-proxy.config.yaml` and adjust model paths for
your environment. See the [README](README.md#configuration) for details.

## Project layout

```
src/
  index.ts          # Entry point: boot config → backend → chains → Bun.serve
  server.ts         # createApp: Bun.serve fetch handler (security, auth, routes)
  shutdown.ts       # Graceful shutdown / drain (side-effect-free)
  config/           # Config loading, zod schema, env
  backend/          # Managed llama-server lifecycle (manager, preset, validation)
  providers/        # Provider abstraction (llama-server)
  orchestrator/     # Chain parsing + execution engine
  routes/           # HTTP handlers (chat, completions, health, models)
  middleware/       # Auth guard, error handling, passthrough proxy
  types/            # Shared + OpenAI types
  utils/            # Logging, ids, content extraction, sanitization
```

## Development workflow

This project follows **Spec-Driven Development (SDD)** with **strict TDD**.
Before implementing a change, understand the spec that governs it:

1. Read the relevant spec under `openspec/specs/<capability>/spec.md`.
2. Write a failing test first (TDD), then make it pass.
3. Keep changes focused and reviewable (see the budgets below).

Significant structural changes are planned through SDD artifacts under
`openspec/`. If you are planning a non-trivial change, propose it first so the
design can be reviewed before implementation.

## Code style

- **Strict TypeScript everywhere.** No `any` leakage, no implicit `any`.
  Every interface is explicit.
- **ESM with NodeNext** resolution — imports use explicit `.js` extensions.
- **Pure functions over classes** where possible; dependencies are injected
  (see the provider/manager seams) so units can be tested without mocking.
- **No inline eslint disables.** The lint gate enforces this via
  `noInlineConfig`.
- Underscore-prefixed params (`_x`) are the accepted way to signal unused
  signature-parity arguments — never inline disable directives.

Run the linter, and it will catch style issues:

```bash
bun run lint        # report
bun run format      # autofix
```

## Testing

All tests run with `bun test`. Test files sit next to the code they cover
(`manager.ts` → `manager.test.ts`).

- Prefer **behavior-first** tests over implementation details.
- Isolate the unit under test; use the injected seams and lightweight fakes
  (see `src/orchestrator/engine.test.ts`, `src/routes/stream.test.ts`) instead
  of network calls.
- Cover the edge cases the specs call out (e.g. SSE terminal chunk, client
  disconnect abort, 429 fallback, unknown-model 404).
- Make sure your changes do not regress the streaming and drain tests.

Run the full suite before submitting:

```bash
bun test
```

## Specs and SDD

Capabilities live under `openspec/specs/`:

- `gateway-api` — OpenAI-compatible endpoints and SSE contract
- `gateway-security` — security headers, auth, validation, SSRF prevention
- `backend-management` — managed llama-server lifecycle
- `config-load` — configuration loading and validation
- `pipeline-orchestration` — chain definition and conditional routing
- `proxy-pipeline` — passthrough proxying
- `health-endpoints` — health, liveness, readiness
- `virtual-model-routing` — chain/model resolution

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
- Run `typecheck`, `lint`, and `test` and confirm they pass before requesting
  review.
- Update any affected spec in `openspec/specs/`.

## Reporting issues

- Search existing issues first; the same bug may already be tracked.
- Include: the environment (OS, Bun version), configuration shape (sanitized),
  the expected vs. actual behavior, and a minimal reproduction.
- Do not include secrets, tokens, absolute paths, or private model paths in
  issue reports.
