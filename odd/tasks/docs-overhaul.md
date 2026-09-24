# docs-overhaul — Documentation update after the WeaveLLM 0.1.0 + backend-wiring + admin-console work

- **Objective**: Bring every documentation artifact in the repo up to date with the current
  runtime (master @ efcfbc6, post PR #44) and fill the empty `docs/` tree.
- **Problem**: README/AGENTS/CONTRIBUTING/CHANGELOG/openspec config-load spec contradict the
  current code (notably the "local backend NOT wired" claims) and the admin console is
  undocumented; root legacy configs are dead weight; `docs/` is empty.
- **Why**: User requested a full documentation overhaul (2026-09-24), scope approved as
  "Plan completo" (update all stale markdown + create docs/ + remove legacy configs + sync
  config-load spec).
- **Scope**: Documentation and stale-artifact cleanup only. No runtime behavior changes.
- **Constraints**: Technical artifacts in English. Conventional commits, no AI attribution.
  No code edits beyond removing the three legacy root config files.
- **Acceptance criteria**: Every claim in README/AGENTS/CONTRIBUTING/CHANGELOG matches the
  code; `docs/` covers architecture, API surface, local backend, providers, workflows, and
  desktop UI; legacy configs gone with no dangling references; config-load spec reflects the
  env-driven runtime; `bun run typecheck && bun run lint && bun test` still pass.

## Delivery forecast

- Estimated authored changed lines: ~2,500+ (READM. +13.7K rewrite chunks, AGENTS/CONTRIB/CANGELOG edits, 6 new docs). Exceeds the ~400 line heuristic.
- RDD tier (forecast): passive (docs-only). Verify with native assess; expected `passive` → silent structural checks, no reviewer ceremony.
- Delivery strategy: `ask-on-risk` (default). Contemplate 2–3 work-unit slices at review time.

## Tasks

- [x] T01 — README.md: current-status (local backend IS wired), scripts table, env vars
      (`WEAVELLM_UI_DIR`, `WEAVELLM_LLAMA_BIN`), endpoint table (`/api/models*`),
      desktop/admin-console section, links to `docs/`. Checks: grep claims vs `src/app/config.ts`,
      `src/main.ts`, `src/routes/api.ts`. DONE: committed in WU1.
- [x] T02 — AGENTS.md: drop the false "Boot wiring limitation" block, add `hub.ts` to the
      architecture map, add env vars + `/api/models` + `models.active` to the config model.
      Checks: no claim contradicts `src/main.ts`/`src/backend/hub.ts`. DONE: committed in WU1.
- [x] T03 — CONTRIBUTING.md: rewrite with the real layout, setup, run scripts, testing,
      specs list, commit/PR conventions. Checks: every referenced path exists.
      DONE: committed in WU1.
- [x] T04 — CHANGELOG.md: add [Unreleased] entries for the admin console (PR #44) and any
      wiring items missing. Checks: entries match merged commits. DONE: committed in WU1.
- [ ] T05 — docs/architecture.md: boot order, module map, provider seam, hub, data model.
- [ ] T06 — docs/api.md: full HTTP + WS reference (`/v1/*`, `/api/*`, `/api/health`, `/ws`).
- [ ] T07 — docs/local-backend.md: llama-server lifecycle, hub, activation, embeddings,
      `WEAVELLM_LLAMA_BIN`, dimensions from `src/backend/`.
- [ ] T08 — docs/providers.md: external providers, keychain scopes, fallback.
- [ ] T09 — docs/workflows.md: DAG/YAML shape, node taxonomy, engine semantics, gateway
      virtual models, workflow API.
- [ ] T10 — docs/desktop-ui.md: frontend shell, admin console pages, build/dev flows.
- [ ] T11 — Remove legacy root configs (`config.example.yaml`, `llm-proxy.config.yaml`,
      `llama-swap.config.yaml`) via `git rm`; no code/test references them. Checks: grep for
      references in code/tests/CI returns nothing; full test suite passes.
- [ ] T12 — Update `openspec/specs/config-load/spec.md` to the env-driven runtime
      (`resolveAppConfig`, `WEAVELLM_*` env) and drop `CONFIG_FILE`/`llm-proxy.config.yaml`
      requirements. Checks: spec no longer contradicts `src/app/config.ts`.

## Work-unit boundaries (provisional)

- WU1: T01–T04 (root markdown) — `docs(root): refresh README, AGENTS, CONTRIBUTING, CHANGELOG to current runtime`
- WU2: T05–T10 (docs tree) — `docs: add architecture, API, local-backend, providers, workflows, desktop-ui guides`
- WU3: T11–T12 (cleanup + spec) — `chore(config): remove legacy root configs and sync config-load spec`

## Progress / evidence

- WU1 (T01–T04) DONE — writer's diff reviewed by orchestrator; 1 parent fix applied: AGENTS.md +
  CHANGELOG wrongly claimed `typecheck:frontend`/frontend tests are CI-gated PR checks
  (ci.yml runs only lint, backend typecheck, `bun run test`); corrected wording to "local gates
  today". Checks run on WU1: rg stale-phrase grep clean, `bun run typecheck` pass, `bun run lint` pass.
- T05..T12 pending (WU2 = docs tree, WU3 = config cleanup + spec).

## Next step

- Launch WU2 writer: create `docs/architecture.md`, `docs/api.md`, `docs/local-backend.md`,
  `docs/providers.md`, `docs/workflows.md`, `docs/desktop-ui.md` using the verified fact base
  (see summary); then verify + commit; then WU3 (`git rm` legacy configs + config-load spec rewrite).