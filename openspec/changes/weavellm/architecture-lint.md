# Architecture Lint — weavellm

- **Change**: `weavellm` (openspec/changes/weavellm)
- **Phase**: D9 architecture lint (independent, post-apply, pre-verify)
- **Date**: 2026-09-14
- **Mode**: READ-ONLY review. No source/spec/design/tasks files were modified. No test execution was used as verification (evidence is source-level, via CodeGraph index + targeted reads). No agents, no commits.

## Verdict

| Axis | Verdict | Summary |
| --- | --- | --- |
| Axis 1 — requirements/scope (quest RFC ACs + 15 delta specs vs implementation) | **PASS** | Every spec delta has implemented, wired machinery. Three disclosed partials (findings A1-1, A1-2, A1-5) limit end-to-end *local-model* functionality and stream *fidelity*, not architecture conformance. Zero blocker violations. |
| Axis 2 — design decisions D1–D10 (design.md decision body, title-by-title) | **PASS** | All ten decisions honored; the decision body was resolvable for every title (no fail-closed events). |

No ❌ findings. 4 titled findings (3 ⚠️ + 1 ✅-with-context) plus 2 minor notes.

---

## Axis 1 — Requirements / scope

### Method

- Evidence: implementation surface `src/` (91 .ts) + `frontend/` (editor + renderer shell), cross-checked against all 15 delta specs, quest.md RFC ACs, tasks.md, apply-progress.md.
- **Runtime binding applied**: the provider set is `local + OpenAI + Anthropic + OpenRouter` (resolved by orchestrator + user) and takes precedence over spec text where they disagree — the implementation is judged against the binding.

### Findings

**A1-1 ⚠️ (major) — Managed llama-server is never wired into the runtime path (deviation 1)**

- Evidence: `src/main.ts` `boot()` wires `localProvider: () => null`, `localModels: () => []`, and documents the deferral ("The managed llama-server backend is spawned once a model is selected (catalog/manager); until then, local ids do not resolve and answer the 404 envelope"). `src/backend/manager.ts` and `src/backend/spawn-args.ts` have **zero runtime callers** — a repo-wide import search finds them only from their own unit tests. The catalog registers models into SQLite, but no wired route activates a model (the `/api` surface is workflows-only), so no path exists today that triggers a spawn.
- What IS implemented: the full D5/D6 machinery — `manager.ts` (per-model `spawnOnce`, `--port 0` stdout parse, health poll, `IDLE_TIMEOUT_MS` 5 min, exponential-backoff restart, `stop()`), `checkLlamaVersionFloor` (rejects llama.cpp < b9908 with an actionable message), `assertSafeSpawnArg`, `--cache-ram` capping host prompt cache only, q8_0 1.0625 bytes/element.
- Impact vs quest ACs: AC 3 (local GGUF via /v1/chat/completions), AC 13/YaRN-end-to-end, and the local half of AC 6 (embeddings/rag_local) are **not satisfiable in the current system state** — local ids return the 404 `model_not_found` envelope. Unit-level behavior is real and tested with fakes; the wiring seam that would make it reachable (model activation → `manager.start()`) is the missing glue.
- Judgment: this is a **scope-completion gap, disclosed in apply-progress and consistent with the design direction** — the seams are exactly right (pure `SpawnArgs` + injected manager + catalog/DB state), so the follow-up wiring is additive, not corrective. It does not break any boundary or contract. Flagged as the primary hand-off item: the backend-management spec's "boot-time readiness gate (spawn + wait-ready before accepting traffic)" as literally written is not what the system does; the architecture's choice (spawn on activation, not at boot) supersedes it. Spec text should be aligned to the activation model at archive.

**A1-2 ⚠️ (moderate) — /ws `token` events deliver the completed run as one chunk (deviation 3)**

