# Archive Report — rewrite-to-gateway

**Change**: rewrite-to-gateway
**Archived**: 2026-09-01
**Archived to**: `openspec/changes/archive/2026-08-31-rewrite-to-gateway/`
**Artifact store mode**: hybrid (Engram + OpenSpec)
**Verdict at close**: PASS — canonical `gentle-ai.verify-result/v1`, evidence_revision `sha256:4950b11f0391b22bbc0e2067daac55293ce83f67f983283792c8f9c09e42e3f3`, 33/33 requirements, 55/55 scenarios, 0 blockers, 0 critical.
**Branch at close**: `rewrite-to-gateway/pr4` (head `6c2ac43`), 4 stacked PRs (pr1–pr4).

## Archive Readiness

- **Task Completion Gate**: PASS. Archived `tasks.md` shows **42/42** tasks checked `[x]`, **0** unchecked. No stale-checkbox reconciliation needed. (Tasks total 42, per archived tasks.md; apply-progress groups the same work into 21/21 units + 4/4 verify-gap closure commits.)
- **Archive readiness**: PASS. Change folder was present with all tracking artifacts (proposal, 6 delta specs, design, tasks, apply-progress, verify-report). `dependencies.archive: ready`; verify report resolved and PASS; no CRITICAL findings.
- **Action context**: `mode: repo-local`; all archive operations inside `allowedEditRoots: [/home/andy/Proyectos/llm-proxy]`.
- **Descriptor**: The OpenSpec dispatcher's `gentle-ai sdd-status rewrite-to-gateway` reported the folder as `<unresolved>` because the active folder is date-prefixed (`2026-08-31-rewrite-to-gateway`, matching the repo's existing archive convention used by `2026-08-31-fix-llm-proxy-bugs`). The orchestrator's launch prompt is the authoritative dispatch, so archive proceeded; the manifest/test status itself was never a blocker.

## Final-State Facts (verified against disk at close)

Per the Final-State Authority hierarchy, the following reflect the state AT CLOSE (rank: archived tasks.md = persisted tasks artifact; orchestrator launch prompt; verify-report/apply-progress as lower-ranked snapshots). All were re-verified against the working tree before archiving:

- **Gateway TS strict complete**: all 6 capabilities operational — `gateway-api`, `pipeline-orchestration`, `virtual-model-routing`, `gateway-security`, `proxy-pipeline`, `backend-management`. `src/` is a clean strict-TS ESM tree (config, types, routes, middleware, orchestrator, providers, utils, backend).
- **Managed backend**: `src/backend/{manager,preset,validation}.ts`. `manager.ts` spawns and supervises `llama serve` (router mode, preset INI, SIGKILL restart backoff, graceful shutdown with no orphans); `preset.ts` renders the `--models-preset` INI; `validation.ts` is the fail-fast startup gate. Real-model list and `baseUrl` come from `manager.status()`, not a static external host.
- **6 chains migrated**: `orchestrator`, `thinker`, `coder`, `verifier` (the 4 original pipelines) plus `fallback-demo` (`on_429`) and `tool-demo` (`tool_calls_route`) demo chains, all in `llm-proxy.config.yaml` and `config.example.yaml`. Old JS (`index.js`, `server.js`, `pipelines.js`, `prompts.js`, `llama-swap/`, `utils/`) deleted; `http-proxy-middleware` and `cors` removed from deps.
- **OpenAI-shaped errors on every path**: 404 `model_not_found` (unknown chain and unknown real model), 503 `backend_unavailable` (chain/passthrough when backend down / `autoStart:false` external mode), 429 `rate_limit_error` (error-normalization path in `middleware/errors.ts`), 400 `validation_error`, 401 `authentication_error`. Verified present in `src/routes/chat.ts`, `completions.ts`, `middleware/proxy.ts`, `middleware/errors.ts`.
- **Verification evidence (observed live in verify run 4950b11f…)**: `pnpm typecheck` exit 0; `pnpm build` exit 0; full runtime smoke against the managed backend + controlled stub harness (`/tmp/opencode/verify/fake-llama.mjs`); engine harness `/tmp/opencode/on429-harness.mjs` 3/3.

## Specs Synced to Catalogs (source of truth)

The project's OpenSpec layout uses `openspec/specs/{domain}/spec.md` as the main-spec source of truth (the "catalog"). Six delta specs from the change were synced:

| Domain | Action | Details |
|--------|--------|---------|
| `gateway-api` | Created | Full spec copied mechanically (byte-identical) — OpenAI endpoints, SSE via `res.pipe()`, normalized errors. |
| `pipeline-orchestration` | Created | Full spec copied mechanically (byte-identical) — chain config, sequential execution, `on_429`, `tool_calls_route`, context passing. |
| `virtual-model-routing` | Created | Full spec copied mechanically (byte-identical) — `gateway/<chain>` + `X-Chain-ID`, model listing, passthrough. |
| `gateway-security` | Created | Full spec copied mechanically (byte-identical) — helmet, Bearer auth, zod validation, SSRF guard. |
| `backend-management` | Created | Full spec copied mechanically (byte-identical) — spawn/supervise, router mode, preset INI, readiness gate, graceful shutdown, health, fail-fast validation. |
| `proxy-pipeline` | Updated (merge) | Existing main spec (5 non-regression invariants from fix-llm-proxy-bugs) merged with the delta's 5 MODIFIED requirements + 1 REMOVED requirement. See merge note below. |

