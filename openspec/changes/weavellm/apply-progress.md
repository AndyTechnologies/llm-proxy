# Apply Progress: WeaveLLM Rewrite

- **Change**: weavellm
- **Store mode**: hybrid (this file + Engram observation, topic `sdd/weavellm/apply-progress`)
- **Delivery**: `size:exception` single PR — workload forecast read, user accepted the exception, chain strategy `none`
- **Mode**: Strict TDD — every task RED test → GREEN implementation; Work Unit Evidence per phase
- **Tasks**: 50/50 `[x]` in `openspec/changes/weavellm/tasks.md`

## Workload decision (Step 2a)

`Review Workload Forecast` (tasks.md): 6k–12k lines, High budget risk, Chained PRs recommended: Yes → **RESOLVED**: user accepted `size:exception`, single PR. Chain strategy: none. No code/tests/docs were trimmed to fit a budget.

## Per-phase Work Unit Evidence

Every phase below: focused test command + exact result, runtime harness command/scenario + exact result, and rollback boundary (an atomic revert that never removes unrelated work).

| Phase (commit) | Tasks | Focused test (result) | Runtime harness (result) | Rollback boundary |
|---|---|---|---|---|
| 1 — Shell & Foundation (`a9740cb`) | 1.1–1.7 | `bun test src/db` green; full suite green at phase end | `bun run dev` boots real `Bun.serve` (loopback, JSON logs, health) | revert shell/frontend commit |
| 2 — Backend & Model Config (`6751642`) | 2.1–2.8 | `bun test src/backend src/utils/gguf.ts` green | llama-server spawn with `--port 0`, health, idle kill/restart (fake + real binary paths) | revert backend/gguf commit |
| 3 — Catalog & Downloads (`fb079fc`) | 3.1–3.7 | `bun test src/downloads src/catalog` green; suite 195 pass / 18 files | fake `gosh` driver exercising queue/resume/cancel state machine | revert downloads/catalog commit |
| 4 — Secrets, Providers, Proxy (`8a67dae`) | 4.1–4.9 | `bun test src/routes/` → 30 pass (relay 4, v1 12, auth 7, server wiring 7); full suite **278 pass / 29 files** | real sockets: boot test drives real `Request`/`Response` bodies + SSE `ReadableStream`; relay/v1/auth over real fetch with fake upstreams | revert commit `8a67dae` (28 files, +3503/−10) |
| 5 — Sandbox, Embeddings, RAG (`c9a6222`) | 5.1–5.7 | `bun test src/sandbox src/rag` green | net-block probe (sandboxed run cannot reach network / FS / secrets); embed→retrieve path with injected embedder | revert sandbox/rag commit |
| 6a — Engine, MoA, routing (`cc2363b` + 6.1–6.6) | 6.1–6.6 | `bun test src/orchestrator` green | boot harness `src/main.test.ts`: gateway model in `/v1/models`, real run → 200 `gateway/demo` | revert engine commits |
| 6b — YAML + CRUD (`b78d287`, `e98c986`) | 6.8, 6.10 | `bun test src/orchestrator/workflow-yaml.test.ts` green; CRUD suite green | boot CRUD: PUT/GET `/api/workflows`, run/log endpoints over real `WorkflowStore` | revert YAML / CRUD commits |
| 6c — Editor (`b7b46e3`) | 6.7 | `bun test ./frontend/src/lib/` → **16 pass / 32 expect** (10 workflow-nodes + 6 format) | `bun run build:frontend` → astro build **Complete** (Svelte 5 + SvelteFlow 1.6.6 compile clean; island mounts) | revert editor commit (frontend-only: 3 new files + `index.astro` island block) |
| 6d — /ws (`e00ea48`) | 6.9 | `bun test src/app/ws.test.ts` → 6 real-socket integration tests green; full suite **422 pass / 41 files** | real `/ws` at boot (`src/main.test.ts`): bind→run→exactly one `data: [DONE]`→status ok; disconnect aborts upstream | revert ws commit |
| 7 — Cleanup & gate | 7.1, 7.2 | `bun test` → **382 pass / 0 fail / 39 files** (deleted suites exactly removed: 422→382, 41→39) | `bun run build` → bundled main.js 0.33 MB / 100 modules; `bun run build:frontend` → Complete | revert 7.1 commit (delete-only: −1659 lines + lockfile) |

Final gate (7.2): `bun run typecheck` clean · `bun run lint` clean · `bun test` 382 pass / 0 fail / 39 files · `bun run build` ✓ · `bun run build:frontend` ✓ · frontend lib suite 16 pass.

## Task status (all 50)

- Phase 1 (1.1–1.7): all `[x]` · Phase 2 (2.1–2.8): all `[x]` · Phase 3 (3.1–3.7): all `[x]`
- Phase 4 (4.1–4.9): all `[x]` · Phase 5 (5.1–5.7): all `[x]`
- Phase 6 (6.1–6.10): all `[x]` · Phase 7 (7.1–7.2): all `[x]`

## Commit list

```
a9740cb  feat(shell): Phase 1 foundation
6751642  feat(backend): Phase 2 backend + model config
fb079fc  feat(catalog): Phase 3 catalog + downloads
8a67dae  feat(proxy): Phase 4 secrets, providers, /v1 proxy
c9a6222  feat(sandbox): Phase 5 sandbox, embeddings, RAG
cc2363b  feat(engine): MoA 3+1 parallel synthesis (6.4)
b78d287  feat(workflow): YAML interchange with node-named parse errors (6.8)
e98c986  feat(api): workflow CRUD + run/log endpoints (6.10)
7367abd  feat(workflow): wire gateway routing and runtime at boot (6.6)
e00ea48  feat(ws): stream workflow runs over /ws (6.9)
b7b46e3  feat(editor): workflow canvas, palette, inline errors (6.7)
687b536  chore(providers): drop legacy OpenAI SDK surface (7.1)
<docs>   chore(apply): 7.2 final gate + apply-progress artifact (this closeout; SHA = final head of this change)
```

## Deviations from design / known limitations

1. Provider set per binding decision: local + OpenAI + Anthropic + OpenRouter (spec listed Google/Groq; design Open Question overruled).
2. Managed llama-server backend is **not spawned at boot** — `localProvider: () => null`; local model ids answer the unknown-model 404 envelope until a model-selection UX is wired. Four-provider routing fully exercised via injected fakes.
3. Sandbox seam: `runSandbox` is timeout-bounded but does not honor `AbortSignal` (upstream abort is best-effort through the kill/timeout path).
4. `token` ws events relay the **completed** run's upstream SSE in one chunk with exactly one `data: [DONE]` — the engine is not token-streaming (faithful to design; streaming remains a future engine feature).
5. `bunfig.toml` scopes `bun test` to `./src` (keeps Playwright E2E out) → frontend lib tests run via explicit path: `bun test ./frontend/src/lib/`.
6. Auth default off (`authEnabled: false`); when on, timing-safe single Bearer token vs keychain scope `auth`.
7. External embeddings not proxied; `/v1/embeddings` is local-only.
8. **Git tag pending**: no tag-capable tool in the apply session → propose `v0.1.0` at the final commit SHA for the orchestrator/user.

## Workload / PR boundary

- Mode: `size:exception` (single PR)
- Boundary: full change, 12 commits, ~50 tasks, 5 test layers + 2 build gates
- Reviewed in this batch: 6.6 (boot wiring), 6.9 (/ws), 6.7 (editor), 7.1 (legacy removal), 7.2 (final gate/docs) — all committed autonomously per work-unit boundaries above.