- Evidence: `src/app/ws.ts` relays `{type:"token", … data: <one OpenAI-wire SSE payload>}` followed by exactly one `{type:"token", …, data: "[DONE]"}` — the *completed* (non-streamed) run in a single chunk. Step events (`step_started`, `step_completed`, `error`, `reroute`) are streamed live from the engine via the `onEvent` relay. Disconnect aborts the run (AbortController), and non-WebSocket upgrade attempts receive 426.
- Spec check (websocket-streaming): wire shape ✅, exactly one terminal `data: [DONE]` ✅, abort-on-disconnect ✅, event ordering ✅ (synchronous relay preserves step N → N+1 order). "Token deltas" ✋ — the run output arrives whole, not as per-token deltas.
- Root cause: the workflow engine is currently synchronous (`run` → result); token-delta streaming is a documented future engine feature (apply-progress "faithful to design; streaming remains a future engine feature"). The observable contract that can be honored without engine streaming (terminal chunk exactly once, live step events, abort) is fully met.
- Judgment: partial against the streaming *purpose* language, compliant on the enforced wire contract. The orchestration event surface is live and ordered, which is the architecturally load-bearing half.

**A1-3 ⚠️ (minor) — Sandbox subprocess ignores AbortSignal (deviation 2)**

- Evidence: `EngineServices.runCode(code, input, opts)` declares `opts.signal`, but `src/main.ts` wires `sandbox: (code, input, _opts) => runSandbox(code, { input })` — the signal is dropped at the wiring; `SandboxDeps.spawn` takes no signal either. A client disconnect (or node-level cancel) during a `data.code` step does not kill the subprocess; it runs until the timeout (default 10 s) or output-cap.
- Judgment: D10's *letter* (unshare -n on Linux / sandbox-exec on macOS, tmp cwd, env whitelist, timeout, output cap) is fully met — the sandbox is timeout-bounded, never infinite. The signal drop is a seam smell in the *wrapper*, not an isolation flaw. Low risk: the blast radius is bounded by the 10 s timeout; still, the declared `signal` parameter should either be honored or removed from the contract.

**A1-4 ✅ — Provider set matches the binding (deviation 4); spec text is stale, implementation is not**

- Evidence: `ProviderKind = "local" | "openai" | "anthropic" | "openrouter"`; adapters exist for OpenAI-compatible, Anthropic, and OpenRouter (each with `models`, `requiresKey`, `misconfigured`, `fallbackId`), plus the managed local provider. This equals the binding resolved at orchestrator level.
- The external-providers/external-proxy spec text still lists Google + Groq — that text is stale relative to the binding, and the discrepancy is already recorded in design.md's Open Question (align specs to handoff at archive). Per the lint's runtime binding, the **implementation conforms**; the spec alignment is an sdd-archive concern, not a code finding.

**A1-5 ⚠️ (minor) — Update availability is not surfaced in-repo**

