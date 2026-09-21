# Exploration: weavellm — full rewrite as WeaveLLM (local AI desktop runtime)

Status: success
Date: 2026-09-14
Mandate: `openspec/changes/weavellm/quest.md` (approved RFC — read first; no other dependencies)

## Executive Summary

The repo today is a solid, well-tested Bun/TypeScript **gateway** (84 source files, 445 test cases, 14 synced OpenSpec specs) with a DAG orchestrator, GGUF metadata reader, and llama-server lifecycle manager — none of which survives wholesale, but several modules are **directly portable** into the WeaveLLM rewrite (GGUF context auto-detect, llama-server spawn/port/stop logic, graph validation, Provider contract, OpenAI types). External verification produced two blocking findings: (1) Electrobun is real and very active (`blackboardsh/electrobun`, 12.7k★, MIT, pushed 2026-09-13) but its **default main-process runtime is now Cottontail (JSC)**, not Bun, and Linux end-user machines need WebKitGTK 4.1 runtime packages — both collide with the RFC's "Bun main process" and "cero dependencias externas" assumptions; (2) **`gosh` could not be verified anywhere** (npm, GitHub API, crates.io, Homebrew, web) — its flags as written in the RFC are unsubstantiated. llama.cpp YaRN flags were verified against the locally installed `0.4.0-dev` (build 10809) binary **and** upstream master docs: all RFC flags exist except `--cache-ram`, which does not appear in either. GGUF original-context auto-detect is **already solved** by the repo's in-process parser (`src/utils/gguf.ts`), so no external tool is needed there.

## Current State

- **Product**: `llm-proxy` v0.1.0 — OpenAI-compatible gateway + chain orchestrator + llama-server backend (router/preset mode). Bun ≥ 1.4, TS strict ESM (NodeNext, `.js` extensions), Bun.serve fetch handler (Express/helmet deps remain in package.json but are NOT on the runtime path).
- **Repo shape**: `src/` 84 TS files (~9.6k LOC), 40 `*.test.ts` files (~9.6k LOC, **445 test cases**), 0 Svelte files (dashboard is static vanilla JS + HTML in `src/ui/`), Playwright e2e in `e2e/` (fake-manager harness, 1 spec), `dist/` artifacts, `scripts/build-binaries.ts`.
- **Architecture**: `index.ts` → config (zod + YAML, watcher) → `backend/manager.ts` (llama-server lifecycle, spawn `--port`, stdout port detection, SIGTERM→SIGKILL, backoff) + `preset.ts` (llama.cpp preset INI) → `providers/` (`Provider` contract: `chat`/`chatStream`; llama-server + openai-compatible impls) → `orchestrator/` (`graph.ts` DAG validation + safe AST interpreter, `graph-engine.ts` parallel fan/join, `engine.ts` linear chains, `composition.ts` nested pipelines) → `routes/` (chat, completions, health, models, dashboard REST/SSE) → `middleware/` (auth guard, OpenAI error envelope, passthrough proxy with SSRF guard).
- **OpenSpec**: `config.yaml` (strict_tdd: true, bun test), 14 synced specs (`backend-management`, `config-load`, `dashboard-api`, `dashboard-ui`, `external-providers`, `gateway-api`, `gateway-security`, `gguf-metadata`, `graph-engine`, `health-endpoints`, `pipeline-composition`, `pipeline-orchestration`, `proxy-pipeline`, `virtual-model-routing`), 8 archived changes. **Legacy chains specs die with this rewrite.**
- **CI/CD**: `.github/workflows/ci.yml` (lint + typecheck + bun test on PR → required e2e job), `release.yml` (tag → 6-target `bun build --compile` → GitHub release). Patterns: least-privilege, pinned actions, frozen lockfile.
- **Git**: `master` clean; 20+ legacy branches (`rewrite-to-gateway/*`, `migrate-to-bun*`, `svelte-ui*`, `dashboard-ui*`, `refactor/graph-canonical`) — historical interest only.
- **Deps**: `zod` (v3, real), `ai`/`@ai-sdk/*` (provider surface — used but replaceable), express/helmet (legacy). Dev: playwright, eslint 10, TS 5.5.

