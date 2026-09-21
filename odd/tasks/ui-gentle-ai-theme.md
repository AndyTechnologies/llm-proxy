# UI — Gentle-AI hybrid theme (frontend)

## Objective
Restyle the WeaveLLM frontend SPA (Astro + Svelte islands) to the Gentle-AI
design system: official-site structure and tokens, with the `gentleman-cute`
pink accent. User selected **Híbrido** (site base `#09090b`/`#111113`, Inter,
radios 8/16px + accent `#F095C8`).

## Problem / Why
The current shell uses a cold blue "dev dashboard" palette (`#0f1115`,
accent `#6ea8fe`) that does not match the requested look & feel. Additionally,
`WorkflowEditor.svelte` references `var(--surface)` and `var(--danger)` which
are **not defined** in `global.css` — the editor has been rendering with
unresolved tokens.

## Scope / Constraints
- 4 files only: `frontend/src/styles/global.css`, `frontend/src/pages/index.astro`,
  `frontend/src/svelte/WorkflowEditor.svelte`, `frontend/src/svelte/ModelBadge.svelte`.
- Preserve every data-testid / aria-label contract (workflow-editor, palette,
  wf-name, wf-errors, wf-error, wf-yaml, model-badge) and all editor behavior.
- Do NOT fetch fonts from a CDN (local desktop runtime, offline-capable):
  declare `Inter, system-ui, -apple-system, sans-serif` as a stack only.
- TDD: pure styling change; no new behavioral tests. Strict TDD active — the
  verification is the existing suite staying green + token audit. No RED phase
  applies (no behavior to drive); record this honestly.
- Route: delegated direct — one bounded writer (writer trigger: 2+ files).

## Design tokens (authoritative)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#09090b` | main background |
| `--bg-card` | `#111113` | panels / cards |
| `--bg-code` | `#18181c` | inputs, textarea, code |
| `--border` | `#ffffff12` | subtle borders |
| `--border-hover` | `#F095C859` | border on hover |
| `--text` | `#fafafa` | primary text |
| `--text-muted` | `#a1a1aa` | secondary text |
| `--text-tertiary` | `#52525b` | faint / disabled |
| `--accent` | `#F095C8` | primary accent (gentleman-cute) |
| `--accent-hover` | `#FFB1DD` | accent on hover |
| `--accent-soft` | `rgba(240,149,200,.15)` | subtle accent backgrounds |
| `--success` | `#B4E7C7` | positive status |
| `--danger` | `#FF718F` | errors |
| `--surface` | `var(--bg-card)` | legacy alias (fixes unresolved var) |
| `--muted` | `var(--text-tertiary)` | legacy alias (fixes unresolved var) |
| font stack | `Inter, system-ui, -apple-system, sans-serif` | text |
| mono stack | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas` | code/YAML |

Rules: radios 8px (controls) / 16px (cards panels), spacing multiples of 4,
`transition-colors` on interactive elements, single chromatic accent (pink),
no hard pure-white lines — borders stay `#ffffff12` at 12% white.

## Checklist
- [x] UGT-1 `global.css`: remap all tokens + define `--surface`, `--danger`,
      `--text-tertiary`, `--border-hover`, `--bg-code`; every `var()` in
      WorkflowEditor/ModelBadge must resolve.
- [x] UGT-2 `WorkflowEditor.svelte`: restyle scoped styles — palette items,
      canvas, buttons, inputs, textarea (mono), errors — with token set above.
- [x] UGT-3 `ModelBadge.svelte`: card radius 16px, subtle border, chips with
      accent-soft/accent, muted tokens.
- [x] UGT-4 `index.astro`: header border-bottom + tagline secondary, panels
      with new tokens; keep markup/labels intact.
- [x] Verificación: `bun run typecheck` (tsc --noEmit exit 0) + `bun run lint`
      (eslint exit 0) + `bun test` (462 pass / 0 fail) green; grep audit —
      zero legacy hex (`#0f1115`, `#6ea8fe`, `#161a22`, `#2a3040`) in
      frontend/, every `var(--…)` reference in Svelte resolves (44 refs).
      SvelteFlow dark-themed via `--xy-*` mapped to tokens. `bun run
      build:frontend` compiles (1 page, exit 0).

## Evidence
- Design direction chosen by user: Híbrido (Gentle-AI site base + pink accent).
- Baseline: current suite green (462 pass) before this change.
- RDD: off (global) at close — native STATUS returned `stop/rdd_disabled`
  terminal; no review run; delivery follows ordinary repository policy.
- Writer: delegated `general` agent (success) — verification of record.
  Parent spot check re-ran typecheck (green) + legacy-grep (zero matches).

## Evidence
- Design direction chosen by user: Híbrido (Gentle-AI site base + pink accent).
- Baseline: current suite green (462 pass) before this change.