# Archive Report — WeaveLLM (Full Rewrite)

- **Change**: `weavellm` (openspec/changes/weavellm)
- **Phase**: archive (terminal)
- **Date**: 2026-09-15
- **Store mode**: hybrid (OpenSpec filesystem + Engram topic `sdd/weavellm/archive-report`)
- **Head**: `37eab810428956fc9abf458a524ac979c6bd0048` (13 commits, `a9740cb..37eab81`)

## Final State (at close)

| Gate | Verdict | Evidence |
|------|---------|----------|
| Tasks | 50/50 `[x]` — Task Completion Gate passes | `tasks.md` |
| Verify | PASS-WITH-WARNINGS — 0 blockers, 0 CRITICAL, 382 pass / 0 fail / 961 expect() across 39 files; 63 reqs / 102 scenarios; `bun test` exit 0 | `verify-report.md` |
| Arch lint | PASS (Axis 1 scope, Axis 2 architecture-plan acta) | `architecture-lint.md` |
| Hard verify | SOUND — round 1, 5/5 adversarial breaks caught, tree byte-identical to HEAD after reverts | `hard-verify.md` |
| Hard gate | PASS — 382 pass / 0 fail / 961 expect() / 39 files; A1-1/A1-2/A1-5 findings + A1-6 (taxonomy) anchored at archive | `hard-gate.md` |
| Changelog | `[Unreleased]` → 0.1.0 candidate; classify minor | `CHANGELOG.md` |
| Pre-experience | persisted (close order changelog → pre-experience → archive) | `pre-experience.md` |

Test/build hashes (verify time): `test_output_hash` `sha256:58888bd8…fa9c8`, `build_output_hash` `sha256:60db3466…a453`, `evidence_revision` `sha256:d21f61c1…`.

## Composition Summary

15 of 15 delta specs archived into `openspec/specs/*/spec.md` via the native
`gentle-ai sdd-archive-compose` command (Mandatory Native Composition) for the
4 overlapping domains, mechanical byte-identical copy (`cp` + mandatory
`diff -r` readback, all empty) for the 11 new domains.

| Domain (delta) | Action | Result |
|----------------|--------|--------|
| backend-management | Merge | 10 reqs → 9: 3 ADDED (single-model spawn per active model, YaRN/KV flags at spawn, llama.cpp version floor), 2 MODIFIED (spawn+supervise, readiness gate), 4 REMOVED (router-mode, per-model preset generation, on-demand swap, configurable autoload); 4 preserved |
| external-providers | Merge | 6 reqs → 7: RENAMED "OpenAI-compatible provider adapter → Multi-provider adapter" + MODIFIED, RENAMED "Static authentication → Keychain-backed authentication" (repair, see below) + MODIFIED, ADDED "Provider fallback"; 4 preserved |
| gateway-security | Merge | 4 reqs → 5: MODIFIED "Optional Bearer token authentication" (keychain-backed, OFF default), ADDED "Localhost-only binding by default"; helmet/zod/SSRF preserved |
| gguf-metadata | Merge | 3 reqs → 4: ADDED "YaRN original context derivation and rope-scale guard"; 3 preserved |
| desktop-app-shell | Copy (new) | canonical created, byte-identical |
| data-code-sandbox | Copy (new) | canonical created, byte-identical |
| embeddings-rag | Copy (new) | canonical created, byte-identical |
| external-proxy | Copy (new) | canonical created, byte-identical (+ binding alignment) |
| keychain-secrets | Copy (new) | canonical created, byte-identical |
| local-model-catalog | Copy (new) | canonical created, byte-identical |
| model-advanced-config | Copy (new) | canonical created, byte-identical (+ `llm_call` naming) |
| model-downloads | Copy (new) | canonical created, byte-identical |
| websocket-streaming | Copy (new) | canonical created, byte-identical (+ relay alignment) |
| workflow-editor | Copy (new) | canonical created, byte-identical (+ taxonomy anchor) |
| workflow-engine | Copy (new) | canonical created, byte-identical (+ taxonomy anchor) |

Canonical corpus after archive: 25 specs (14 legacy + 11 new), every requirement
has scenarios, no stray residues (`Google/Groq`, `token deltas`, `10+ node
types`, legacy `llm.call`, `.compose-tmp` all confirmed absent by grep).

## Delta Repair (documented, archive-time)

- **external-providers missing RENAMED declaration**: the delta's MODIFIED
  "Keychain-backed authentication" referenced a requirement name not present in
  the canonical spec ("Static authentication"). The native composer refused
  with: `unapplied MODIFIED delta for requirement "Keychain-backed
  authentication": no canonical requirement named "Keychain-backed
  authentication"`. Per the composer contract (RENAMED applies before MODIFIED),
  the delta was repaired by adding the explicit declaration
  `Static authentication → Keychain-backed authentication` to its RENAMED
  section, then recomposed natively (exit 0). No canonical bytes were
  hand-merged. The delta repair is part of the change trail and is included in
  commit `docs(spec): compose external-providers delta…`.

## Spec-Text Alignment Decisions (drift → behavior)

The following alignments make `openspec/specs/*` describe what shipped, as
recorded by verify/arch-lint/hard-gate. Each is a tracked, fine-grained commit.

