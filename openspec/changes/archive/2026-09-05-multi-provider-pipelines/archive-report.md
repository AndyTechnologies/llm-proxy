# Archive Report: multi-provider-pipelines

**Change**: multi-provider-pipelines
**Archived on**: 2026-09-05
**Archived to**: `openspec/changes/archive/2026-09-05-multi-provider-pipelines/`
**Artifact store**: hybrid (openspec + Engram)
**Engram topic**: `sdd/multi-provider-pipelines/archive-report`

## Final-State Verdict

This change is archived as **successful and complete**. Final state at close:

- **Verify verdict**: `pass` (admitted by `gentle-ai sdd-verify-validate --requirements 9 --scenarios 24`), evidence revision `sha256:6c5e8b5883f01134530cdb507ca95b8c8ee01697bcf09e7cb17fe5057e2129be`. **0 CRITICAL / 3 WARNING / 1 SUGGESTION.** No CRITICAL ever blocks archive; this change has none.
- **Requirements**: 9/9. **Scenarios**: 24/24 compliant (0 PARTIAL / 0 UNTESTED / 0 FAILING).
- **Tasks**: 24/24 `[x]` (0 unchecked) at the persisted tasks artifact — Task Completion Gate passed (17 original + 7 remediation tasks).
- **Full gate at close**: `bun run typecheck` exit 0, `bun run lint` exit 0, `bun test` **432 pass / 0 fail** (1079 expect() calls, 40 files, test output hash sha256:9463f5b1…), `bun run build` exit 0 (132 modules, output hash sha256:255fa270…).

## Facts at Close (per the Final-State Authority hierarchy)

The archive report is the terminal record of the cycle; it overrides stale claims in intermediate snapshots (`apply-progress`, earlier verification envelopes).

1. **Test-count reconciliation (432 is final)**: intermediate snapshots recorded 421 (batch 1, apply-progress) and 431 (remediation gate 6.6). The final verification report (filesystem `verify-report.md` + Engram obs #309) and the orchestrator launch prompt both record **432 pass / 0 fail** after remediation task 6.7 added the S4.2 coverage test (34 additive tests over the 398 baseline). 432 is the number carried at close. Dependencies shipped: `ai@7.0.93`, `@ai-sdk/openai-compatible@3.0.44`, zod `^3.25.76`.

2. **Artifacts read for traceability**: filesystem proposal.md, specs/{external-providers,config-load,gateway-api,pipeline-orchestration}/spec.md, design.md, tasks.md, verify-report.md; Engram obs #309 (verify-report), obs #282 (apply-progress, cited within the verify report's TDD-evidence trace).

3. **Warnings carried (archive-time context, not blockers)**:
   - (a) `/v1/completions` external path has no dedicated integration test — the dispatch branch is shared with `chat.ts` (verified present at `completions.ts:142`), exercised via the chat path and covered by the full-suite green run.
   - (b) Verification ran against a working tree with concurrent uncommitted changes (`graph-engine.ts` loop support, `llama-server.ts` lifecycle, `proxy.ts` passthrough, dashboard `ui-dark-theme`); full suite (432) passes on the combined tree; frozen-file violations by THIS change: none (fresh grep scan of those diffs shows zero external-provider content). Recommend committing this change's scope files (or rebasing) so the tree is attributable.
   - (c) Live llama-server streaming smoke not run (llama binary + models unavailable in this environment); the external contract is covered by wire-mock integration instead.

4. **Frozen list respected**: `Provider` seam, `graph-engine.ts` production code, `buildStreamBody`, the llama-server fetch path, `proxy.ts`, `manager.ts`, and the dashboard were NOT edited by this change (graph-engine received 3+ additive tests only; HEAD production already read `n.provider`). The llama-server provider stays the first entry in the providers map.

5. **Key technical findings** (baked into the adapter implementation and pinned by tests):
   - In `ai@7.0.93`, `TooManyRequestsError` does NOT exist — a 429 surfaces as `APICallError` with `statusCode === 429`; the translation keys off `statusCode` for the `on_429` routing contract.
   - `TextStreamTextDeltaPart` uses `text` (not `textDelta`) at this SDK version.
   - Wire streams may emit a trailing usage chunk (`choices: []`) after the terminal chunk — tests locate the terminal by `finish_reason`, not by position.

## Spec Sync

| Domain | Action | Requirements |
|--------|--------|--------------|
| `external-providers` | **Created** (new capability) | 6 added (mechanical copy of the delta spec) |
| `config-load` | Updated | +1 added (External providers config section) → 9 total |
| `gateway-api` | Updated | +1 added (External model listing and unknown-model 404) → 7 total |
| `pipeline-orchestration` | Updated | +1 added (Named-provider targeting on llm_call) → 9 total |

All four deltas were pure **ADDED** (0 MODIFIED / 0 REMOVED / 0 RENAMED); no destructive merge, so the `archive` rule ("warn before merging destructive deltas") did not trigger. Appended requirement blocks are byte-identical to the delta blocks (empty `diff -u` readback per domain — verbatim output in the phase result). `external-providers` was copied with the skill's mechanical `mktemp` + `cp` + `diff -r` + `mv` sequence (empty `diff -r`), then `chmod 644` to match repo convention. All pre-existing requirements in the three updated main specs were preserved untouched.

## Archive Contents

- proposal.md
- research.md
- design.md
- specs/{external-providers,config-load,gateway-api,pipeline-orchestration}/spec.md (delta specs, preserved as-is)
- tasks.md (24/24 `[x]`, 0 unchecked)
- verify-report.md (final report, `pass`)
- archive-report.md (this file; additive, excluded from the move readback)

**Mechanical Copy Contract**: the change folder was moved with the skill's transactional shell block (`git mv` attempted; the folder is entirely untracked, so the verified fallback plain `mv` ran after an empty `diff -r` snapshot check) with a pre-move recursive `cp -R` snapshot and a mandatory `diff -r` readback. **Diff output was empty (byte-identical)** — the only passing evidence. No file content passed through the model's Read/Write path. The archived `tasks.md` carries no stale unchecked tasks.

## Scope Integrity

The archive touched ONLY the `multi-provider-pipelines` change folder (moved to `openspec/changes/archive/2026-09-05-multi-provider-pipelines/`) and the four main specs under `openspec/specs/` (one created, three updated by append). The ~40 unrelated modified/untracked files from in-progress concurrent changes were not attributed, staged, reverted, or committed. The change folder was entirely untracked in source and remains untracked at the destination, as in source.

## Risks / Follow-ups

- Verify WARNING (b): commit this change's scope files (or rebase) so the combined tree is attributable; the concurrent F2 changes (`graph-engine.ts`, `llama-server.ts`, `proxy.ts`, dashboard) serialize before release.
- Verify SUGGESTION 1 (non-blocking): a future change may add a wire-level integration assertion on a top-level body field (e.g. `temperature` or a sampler like `top_k`) to pin the SDK providerOptions/settings merge end-to-end.
- Externally supplied API keys are required to exercise real external providers; the wire contract is covered by mocks in CI-available environments.

## Skill Resolution

Skill loaded and followed: `sdd-archive` (SKILL.md) plus shared `sdd-phase-common.md`, `persistence-contract.md`, and `openspec-convention.md`. Skill loading: `paths-injected` (exact skill paths from the orchestrator launch prompt).

## Next Recommended

`changelog` — the orchestrator evaluates the hook organically. This change HAS consumer-facing behavior (external provider models in `/v1/models`, named-provider targeting on `llm_call`, the config `providers` section), so a changelog entry and semantic-version classification are warranted.