## Reuse Assessment (salvage vs die)

### SALVAGE — port into WeaveLLM (with adaptation)

| Module | Why it survives | Adaptation for WeaveLLM |
|---|---|---|
| `src/utils/gguf.ts` (+test) | In-process GGUF binary header parser: magic check, KV sweep, `{arch}.context_length`, `general.architecture`, VRAM probe, `effectiveCtx`. **This IS the yarn-orig-ctx auto-detect** (RFC invariant). Sub-ms on multi-GB files via `Bun.file().slice()`. | Read `{arch}.context_length` → `yarn_orig_ctx`; compute `rope_scale = ctx_size / yarn_orig_ctx`; guard ≥ 1. Also powers the NIAH/128K memory checks. Backed by `openspec/specs/gguf-metadata/spec.md`. |
| `src/backend/manager.ts` (llama-server lifecycle) | Already implements the RFC's exact sidecar contract: spawn with stdout parsing `listening\s+on\s+.*:(\d+)` when configured port is 0 (lines 505–511), SIGTERM→5s→SIGKILL, backoff restart, health. | Adapt from router/preset mode to single-model spawn with YaRN/KV flags; keep stdout-port extraction, kill-switch timing, health-check loop, unload semantics. |
| `src/orchestrator/graph.ts` + `graph-engine.ts` | DAG model with cycle validation (back edges only inside loop bodies), typed AST interpreter with `sanitizeAst` (rejects eval/URL/file refs), parallel fan/join, 429/tool_calls routing, per-step context refeed. The semantic nucleus of the workflow editor's validation + executor. | New node taxonomy (trigger/llm.call/prompt.template/logic/data/vector/memory/technique.*) maps onto the same validation + execution core; techniques expand to subgraphs. |
| `src/providers/types.ts`, `llama-server.ts`, `openai-compatible.ts`, `middleware/proxy.ts` | Clean `Provider` contract (`chat`/`chatStream`, AbortSignal forwarding), payload sanitization for llama.cpp, HOP_BY_HOP stripping, SSRF guard, OpenAI error envelope normalization. | Directly extends to OpenAI/Anthropic/OpenRouter backends; virtual-model dispatch (`gateway/<workflow>`) reuses the model-routing seam (`externalModels` map pattern). |
| `src/types/openai.ts` | OpenAI request/response/SSE types. | Keep as the `/v1` contract surface. |
| `e2e/e2e-server.ts` + `e2e/dashboard.spec.ts` | Fake-manager harness isolating the server from real llama-server; Playwright config. | Same pattern for WeaveLLM's app shell (inject fake sidecars). |
| CI/release + lint/tsconfig/bunfig | Bun toolchain, 2-job CI (unit→e2e), tag→release. | Release job becomes hutch/electrobun packaging for 3 targets; lint/typecheck/test skeleton reused. |
| Test-style pattern | Pure functions + injected deps + near-1:1 test coverage (9.6k LOC tests vs 9.6k LOC src). | Keep as project culture; **strict_tdd: true** stands (RFC AC #11: suite rewritten from scratch). |

### DIES

- Linear chains: `orchestrator/engine.ts` (runChain, Step model), chain parsing/routing, `virtual-model-routing` chain semantics → replaced by workflows.
- Router/preset mode: `backend/preset.ts` (llama.cpp `--models-preset` INI) — llama-swap style is dropped; WeaveLLM spawns llama-server per model with explicit flags. (The INI arg-name knowledge carries as a comment note only.)
- `src/ui/` vanilla JS dashboard → replaced by Astro/Svelte frontend.
- Config-as-file-only model (llm-proxy.config.yaml + watcher) → SQLite + YAML persistence.
- deps: express, helmet, ai-sdk trio (keep only if the design chooses ai-sdk for the 4-backend proxy; not required).
- 14 current specs: all superseded; archive as-is and write new deltas from zero.

## Approaches Compared (key decision points)

1. **GGUF original-context detection**
   - A. **Reuse in-process parser** (`gguf.ts`): zero deps, sub-ms, already tested, reads exactly `{arch}.context_length`.
   - B. Shell out to `gguf-dump`/`llama-gguf`: external Python/tool dep, breaks "cero dependencias externas". 
   - **Verdict: A.** Propose must not invent a new mechanism; this is resolved local evidence.

2. **YaRN flag derivation**
   - Inputs verified: `--rope-scaling {none,linear,yarn}`, `--rope-scale N`, `--yarn-orig-ctx N`, `-c/--ctx-size N`, `-ctk/-ctv TYPE` (f32,f16,bf16,q8_0,q4_0,q4_1,iq4_nl,q5_0,q5_1, default f16), `-ngl`, `-fa [on|off|auto]`, `-kvo/--kv-offload` — verified on local llama-server **0.4.0-dev (build 10809)** and upstream master docs.
   - RFC's `rope-scale 4, yarn-orig-ctx 32768, ctx-size 131072` example computes correctly as `131072/32768 = 4.0`. Invariant (scale ≥ 1, manifest = ctx/orig) is enforceable client-side before spawn.
   - **OOM guard**: llama.cpp 0.4.0 ships `--fit` (default **on**) auto-adjusting args to device memory, plus `-fitc --fit-ctx` min. Design should either rely on `--fit` or mirror its math with the repo's existing `hardwareMaxCtx`; never spawn unconditionally.
   - **`--cache-ram` does NOT exist** in local help nor upstream master README → RFC flag list needs amendment (see Risks).

3. **Download engine** — see Risks/gaps (gosh unverifiable). Structural answer stays: `DownloadEngine` abstraction (RFC's own call), so the engine choice is swappable without touching callers.

4. **Desktop shell** — see Risks/gaps (Electrobun runtime shift). WebView: system webview (macOS WKWebView native; Linux WebKitGTK 4.1) vs `bundleCEF` (Chromium, consistency > size — conflicts with <100 MB goal). Auto-update exists natively (Zstd self-extracting bundles + Zig BSDIFF patches).

## Recommendation

Proceed with the rewrite as RFC'd, with a **"port-in package"** of five modules carried forward explicitly: `gguf.ts`, the llama-server spawn/port/stop lifecycle from `manager.ts`, graph DAG validation + safe AST (`graph.ts`), the `Provider` contract + openai-compatible impl + proxy middleware, and `types/openai.ts`. Everything else is authored fresh. **Before propose freezes approach details, resolve the four external gaps below** (gosh, Electrobun runtime/Bun-main, llama.cpp `--cache-ram`/`--port 0`, Astro 7 stack) — via sdd-research, not by assumption.

## Risks

1. **[HIGH] gosh unverifiable** — No evidence of a "gosh" downloader (binary `gosh`, v0.2.9+, `-x 16`, `--checksum sha256:`, `--output json`, ETag resume) in npm, GitHub API, crates.io, Homebrew, or web search. If it is private/planned, propose must not commit to its flags; fallback candidates: Bun-native downloader (ETag/Last-Modified resume + `crypto.subtle` SHA-256 — zero licensing issue), `hf` CLI (Apache-2.0). The RFC's MIT-vs-GPL(aria2) rationale survives under all options.
2. **[HIGH] Electrobun main-process runtime drift** — Default runtime is now **Cottontail (JSC)**, not Bun ("Package management is independent of whether the app's main process runs on Cottontail or Bun" — Bun remains a stated option, but first-class support, version pinning, and FFI from Bun in that shell need verification). Also: **Linux end users need GTK3 + WebKitGTK 4.1 + AppIndicator + librsvg runtime packages** — conflicts with "descarga binario y funciona sin configuración externa" for Linux. macOS (system WKWebView) is unaffected.
3. **[MED] `--cache-ram` does not exist** in llama.cpp (local 0.4.0-dev help and upstream master README). The RFC's advanced-config list must be amended (KV offload is `-kvo/--kv-offload`; RAM/mmap controls are `--load-mode`/`--no-mmap`/mlock).
4. **[MED] `--port 0` semantics undocumented** in `--help` ("port to listen (default: 8080)"). The repo's manager already parses stdout (`listening on ...:<port>`), so the pattern is sound, but the design should pin a minimum llama.cpp version where this is verified.
5. **[MED] Sandbox + keychain on Linux** — `data.code` sandbox (subprocess, no-net, tmp-only, timeout) and API-key encryption via macOS Keychain / Linux Secret Service have **no existing evidence in this repo**; both are greenfield design with real platform surface (libsecret/DBus from Bun; Bun FFI maturity). Budget design time; setsockopt-less "no network" enforcement must be proven in tests.
6. **[MED] <100 MB bundle target vs Electrobun modes** — system-webview mode is "small self-extracting bundles"; `bundleCEF` trades size for consistency and would blow the cap. Also the Bun/Cottontail runtime + llama-server are NOT bundled (sidecar downloaded on demand?) — bundle-size accounting must define what's inside the app bundle vs fetched at first run (GGUF models obviously excluded).
7. **[LOW] Stack-vintage drift** — RFC says "Astro 4/5"; current reality: **Astro 7.3.2**, **@astrojs/svelte 9.0.1**, **Svelte 5.57.0**, **@xyflow/svelte 1.6.6** (peer `svelte ^5.25.0` — Svelte-5-compatible; `2.0.0-next.3` is the runes rewrite). Propose should target current majors and pin.

## External Gaps (for pre-propose research gate)

1. **gosh**: does it exist, and where (repo, license, version)? Verify `-x`, `--checksum sha256:`, `--output json`, resume behavior against its docs/`--help`. If unverifiable → decide: Bun-native downloader vs hf CLI. (donsetch + GitHub API all negative so far.)
2. **Electrobun**: Bun-main-process support status (docs at `blackboardsh/electrobun` — `docs/` is an Astro site), `hutch.config.ts` surface (app name, bundleCEF flag, runtime selection, icons, auto-update config), macOS minimum version + signing/notarization, Linux runtime-dep bundling options, pinned release/channel workflow.
3. **llama.cpp**: confirm `--cache-ram` ground truth (search llama.cpp issues/changelog), `--port 0` support on current release, and pick the minimum bundled llama-server version for WeaveLLM (local dev binary is 0.4.0-dev build 10809). Verify `-ctk q8_0/-ctv q8_0` cost/quality at 128K on target hardware for the KV-cache-quant option.
4. **Astro 7 + @astrojs/svelte 9 + adapter-static** integration state for a desktop-shell SPA (static build into Electrobun webview); confirm `@xyflow/svelte` 1.6.6 (Svelte 5.25+ peer) vs 2.0-next choice for the editor.

## Ready for Proposal

**Yes** — scope, salvage list, and risk map are complete and evidence-backed. The orchestrator should tell the user: **propose must not hard-commit to gosh flags or to "Bun inside Electrobun" until the four external gaps are run through the sdd-research lane**; everything else (GGUF auto-detect, YaRN derivation, provider seam, DAG validation nucleus) is locally proven and ready to design around.

## Key Learnings

1. The repo already contains a tested in-process GGUF parser (`src/utils/gguf.ts`) that reads `{arch}.context_length`, which fully covers the RFC's yarn-orig-ctx auto-detect invariant.
2. The llama-server manager already implements `--port 0` stdout port extraction via a `listening on ...:<port>` regex, exactly matching the RFC's sidecar contract.
3. llama.cpp 0.4.0-dev (build 10809) and upstream master verify all RFC YaRN/KV flags except `--cache-ram`, which does not exist.
4. Electrobun's default main-process runtime is now Cottontail (JSC) with Bun as an option, and Linux end-user machines require WebKitGTK 4.1 runtime packages, conflicting with the RFC's zero-dependency Linux assumption.
5. The "gosh" downloader CLI (v0.2.9+, `-x 16`, `--checksum sha256:`) could not be verified on npm, GitHub, crates.io, Homebrew, or web.