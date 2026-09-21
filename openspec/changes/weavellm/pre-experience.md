# Pre-Experience — weavellm

Close retrospective between changelog and archive. FAIL-OPEN: nothing in this phase blocks archive.

- **Change**: `weavellm` (full rewrite as WeaveLLM)
- **Phase**: pre-experience (fixed close order: changelog → pre-experience → archive → PR ready)
- **Date**: 2026-09-15
- **Store mode**: hybrid (this file + Engram observation, topic `sdd/weavellm/pre-experience`)
- **Source**: session failure log, cross-checked against `openspec/changes/weavellm/{apply-progress,verify-report,architecture-lint,hard-verify,hard-gate}.md` and Engram observation #643 (hard-gate verdict)

## Failures / incident log

Each entry states WHAT failed, WHERE, and the CORRECTION taken.

### F1 — Plugin preflight state loss mid-session
- **What**: Plugin preflight state was lost mid-session, causing repeated re-presentation of the same `question` items instead of a single grouped canonical preflight.
- **Where**: Session/plugin preflight layer (no repo artifact affected).
- **Correction**: Canonical grouped preflight adopted — retries present the full grouped preflight once rather than re-asking items one by one.

### F2 — Task-tool permission rejections
- **What**: `sdd-council` was blocked by task permission patterns (agent not in the orchestrator allow-list); model-authored preflight heading text was refused intermittently.
- **Where**: Orchestrator task dispatch and preflight heading construction.
- **Correction**: Council remains retained machinery, unreachable from the canonical flow (D8); architecture review is split into the pre-design Architecture Plan plus the ALWAYS-on post-apply architecture lint. Preflight heading text now comes from the canonical grouped preflight instead of model-authored text.

### F3 — Transport / transient failures
- **What**: `getaddrinfo ETIMEOUT opencode.ai` and `Rate limit exceeded` on the sdd-apply final batch.
- **Where**: Network transport to opencode.ai; API rate limit on the final apply batch.
- **Correction**: Retry with backoff. No work or evidence was lost — all 50 tasks committed and apply-progress evidence remained intact.

### F4 — Ledger budget friction (`max_changed_lines`)
- **What**: The 400-line default `max_changed_lines` budget collided with the `size:exception` reality of the change (37,650 changed lines) and with read-only phase reports (665-line `hard-gate.md` acquired under a 1-line budget).
- **Where**: `sdd-attempt` ledger acquire/settle — two maintainer resets required (apply-phase-1, hard-gate-adversarial read-only).
- **Correction**: Maintainer resets with expected-revision sha256 (apply-phase-1 `size:exception`; hard-gate expected-revision `c013312e…`); ledger attempt 4 settled passed after the reset (evidence `sha256:2e88d480…`). Read-only phase artifacts should be exempt from — or accounted with a realistic budget in — acquire's `max_changed_lines` (see C1).

### F5 — Untracked inventory churn at settle
- **What**: Every settle required a re-declaration with a fresh expected-untracked-inventory sha256 as new phase artifacts appeared in the change folder.
- **Where**: `sdd-attempt` settle choreography.
- **Correction**: Settle flow requires `--untracked-scope select` plus `expected-untracked-inventory`; when blocked, route from the settle's blocked state and disclose the new inventory hash to the maintainer (see C1).

### F6 — Sandbox `AbortSignal` seam dropped at wiring (A1-3)
- **What**: `EngineServices.runCode(code, input, opts)` declares `opts.signal`, but the wiring drops it: `src/main.ts` `sandbox: (code, input, _opts) => runSandbox(code, { input })`.
- **Where**: `src/main.ts` wiring seam; `src/sandbox/runner.ts` (timeout-bounded, never infinite).
- **Correction**: Disclosed as a declared limitation in verify-report / architecture-lint / hard-gate (A1-3). Follow-up: honor or remove `opts.signal` from the `EngineServices.runCode` contract so the cancellation promise is not false.

### F7 — Test-root scope hides `e2e/` and `scripts/` from `bun test`
- **What**: `bunfig.toml` scopes `[test] root = "./src"`; Playwright E2E and `scripts/` size-gate suites are excluded from the default `bun test`.
- **Where**: `bunfig.toml` (verify-report WARNING 7).
- **Correction**: Documented; frontend lib and scripts suites run via explicit paths (`bun test ./frontend/src/lib/`, `bun test ./scripts/build-binaries.test.ts`).