- Evidence: `checkForUpdate` runs at boot (background, non-blocking; network failure → `{available:false, offline:true}` silent skip) and `applyUpdate` is gated on explicit consent (`consent-required` enforcement is server-side). The availability state is written to `globalThis.__WEAVELLM_UPDATE__`, but no in-repo route or renderer code reads it (`/api/update`, referenced in a comment, does not exist in `api.ts`; the renderer would need an Electrobun preload bridge, which lives outside this repo's `src/`).
- Judgment: the spec's hard requirement ("install SHALL require explicit user consent") is enforced regardless of UI plumbing. The banner/offer surface is unplumbed in-repo — a thin follow-up, not a contract break. Consent-gated install: ✅.

### Spec-by-spec evidence roll-up (all 15, no ❌)

- **backend-management**: machinery complete, runtime wiring deferred → see A1-1.
- **data-code-sandbox**: `runSandbox` wired for real at boot (`services.runCode` → subprocess), env whitelist PATH/TMPDIR/HOME, tmp cwd, timeout 10 s, output cap, Linux `unshare -n` / macOS `sandbox-exec` → ✅ (signal caveat A1-3).
- **desktop-app-shell**: Electrobun `build.mainProcess:"bun"` + entrypoint `src/main.ts`; 3 targets (darwin-arm64, darwin-x64, linux-x64); Flatpak runtime `org.gnome.Platform//46`; CEF/WGPU unbundled (bundle < 100 MB); cold start measured at boot with budget log → ✅ (sub-2s is evidenced at main-process level; interactive window time is Electrobun-hosted).
- **embeddings-rag**: `ChunkStore` cosine top-k with dim-mismatch skip and empty-set handling; `rag_local` node with `NO_CONTEXT_NOTICE` when nothing retrieves; `memory` node (kv_memory, conv-scoped recent window) → ✅ as implemented; end-to-end retrievability waits on the local backend (A1-1).
- **external-providers / external-proxy**: default `127.0.0.1:4317` (`DEFAULT_HOST`/`DEFAULT_PORT`), four-provider registry + adapters, `ProviderMisconfiguredError`, fallback chain (429/5xx/net, max 3 hops, non-retryable 4xx fail fast); /v1 chat/completions, completions, models, embeddings; 404 `model_not_found` envelope for unmapped ids; SSE relay with exactly one terminal `[DONE]`, premature `[DONE]` consumed, client disconnect aborts upstream → ✅. Routing table matches binding (A1-4).
- **gateway-security**: auth OFF by default (`WEAVELLM_AUTH` opt-in), loopback bind default, 401 `authentication_error` envelope, timing-safe compare, keychain "auth" scope → ✅.
- **gguf-metadata**: GGUF parse, `context_length` extraction, YaRN auto-derivation → ✅ (see A2 D7).
- **keychain-secrets**: AES-256-GCM (12-byte nonce, 32-byte key), OS Keychain/Secret Service master key, scoped `SecretStore` upsert, tamper → `SecretTamperError`, auth key under "auth" scope → ✅.
- **local-model-catalog**: `CURATED_MODELS` + sha256 verification, HF search (`filter=gguf`), local GGUF registration with non-GGUF rejection, NIAH probe (`runNiahProbe`) → ✅ (end-to-end activation: A1-1).
- **model-advanced-config**: one `model_config` row per model (ctx_size, kv_k/v, n_cache_gpu, cache_ram, ngl, flash_attn) with schema + read/write + spawn-arg projection → ✅.
- **model-downloads**: `DownloadEngine` (enqueue/resume/resumeAll/cancel/state/list), gosh CLI integration, `sha256:` checksum prefix enforcement, `--output json` → ✅ (note: transfer parallelism is `-x 8`, design text shows `-x 16` — cosmetic divergence, see Notes).
- **websocket-streaming**: /ws hub with per-socket workflow binding, run-scoped AbortController, live step events, exact-once terminal `[DONE]`, 426 for non-WebSocket → ✅ (token-delta fidelity: A1-2).
- **workflow-editor**: Svelte 5 canvas on `@xyflow/svelte` 1.6.6; palette of 14 node types **derived from the engine's own `NODE_TYPES`** (same module — no drift possible); BFS cycle rejection at edit time; YAML import/export round-trip (positions/labels stripped on export); live engine validation on canvas → ✅.
- **workflow-engine**: `validateGraph` gauntlet (exactly one start, ≥1 end, edges reference real nodes, per-type required fields, model existence, cycle detection, connectivity); `executeNode` covering llm_call/condition/router/loop/fan/join/data.code/memory/embeddings/rag_local/pipeline/output; `on_429` and `tool_calls_route` rerouting with `reroute` events; MoA 3+1 synthesis (draft turns per branch); memory store; `gateway/<name>` virtual models + `X-Chain-ID` header; pipeline composition across stored workflows → ✅.

---

## Axis 2 — Design decisions D1–D10 (title-by-title)

Decision body source: `openspec/changes/weavellm/design.md` tiled decisions (runtime acta-equivalent; `sdd-architecture-plan`/`sdd-council` are not exposed in this runtime). The body was resolvable for every title — no fail-closed events.

| # | Decision | Evidence | Verdict |
| --- | --- | --- | --- |
| D1 | Bun main process + entrypoint (Electrobun `build.mainProcess: "bun"`) | `electrobun.config.ts`: `build.mainProcess: "bun"`, `entrypoint: "src/main.ts"`; main.ts boots server + update check. | ✅ |
| D2 | Astro 7 native static output (adapter-static removed in v7) | `frontend/astro.config.ts`: `output: "static"`, `integrations: [svelte()]`, no adapter; `package.json`: `astro 7.3.2`, `@astrojs/svelte 9.0.1`, `svelte 5.57.0` (exact pins). | ✅ |
| D3 | `@xyflow/svelte` 1.6.6 pinned (stable v1 over 2.0-next) | `package.json`: `"@xyflow/svelte": "1.6.6"` exact. | ✅ |
| D4 | gosh CLI via DownloadEngine; `sha256:` checksum prefix | `src/downloads/engine.ts` (interface) + `gosh.ts` (`assertChecksumPrefix` rejects bare hex; `--checksum sha256:<hex>`, `--output json`). | ✅ (note: `-x` default 8 vs design text 16) |
| D5 | Single-model spawn (router dropped); one llama-server per model; port-0 detect ported; SQLite flags | `manager.ts` `spawnOnce` + `buildLlamaSpawnArgs` + `parseListeningPort`; `--cache-ram` caps host prompt cache only. Machinery complete; runtime activation deferred (see A1-1 — the decision itself is honored in the seam). | ✅ |
| D6 | llama.cpp b9908+ fail-fast gate | `checkLlamaVersionFloor` (spawn-args.ts) — bNNNN parse, rejects < 9908 with actionable message. | ✅ |
| D7 | YaRN auto from GGUF; scale = ctx/orig, guard ≥ 1; manual fallback when GGUF lacks context | `gguf.ts`: `yarnScale`(L574), `MIN_ROPE_SCALE = 1`(L555) with RangeError below 1, `yarnOrigCtx` from `{arch}.context_length`, `resolveYaRN` → null when absent (falls back to manual). | ✅ |
| D8 | Keychain AEAD (AES-256-GCM); key in OS Keychain/Secret Service | `keychain.ts`: 32-byte key + 12-byte nonce, `getOrCreateMasterKey` via `platformKeychainBackend`, `SecretStore` scoped upserts, `SecretTamperError`. | ✅ |
| D9 | Auth OFF default; 127.0.0.1 bind | `config.ts`: `DEFAULT_HOST = "127.0.0.1"`, `authEnabled` only via `WEAVELLM_AUTH`; `routes/auth.ts` timing-safe gate → 401 `authentication_error`. | ✅ |
| D10 | Subprocess sandbox: `unshare -n` (Linux) / `sandbox-exec` (macOS); tmp cwd, env whitelist, timeout, output cap | `sandbox/runner.ts`: `buildSandboxEnv` whitelist PATH/TMPDIR/HOME, tmp workspace, `timeoutMs` default 10 s, `maxOutputBytes` cap; platform sandbox wrapper. | ✅ (signal caveat A1-3) |

---

## Deviation evaluations (apply-progress.md items)

| # | Deviation | Evidence | Verdict |
| --- | --- | --- | --- |
| 1 | No llama-server spawn at boot; local ids → 404 until model-selection UX | `boot()` `localProvider: () => null`; manager has zero runtime callers | **⚠️ PARTIAL** — disclosed, design-consistent; end-to-end local ACs not demonstrable today (A1-1) |
| 2 | Sandbox seam ignores AbortSignal (timeout-bounded only) | `main.ts` wiring drops `opts`; `SandboxDeps.spawn` has no signal | **⚠️ MINOR** — D10 letter met; wrapper contract smell (A1-3) |
| 3 | /ws `token` events relay completed run in one chunk | ws.ts single SSE payload + one `[DONE]`; step events live | **⚠️ PARTIAL** — wire contract met; token-delta fidelity is a future engine feature (A1-2) |
| 4 | Provider set = local+OpenAI+Anthropic+OpenRouter | `ProviderKind` + adapters | **✅ CONFORMS TO BINDING** — spec text stale, tracked in design Open Question (A1-4) |

---

## Risks / hand-off

1. **(Primary) Local-model runtime wiring is absent.** Model activation → `manager.start()` glue does not exist in the wired graph (no `/api/models` activation route; `/api` is workflows-only). This is the single change that unlocks ACs 3/6/13/14 end-to-end. Verify must treat local-model ACs as **not demonstrated in the current system state**; the next change should own the activation wiring.
2. **Spec text drift to align at archive** (sdd-archive): provider set (Google+Groq → binding set, already an Open Question), backend-management "boot-time readiness gate" (activation-model supersedes it), websocket-streaming "token deltas" (single-chunk delivery until engine streams), model-downloads `-x 16` example vs `-x 8` default. Repo-level docs (AGENTS.md, README) still describe a pre-weavellm architecture entirely.
3. **Update surfacing** is unplumbed in-repo (no `/api/update`; consent gate itself is server-side and safe).
4. **Sandbox signal** — honor or remove `opts.signal` from the `EngineServices.runCode` contract to avoid a false cancellation promise.

## Notes (non-blocking)

- `electrobun.config.ts` documents Cottontail JSC as the default engine with no override — consistent with design module table.
- WebSocket non-WebSocket upgrade → 426; event order preserved by synchronous relay.
- Report is source-evidence based; test counts from apply-progress (382 pass) are context only and were not used as verdict evidence.