Mechanical copies (domains with no pre-existing main spec) were made with native `cp`/`mv` via the shell and verified with `diff -r` — each produced **empty diff output** (byte-identical), the only passing evidence, included in this phase result.

### proxy-pipeline merge note (transparent deviation)

The `rewrite-to-gateway` proxy-pipeline delta (a genuine MODIFIED/REMOVED delta, not a full spec) was authored as a merge into the existing main spec:

- The 5 MODIFIED requirement bodies were carried verbatim into the merged main spec under `## Requirements` (matching the spec-authoring convention), and the original `## Invariants` framing was retired since a main spec now demonstrably exists.
- One deliberate adjustment: the delta requirement text said the system SHALL proxy "via http-proxy-middleware". That clause was **omitted from the source-of-truth main spec** because it contradicts the verified final state: `http-proxy-middleware` was removed during implementation (verify-report line 43 records `http-proxy-middleware in deps = 0`, replaced by a fetch-based forwarder in `middleware/proxy.ts`, apply-progress deviation #2). Keeping it would persist a false contract in the catalog. The merge did NOT weaken any requirement otherwise; all scenario bodies match the delta exactly (only whitespace/blank-line differences from dropping the `(Previously:…)` notes, which are delta-only and not part of a main spec).
- The REMOVED requirement (`llama-swap process management`, Reason+Migration present) was NOT installed in the main spec (it was never there) and is recorded in a `## Removed` traceability section.

## Archive Move (mechanical)

- Before move, destination `openspec/changes/archive/2026-08-31-rewrite-to-gateway` did not exist (collision guard passed).
- Snapshot: recursive `cp -R` of the whole change folder (including the untracked `verify-report.md`) taken before any move attempt.
- Move: `git mv` failed (the change folder contains the untracked `verify-report.md`), so the contract's safe fallback path ran: source re-verified byte-identical to the snapshot (empty `diff -r`), then plain `mv`. Final readback `diff -r <snapshot/source> <destination>` → **empty output** (no differences). Source directory absent after move.
- The `archive-report.md` written into the archived folder is additive-only and was excluded from the readback (it did not exist in the source snapshot), per the mechanical copy contract.

## Pending Items Documented for the Repository (NOT blockers of this change)

These are known repository follow-ups surfaced by verification and disk inspection; none blocks the SDD cycle and none is part of the change's scope:

1. **Port-collision readiness false-positive** (verify-report WARNING 1; SUGGESTION 1): when a foreign process already holds `llama.port`, the health poll can answer from the foreign listener while the spawned child crash-loops (`couldn't bind HTTP server socket`), so `manager` logs `backend ready` spuriously. SUGGESTION: verify the health respondent is the spawned pid. Non-blocking; supervision still restarts correctly.
2. **`startupTimeoutMs`/`requestTimeoutMs` not configurable** (verify-report WARNING 2): fixed 30s/15s in configs; no knob to raise for slow first GPU load. SUGGESTION 2 optional.
3. **Dead `response-429` path in the engine** (engine.ts lines 222–236 region): the 429 handling that inspects a response `status` on a non-streamed step is effectively dormant because the provider returns streamed/unified errors; the live 429 evidence goes through the thrown-error branch and the harness. Not a defect — the `on_429` fallback is fully covered and passes — but the metadata path is redundant. Documented for a future cleanup.
4. **`buildUrl` duplicated call** (`src/providers/llama-server.ts` lines ~91/136 and ~141): `url` is built once for logging and then rebuilt for `fetch(...)`. Cosmetic; could hoist the single `url` variable. No behavior impact.
5. **eslint scope**: `eslint.config.js` matches both `**/*.js` and `**/*.ts`, so TS is covered; the "scoped to *.js+Error" note in earlier planning is superseded — verify current lint config already covers TS. Any residual lint-hardening follow-up is repo policy, not an archive blocker.
6. **PRs not yet opened**: pr1–pr4 are stacked branches without pushes/PRs. Opening the PRs and chaining them to main is a delivery step owned by ordinary repository policy (this archive does not open PRs).

## Engram Traceability

- `verify-report` (canonical, evidence_revision `sha256:4950b11f…e3f3`): Engram **#55** `sdd/rewrite-to-gateway/verify-report`.
- `apply-progress`: Engram **#54** `sdd/rewrite-to-gateway/apply-progress`.
- This archive report: Engram `sdd/rewrite-to-gateway/archive-report` (updates topic; Net observation created this archive) + this filesystem file.

## Verdict

The `rewrite-to-gateway` SDD cycle is **complete**. Planned, implemented (4 stacked PRs + gap-closure `6c2ac43`), independently verified PASS (55/55 scenarios, 33/33 requirements), and now archived with byte-identical artifact preservation. Ready for delivery (opening the pr1–pr4 PRs) and for the next change.