### F8 — Hard-gate finding carried to archive (A1-6: node-taxonomy anchoring)
- **What**: Engine, validator, palette, and YAML expose 14 node types; the delta specs enumerate only 10; `loop` has no explicit spec sentence anywhere and `pipeline`/`condition` are weakly anchored.
- **Where**: workflow-engine / workflow-editor spec text vs `src/orchestrator/engine.ts` taxonomy.
- **Correction**: Not verdict-sinking (binding RFC family taxonomy is open-ended; tested parity scenario). Archive MUST anchor the full taxonomy (`loop`/`pipeline`/`condition`/`fan`/`join`/`start`/`end`) in spec text, or declare them as documented extensions — same handling as the provider-list drift.

### F9 — Spec-text drift and stale repo config (carried to archive)
- **What**: external-providers/external-proxy text names "Google, Groq" vs the binding (local + OpenAI + Anthropic + OpenRouter); backend-management "boot-time readiness gate" superseded by spawn-on-activation; websocket "token deltas" vs single-chunk delivery; `openspec/config.yaml` `build_command` references removed `src/index.ts`; `dist/` holds misleading legacy artifacts; git tag `v0.1.0` pending at `37eab81`.
- **Where**: Spec text, `openspec/config.yaml`, `dist/`, git tags.
- **Correction**: Implementation is truth per architecture-lint Axis 2; `sdd-archive` aligns spec text; fix `config.yaml` build_command; clean `dist/` before the release build; propose the tag at the final commit SHA.

### F10 — Local-model runtime wiring absent (A1-1; scope hand-off, not a failure)
- **What**: The managed llama-server backend is never wired into the runtime path (`boot()` sets `localProvider: () => null`); local-model ACs (3/6/13/14) are not E2E-demonstrable; unit coverage is complete via injected fakes.
- **Where**: `src/main.ts` boot wiring; `src/backend/manager.ts` has zero runtime callers.
- **Correction**: Disclosed, design-consistent limitation. The next change owns the model-activation wiring (route → `manager.start()` glue). Not a defect in tested behavior.

**Hard-verify note**: all five adversarial breaks produced the expected suite failure on the first focused run; round 1 SOUND, zero testing errors, nothing relayed to Tasks. No failure to log from the hard-verify phase itself.

## Skill candidates (proposals only — the human decides; nothing is auto-created)

### C1 — `sd-ledger-budget` (skill)
- **Trigger**: `sdd-attempt` acquire/settle on a `size:exception` change, or a read-only phase report vs `max_changed_lines`.
- **Origin lesson**: F4 + F5 — the 400-line default budget vs a 37,650-line `size:exception` required two maintainer resets, and every settle needed a fresh untracked-inventory sha256 re-declaration as new phase artifacts appeared.
- **Proposed behavior**: size:exception-aware acquire defaults; read-only report artifacts (verify-report / hard-gate / architecture-lint / pre-experience) excluded from changed-line counting or auto-accounted with a report budget; inventory-declaration choreography documented (select-then-declare; disclose new hashes from settle's blocked state).

### C2 — `sd-plugin-preflight` (guidance note, not a full skill)
- **Trigger**: mid-session state loss / repeated preflight `question` re-presentation in SDD/plugin-driven sessions.
- **Origin lesson**: F1 + F2 — state loss caused repeated `question` re-presentations; the canonical grouped preflight (heading text from the canonical source, not model-authored) fixed both the repetition and the intermittent heading-text refusals.

### C3 — `sd-transient-retry` (policy)
- **Trigger**: transport / rate-limit failures during SDD phases (`getaddrinfo ETIMEOUT`, `Rate limit exceeded`).
- **Origin lesson**: F3 — retry-with-backoff was sufficient; a policy should classify transient vs persistent, cap retries, and require evidence-preserving retries (never re-run destructive steps) so a failed batch never loses work.

## Archive note

**Archive is NOT blocked by anything in this phase (fail-open).** Verdict stack behind archive: verify PASS WITH WARNINGS, architecture-lint PASS/PASS, hard-gate PASS (attempt 1/3), hard-verify SOUND (round 1). Carried obligations for `sdd-archive`: A1-6 taxonomy anchoring or declared extensions; provider-set / readiness-gate / token-delta spec-text alignment; `openspec/config.yaml` build_command fix; git tag `v0.1.0` proposal.

## Evidence Revision

`sha256(openspec/changes/weavellm/pre-experience.md)` — snapshot of this retrospective at phase close.