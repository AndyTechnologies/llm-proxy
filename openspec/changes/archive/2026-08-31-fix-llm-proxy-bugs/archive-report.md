# Archive Report: fix-llm-proxy-bugs

**Status**: ARCHIVED (complete)
**Archived**: 2026-08-31
**Artifact store**: openspec + Engram (hybrid)

## Final State

This change fixed **5 bugs** (not the 4 originally scoped — Bug 5 was discovered and added during runtime verification). All 5 are implemented, committed, and verified. The SDD cycle is complete.

| Bug | File | Fix | Commit |
|-----|------|-----|--------|
| 1 | `pipelines.js` | Declare local `let finishReasonRecibido` in `runPipelineStream` scope | `9e2bd3f` |
| 2 | `utils/micro.js` | Restore `developer→system` role normalization + flatten array/string/empty `content` | `8e5a5ce` |
| 3 | `pipelines.js` | Catch emits a SINGLE terminal chunk `finish_reason:null` + `error.message` + `[DONE]`, no fake stop, no duplicate `errorPayload` | `2ccfc68` |
| 4 | `utils/micro.js` | `finiteNumber(value,fallback,min,max)` helper applied ONLY when field exists | `b363a4c` |
| 5 | `pipelines.js` (~109), `server.js` (~217) | `llamaChatStream(config, payload, abortSignal)` passes `config` as first argument (was payload → `config.llamaSwap` undefined → `TypeError .host`) | `b43609b` |

## Verification

- **Verdict**: **PASS** — validated via `gentle-ai sdd-verify-validate` → `valid: true, pass`; ledger `verify` settled `complete`, `outcome: passed`.
- **Coverage**: 5 requirements / 7 scenarios (5 invariants including Bug 5).
- **CRITICAL findings**: 0.
- **Unit checks**: `finiteNumber` + `sanitizePayloadForLlamaCpp` — 100% PASS.
- **Runtime (live stack** `node index.js:8090` → `llama-swap:8080`**)**:
  - Non-stream `thinker` with `temperature:"abc"` → stage 1 `Phi-4-Mini-Instruct` HTTP 200 (NaN-guard + sanitization work in vivo).
  - Streaming error → exactly one terminal chunk + `[DONE]` (catch single-terminal verified).
  - Streaming reaches final stage without `TypeError .host` (Bug 5 fixed) and without `ReferenceError` (Bug 1 fixed).

### Commits (apply + artifacts)
`e574ca5` (baseline), `9e2bd3f`, `8e5a5ce`, `2ccfc68`, `b363a4c`, `b43609b` (code), `a336088` (SDD artifacts updated for Bug 5 + verified runtime).

## Environmental Caveat (NOT a proxy-code defect)

The final-stage model of every pipeline (`Llama3.2-3B-Instruct`) does not load its llama.cpp backend on this machine: its production config (`/home/andy/Models/config.yaml`) sets `hctx: 102400` (100K context) with `--n-gpu-layers 99`, exceeding the 6GB VRAM (RTX 3050). `Phi-4-Mini-Instruct` (stage 1, `mctx: 32768`) loads fine and returned HTTP 200. Recording this as an environment note: full final-stage streaming content could not be captured, but all proxy behavior (syntax, normalization, NaN guard, catch path, streaming argument binding) was exercised live.

## Task Completion

- **Task Gate**: 13/13 implementation + verification + commit tasks checked in `tasks.md`. No stale unchecked implementation tasks at archive time.
- This archive proceeded directly (all tasks complete, verify PASS, no CRITICAL findings) — no exceptional stale-checkbox reconciliation was required.

## Design Deviation (recorded, intentional)

Bug 3 implemented **Alternative B** (`finish_reason: null` + `error.message` in-band, so the client sees the error) rather than design's Alternative A (`finish_reason: "stop"`). This deviation is documented in `tasks.md` task 1.3 and the code comment; it is spec-aligned (the verification invariant requires exactly one terminal chunk where the client sees the error) and was accepted at apply time.

## Specs Synced

Main spec **created** for domain `proxy-pipeline` (openspec/specs/ was empty; the delta spec was the full non-regression spec and was copied mechanically, byte-identical):

`openspec/specs/proxy-pipeline/spec.md` — contains the 5 non-regression invariants (streaming SSE without ReferenceError; payload normalization developer→system + content flattening; single terminal in catch; outbound params never NaN; config passed to llamaChatStream). 0 ADDED/MODIFIED/REMOVED requirements at contract level by design (non-regression change; New/Modified Capabilities: None).

## Engram Traceability

Source artifacts read from openspec disk (hybrid store; Engram mirrors at `sdd/fix-llm-proxy-bugs/{proposal,spec,design,tasks,verify-report}`).
This archive-report persisted to Engram as `sdd/fix-llm-proxy-bugs/archive-report`.

## Archive Contents

- `proposal.md` ✅
- `specs/proxy-pipeline/spec.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (13/13 tasks complete)
- `verify-report.md` ✅
- `archive-report.md` ✅ (this file)