1. **Provider set → runtime binding (A1-4 / verify WARNING 3)**: spec text named
   "OpenAI-compatible, Anthropic, Google, Groq"; the binding (user-confirmed,
   resolving the design open question) is **`local` + OpenAI-compatible +
   Anthropic + OpenRouter**. Aligned `external-providers` Purpose + Multi-provider
   adapter, and `external-proxy` Purpose + Provider routing. Source truth:
   `ProviderKind = "local" | "openai" | "anthropic" | "openrouter"`
   (`src/providers/adapters.ts:11`); adapters `adapter-openai.ts`,
   `adapter-anthropic.ts`, `adapter-openrouter.ts`.
2. **Readiness gate → spawn-on-activation (A1-1 / arch-lint Axis 2)**:
   "Boot-time readiness gate" renamed "Spawn-time readiness gate": the gateway
   does NOT wait at boot for a managed backend; spawning + wait-ready happens
   per active model, and the boot wiring of the local provider is intentionally
   deferred (`src/main.ts` boots `localProvider: () => null`). Scenarios aligned
   ("Backend fails to become ready", "…on activation").
3. **WS token events → single-chunk relay (A1-2 / verify WARNING 2)**: "token
   deltas" purpose and "Token streaming over WS" replaced by "Run output relay
   over WS": a completed run's OpenAI-wire SSE is relayed in one `token`
   message ending in exactly one `data: [DONE]`; live step lifecycle events
   stream in real time; per-token delta streaming is explicitly out of scope.
4. **Node taxonomy anchored (A1-6 / hard-gate)**: the full 14-type taxonomy is
   now literal in `workflow-engine` "Node taxonomy parity" and `workflow-editor`
   "Node palette" — **start, end, llm_call, condition, loop, fan, join,
   pipeline, rag_local, data.code, memory, embeddings, router, output** — with
   explicit sentences each (loop bounds, fan/join parallelism, pipeline
   depth-bounding, structural gates), and `llm_call` mode mapping (below). The
   `llm.call` legacy spelling across specs (workflow-editor, model-advanced-
   config) was normalized to `llm_call`.
5. **config.yaml build_command**: `bun build src/index.ts --outdir dist`
   (references file removed in phase 7) → `bun run build` (verified passing at
   verify/apply time). Bunfig note recorded: `[test] root = "./src"` scopes the
   default runner; frontend/e2e suites run via explicit paths.
6. **gosh `-x` divergence — report-only**: `-x 16` appears only in design/quest/
   research/explore prose; NO spec ever named a parallelism value; the
   implementation default is `-x 8` (`src/downloads/gosh.ts`). Cosmetic prose
   divergence, recorded here per verify D4/arch-lint note; no spec change was
   warranted.

## Provider / Orchestration Mapping (obligation: record)

| Linear chain `Step.type` | Graph node | Seam |
|--------------------------|------------|------|
| `generate` | `llm_call` mode `generate` | graph twin of `Step.type` |
| `refine` | `llm_call` mode `refine` | " |
| `passthrough` | `llm_call` mode `passthrough` | " |
| `runChain(…)` | `runGraphEngine(…)` | linear entry point aliases the engine (`graph.ts` L751 preserved) |

14 node types are registered in engine `NODE_TYPES` and forwarded to the editor
palette, so the canonical taxonomy above matches implementation and UI.

## Deviations from the Standard Archive Procedure (all intentional)

1. **No archive-folder move**: the launch prompt explicitly instructed
   `Keep openspec/changes/weavellm/ as the change trail (do not delete)`.
   The change folder therefore REMAINS at `openspec/changes/weavellm/` instead
   of moving to `openspec/changes/archive/2026-09-15-weavellm/` (the convention
   used by the 8 prior archived changes). Recorded here as the authoritative
   reason.
2. **Handoff stated "tree clean"**: at close the working tree contains 6
   untracked phase artifacts created after the final commit — `CHANGELOG.md`,
   `architecture-lint.md`, `hard-gate.md`, `hard-verify.md`, `pre-experience.md`,
   `verify-report.md`. They are part of the change trail and were left as the
   creator phases left them; the delivery PR must include them.
3. **Handoff stated "no sdd-archive-compose binary"**: the tool exists and is
   functional in this environment; all merges used it (Mandatory Native
   Composition per skill contract, #4119). No model-driven hand-merge of
   canonical bytes occurred; all copies verified with empty `diff -r`.
4. **Git commits**: composition + alignment + config edits committed as
   fine-grained conventional commits (see `git log`); the archive report itself
   is committed as `docs(archive)`. No source-code changes, no PRs, no pushes.

## Artifacts in the Change Folder

proposal ✓ · specs/ (15 deltas) ✓ · design ✓ · tasks ✓ (50/50) · apply-progress ✓ ·
verify-report ✓ · architecture-lint ✓ · hard-gate ✓ · hard-verify ✓ ·
pre-experience ✓ · CHANGELOG ✓ · archive-report ✓

## Engram Persistence

- `topic_key: sdd/weavellm/archive-report` (type `architecture`, scope `project`).
- Observation IDs read this phase recorded in the retrieval ledger per Section B
  (sdd/weavellm/specs/*, proposal, design, tasks, apply-progress, verification,
  hard-verify, hard-gate, pre-experience topics).

## Cycle Complete

WeaveLLM is fully planned, implemented, verified, and archived. Canonical specs
now describe the shipped system. Ready for the next change.