# Archive Report: ui-dark-theme

**Change**: ui-dark-theme
**Archived on**: 2026-09-05
**Archived to**: `openspec/changes/archive/2026-09-05-ui-dark-theme/`
**Artifact store**: openspec (hybrid — report persisted to openspec + Engram)
**Engram topic**: `sdd/ui-dark-theme/archive-report`

## Final-State Verdict

This change is archived as **successful and complete**. Final state at close:

- **Verify verdict**: `pass_with_warnings` (validated by `gentle-ai sdd-verify-validate`, valid:true), evidence revision `sha256:3001c026f8c494a38eecc7fff838078e50f0349d903e5c47df624d3f56f43ea5`. **0 CRITICAL / 3 WARNING / 3 SUGGESTION.** No CRITICAL ever blocks archive; this change has none.
- **Requirements**: 1/1 (Dark technical theme). **Scenarios**: 4/4 compliant.
- **Tasks**: 18/18 `[x]` (0 unchecked) at the persisted tasks artifact — Task Completion Gate passed.
- **Apply commit**: `858b51d` "feat(ui): apply dark technical theme to dashboard" — touches ONLY `src/ui/styles.css` + `openspec/changes/ui-dark-theme/tasks.md`.
- **Runtime ledger**: complete (settle state complete).

## Facts at Close (per the Final-State Authority hierarchy)

The archive report is the terminal record of the cycle; it overrides stale claims in intermediate snapshots (`apply-progress`, earlier `verify-report`).

1. **Apply-progress / TDD-cycle evidence persisted (Engram obs #279, topic `sdd/ui-dark-theme/apply-progress`)**: RED baseline (regression contract green before apply while theme tokens absent) → GREEN after apply commit `858b51d` (`bun test` green incl. e2e-smoke 4/4; typecheck + lint clean at apply time) → REFACTOR/purge (legacy-literal grep 0 remaining; token remap consolidated to `var()` chains). Test runner `bun test`; Strict TDD active (init obs #29). This artifact was absent during the FIRST verification — that absence was the single CRITICAL; its presence is what made final verification pass. (Per verify-report, first verification's single CRITICAL was a protocol/evidence gap, not a code defect.)

2. **Verify passed with warnings**: `pass_with_warnings`, 0 CRITICAL / 3 WARNING / 3 SUGGESTION. Evidence revision sha256:3001c026f8c494a38eecc7fff838078e50f0349d903e5c47df624d3f56f43ea5.

3. **Warnings carried (archive-time context, not blockers)**:
   - (a) Clean-baseline typecheck errors at boundary `858b51d` owned by parent commit `a344fe2` (another in-progress backend change), out of scope; live tree typechecked clean at verification start.
   - (b) Topbar renders **37.39px** vs the spec's nominal 32px literal; the editor layout tracks the measured height via `calc(100vh - 61.39px)`. **Design-authorized** resolution (design open-question "measure; adjust the calc if the rendered header height differs", task 4.5). Baked into the archived spec at archive time as the binding resolution.
   - (c) `--text-faint #7d8590` confirmed as the correct WCAG-AA fix: `#6e7681` on `#0d1117` measures **4.12:1** (below the 4.5:1 floor), while `#7d8590` measures **5.07:1**. The lift is the required correction per the design's correction rule.
   - Suggestions (archive-time, non-blocking): a legacy-green node stroke remnant `rgba(76,195,138,0.35)` at `styles.css` ~line 620 (spec-letter compliant — the forbidden list is scoped to loop/socket FILLS; this is a node outline); no machine-verifiable token/contrast contract test yet (only substring presence is asserted).

4. **Regression contract preserved**: e2e-smoke 4/4; `:focus-visible` and `aria-current` byte-stable in the served stylesheet; landmarks (`role="banner"`, `id="graph-canvas"`, `<dialog`, `id="palette"`) intact in served HTML. `src/ui/styles.css` working tree byte-identical to commit `858b51d` (no drift on the change's own file).

## Spec Sync

The capability is `dashboard-ui` **MODIFIED** with ADDED requirement **"Dark technical theme"** (1 added, 0 modified, 0 removed). Applied into `openspec/specs/dashboard-ui/spec.md`:

- Synced the delta's observable contract: GitHub-dark palette with exact token values, mono 14px/1.6 body, flat texture (no grain/blur/steel-blue), compact topbar, focus 2px/1px, minimal scrollbars, 150ms transitions, `--status-*` token family for loop/sockets (no legacy fills `#9d80e9`/`#4cc38a`/`#e05b4f`), WCAG-AA contrast (≥4.5:1).
- Baked the **design-authorized corrections** into the archived spec per verify WARNING-2 / SUGGESTION-3 (this was the archive phase's own decision per its process): binding measured topbar height **37.39px** with the tracking calc **`calc(100vh - 61.39px)`**; measured near-floor contrast values **7.49:1** (text-on-accent `#0d1117`/`#58a6ff`) and **5.07:1** (faint `#7d8590` on base `#0d1117`), with note that `#6e7681` would be sub-AA. Faint text token recorded as `#7d8590` in the palette table.
- Preserved all other requirements not in the delta (incl. the pre-existing working-tree GGUF-metadata requirement from the in-progress parent change, left untouched).

`openspec/specs/dashboard-api/spec.md` was **NOT** touched (out of scope).

## Archive Contents

- proposal.md
- exploration.md
- design.md
- specs/dashboard-ui/spec.md (delta spec, preserved as-is)
- tasks.md (18/18 `[x]`, 0 unchecked)
- verify-report.md (final, superseding report, pass_with_warnings)
- `.gentle-ai-instance`

**Mechanical Copy Contract**: the change folder was moved with `git mv` (single transactional shell block) with a pre-move recursive `cp -R` snapshot and a mandatory `diff -r` readback. **Diff output was empty (byte-identical)** — the only passing evidence. No file content passed through the model's Read/Write path. The archived `tasks.md` carries no stale unchecked tasks.

## Scope Integrity

The archive touched ONLY the `ui-dark-theme` change folder and the `dashboard-ui` main spec. The ~40 unrelated modified/untracked files from the in-progress Spanish-UI-translation + multi-provider-pipelines changes were **not** attributed, staged, reverted, or committed. The `git mv` moved the change folder (only `tasks.md` was git-tracked; the remaining archive files were untracked in source and remain untracked at the destination, as in source). Nothing else was modified.

## Risks / Follow-ups

- The WARNING-1 boundary typecheck errors owned by parent commit `a344fe2` must be resolved by the owning backend change before release.
- The unrelated `multi-provider-pipelines` stubs (`src/providers/openai-compatible.ts` + test) are out of scope and must not merge until implemented.
- SUGGESTION-1 (legacy-green node stroke remnant) and SUGGESTION-2 (machine-verifiable token/contrast contract test) are documented non-blocking improvements for a future change.

## Skill Resolution

Skill loaded and followed: `sdd-archive` (SKILL.md), plus shared `sdd-phase-common.md` and `openspec-convention.md`. Values: Envelope per Section D. `skill_resolution`: paths-injected.

## Next Recommended

`none` (or `sdd-changelog`, which the orchestrator runs automatically after archive without altering nextRecommended).
