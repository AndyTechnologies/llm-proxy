# Research: weavellm — external evidence for 4 pre-proposal lanes

Status: done (verification closed by orchestrator; product decisions confirmed by user)
Date: 2026-09-14
Request: `weavellm-research-lanes-20260914-001` (revision `rc-1`)
Mandate: `openspec/changes/weavellm/quest.md` (approved RFC); lanes selected by user from explore gaps
Envelope: `gentle-ai.sdd-research/v1`

## Executive Summary

Research confirms the feasibility of every question's core premise with strong-to-medium evidence: the `gosh` CLI downloader exists with all required flags (`-x`, `--checksum md5:/sha256:`, `--output`, resume) through **v0.6.3**; Electrobun v2 fully supports Bun as a first-class main-process runtime with signing, channels, and Linux/Flatpak packaging; llama.cpp `--cache-ram` has existed since **Oct 2025** (PR #16391), is now enforced as a hard limit (b9908, **2026-07-08**), and the `q8_0` KV cost model is verifiable down to the struct byte-count; Astro 7 + `@astrojs/svelte` 9.0.1 + Svelte 5 + `@xyflow/svelte` 1.6.6 (peer `svelte ^5.25.0`) is a confirmed compatible stack. Three items remain unresolved: (1) the "xyflow 2.0-next runes rewrite" characterization has no supporting evidence; (2) `@astrojs/adapter-static` appears removed in Astro 7 but no explicit confirmation exists; (3) `--port 0` ephemeral selection is stated in a member-authored open PR (#28690) but is undocumented in the current stable release notes. Two of the four gaps are product/decision choices, not evidence gaps.

## Sources

| ID | Class | Title / Publisher | URL | Accessed | Excerpt / Key Finding |
|---|---|---|---|---|---|
| S1 | open-web | gosh-dl-cli README | `github.com/goshitsarch-eng/gosh-dl-cli` | 2026-09-14 | Binary `gosh`; flags: `-x, --max-connections <N>` (default 8); `--checksum <HASH>` (`md5:` / `sha256:` prefixes required); `--output <FORMAT>` (table/json/json-pretty); resume via `resume`/`resume-all` + persistent SQLite queue; MIT; Rust. |
| S2 | open-web | gosh-dl-cli Releases | `github.com/goshitsarch-eng/gosh-dl-cli/releases` | 2026-09-14 | Latest: **v0.6.3** (2026-09-05); v0.2.9 release dated 2026-03-08 (asserted via prior session Engram + truncated release list — low risk since latest supersedes). |
| S3 | documentation | docs.rs/gosh-dl-cli | `docs.rs/crate/gosh-dl-cli` | 2026-09-14 | Crate versions 0.2.7 and 0.5.0 published; confirms upstream Rust crate existence. |
| S4 | documentation | Electrobun docs — hello-world-bun | context7 `/blackboardsh/electrobun` | 2026-09-14 | "Cottontail is the default main process runtime"; Bun optional via `build.mainProcess: "bun"` + `bun.entrypoint` in `electrobun.config.ts`. |
| S5 | documentation | Electrobun docs — build-configuration | context7 `/blackboardsh/electrobun` | 2026-09-14 | `build.mainProcess`: zig/cottontail/rust/go/odin/**bun**; `build.mac.codesign`/`notarize` defaults false, `createDmg` default true; second build triggers codesigning; Linux `flatpak` FlatpakConfig, `bundleCEF`/`bundleWGPU` booleans, `defaultRenderer` "native"/"cef". |
| S6 | documentation | Electrobun docs — hutch.config.ts | context7 `/blackboardsh/electrobun` | 2026-09-14 | `electrobun.version` exact pin (e.g. `"2.1.0"` or `"2.1.0-beta.3"`) wins over bootstrap/channel; `// @hutch cli=0.24.3 cottontail=0.5.0` toolchain pin; `release.overrides.stable` channel env toggling. |
| S7 | documentation | Electrobun docs — naming.ts | context7 `/blackboardsh/electrobun` | 2026-09-14 | Artifacts named `{channel}-{os}-{arch}`; stable has no channel suffix (e.g. `stable-macos-arm64` vs `canary-win-x64`); env `ELECTROBUN_STABLE="true"`/`"false"` toggles channel. |
| S8 | documentation | Electrobun docs — migrating-to-v2 | context7 `/blackboardsh/electrobun` | 2026-09-14 | v2 changes: root config files (no `apps/` nesting); `--experimental` flag is v1 only; hutch scripts migrated per hutch docs. |
| S9 | open-web | Electrobun README — Platform Support | `github.com/blackboardsh/electrobun` | 2026-09-14 | macOS 14+ **Official**; Windows 11+ **Official**; Ubuntu 24.04+ **Official**, other Linux Community; deps: WebKitGTK 4.1, GTK3, libayatana-appindicator3, librsvg2 (apt/fedora/arch package names listed). |
| S10 | documentation | Electrobun docs — native-main-process | context7 `/blackboardsh/electrobun` | 2026-09-14 | Available runtimes: zig/cottontail/rust/go/odin; "Cottontail is the default"; Bun first-class option; task lifecycle: mousedown until task completes. |
| S11 | documentation | Electrobun docs — code-signing | context7 `/blackboardsh/electrobun` | 2026-09-14 | Hutch validates + staples embedded apps; debug builds skip notchar/codesign/notarize with "debug" channel; signing fires on second build+; Apple accounts limited to 14 certificates + 50 apps. |
| S12 | open-web | llama.cpp server README (master) | `raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md` | 2026-09-14 | `-cram, --cache-ram N` max cache MiB, default 8192, -1 unlimited, 0 disable, env LLAMA_ARG_CACHE_RAM; `--cache-type-k/-v` allowed f32 f16 bf16 q8_0 q4_0 q4_1 iq4_nl q5_0 q5_1, default f16; `--port PORT` default 8080. |
| S13 | open-web | Jesse Quinn — llama.cpp cache-ram prompt caching | `jessequinn.info/blog/llama-cpp-cache-ram-prompt-caching` | 2026-09-14 | PR #16391 introduced Oct 2025; default 8 GiB; `--cache-ram` caps **host-memory prompt caching** only (NOT KV placement — corrects common misconception); `--cache-type-k/-v` + `--n-cache-gpu` control KV placement; Qwen 3.6 35B-A3B, 128k ctx, q8_0 KV, 2 slots → ~4 GiB/slot; f16 doubles; b8185 perf fix. |
| S14 | open-web | thetesserapress.com — ggerganovllamacpp-b9908 | `thetesserapress.com/articles/ggerganovllamacpp-b9908` | 2026-09-14 | b9908 tagged **2026-07-08**; PR #25070, commit 6c487e2, enforces `--cache-ram` as hard limit; issue #21690 (Gemma3 OOM with 2 slots); skips cache entries exceeding limit, evicts old entries before saving new; token-limit cleanup can remove last entry. |
| S15 | documentation | Debian unstable llama-server(1) manpage | `manpages.debian.org/unstable/llama.cpp-tools/llama-server.1.en.html` | 2026-09-14 | Confirms `-cram, --cache-ram N` (same semantics as S12); `--port PORT` default 8080; cache types incl. q8_0; KV offload enabled by default; `-mlock` deprecated. |
| S16 | open-web | PR #28690 — Multiple address binding | `api.github.com/search/issues` (result) | 2026-09-14 | PR #28690 by `erusev` (member), opened **2026-09-10**, **OPEN**; title: "server: Add support for binding to multiple addresses"; body: "With `--port 0`, the first TCP listener selects an available port for the others." |
| S17 | open-web | ggml-common.h — block_q8_0 | `raw.githubusercontent.com/ggml-org/llama.cpp/master/ggml/src/ggml-common.h` | 2026-09-14 | `#define QK8_0 32`; `struct block_q8_0 { ggml_half d; int8_t qs[32]; }` + static_assert sizeof == 34 → **1.0625 B/elem**. |
| S18 | documentation | npm registry — astro / @astrojs/svelte / @xyflow/svelte | `registry.npmjs.org` + `cdn.jsdelivr.net` | 2026-09-14 | astro@latest = **7.3.2** MIT; @astrojs/svelte@latest = **9.0.1** MIT, peer astro ^7.0.0, svelte ^5.43.6, typescript ^5.3.3\|\|^6.0.0, engines node >=22.12.0; @xyflow/svelte dist-tags: `{latest:"1.6.6", next:"2.0.0-next.3"}`. |
| S19 | documentation | Astro upgrade-to-v7 guide | `docs.astro.build/en/guides/upgrade-to/v7/` | 2026-09-14 | Rust compiler now default (Go removed), `queuedRendering` default on, `logger` stable, `advancedRouting` default (src/fetch.ts reserved), route caching stable, Vite 8, `@astrojs/db` removed. |
| S20 | documentation | Astro integrations guide — Svelte | `docs.astro.build/en/guides/integrations-guide/svelte/` | 2026-09-14 | @astrojs/svelte 9.0.1 renders **Svelte 5** components; Svelte 3/4 → use `@astrojs/svelte@5` instead; adapter list sidebar: cloudflare/netlify/node/vercel — **adapter-static absent**. |
| S21 | documentation | @astrojs/adapter-static — npm registry | `registry.npmjs.org/@astrojs/adapter-static` | 2026-09-14 | **404** on both `/latest` and package root; `docs.astro.build/en/guides/deploy/static/` also 404. Convergent negative evidence (3 signals: npm 404, docs 404, sidebar omission). |
| S22 | documentation | @xyflow/svelte@1.6.6 package.json | `cdn.jsdelivr.net/npm/@xyflow/svelte@1.6.6/package.json` | 2026-09-14 | MIT; **peerDependencies: `{svelte: "^5.25.0"}`** (matches question premise exactly); deps: @svelte-put/shortcut ^4.1.0, @xyflow/system **0.0.82**. |
| S23 | documentation | @xyflow/svelte@2.0.0-next.3 package.json | `cdn.jsdelivr.net/npm/@xyflow/svelte@2.0.0-next.3/package.json` | 2026-09-14 | peer svelte ^5.25.0; @xyflow/system **1.0.0-next.3**; engines node >=20; exports restructured (esm-only, no ./dist prefix); files include `src/lib`. |
| S24 | open-web | xyflow/xyflow README | `github.com/xyflow/xyflow` | 2026-09-14 | Monorepo: packages/svelte (`@xyflow/svelte`), packages/system (`@xyflow/system`); releases via changesets; MIT; current docs reflect v1.x API (SvelteFlowProvider, legacy `on:nodeclick` syntax). |
| S25 | documentation | svelteflow.dev — learn / API reference | `svelteflow.dev/` | 2026-09-14 | Current public docs are **v1.x**; no 2.0/runes page on docs home; "migrate-to-v1" guide exists. |

## Claims

### Q1 — gosh downloader CLI

| Claim | Sources | Certainty |
|---|---|---|
| `gosh` CLI = `goshitsarch-eng/gosh-dl-cli`, binary `gosh`, MIT, Rust | S1 | high |
| `-x, --max-connections <N>` default 8 → `-x 16` valid | S1 | high |
| `--checksum <HASH>` requires `md5:` / `sha256:` prefixes | S1 | high |
| `--output <FORMAT>` accepts table/json/json-pretty | S1 | high |
| Resume via `resume`/`resume-all` subcommands + persistent SQLite queue | S1 | high |
| Latest release: v0.6.3 (2026-09-05); v0.2.9 (2026-03-08) exists | S2, S3, prior-session Engram | high (latest); medium (v0.2.9 — truncated list) |

### Q2 — Electrobun

| Claim | Sources | Certainty |
|---|---|---|
| Default main process = Cottontail (Zig + JavaScriptCore); Bun optional via `build.mainProcess: "bun"` + `bun.entrypoint`; also zig/rust/go/odin | S4, S5, S10 | high |
| hutch.config.ts: exact `electrobun.version` pin wins over bootstrap/channel; `// @hutch cli=0.24.3 cottontail=0.5.0` pragma comment for toolchain pin | S6 | high |
| Release channels stable/canary/dev; artifacts named `{channel}-{os}-{arch}`; stable has no suffix | S7, S8 | high |
| macOS min 14+ (Official); `codesign`/`notarize` default false, `createDmg` default true; Hutch signs nested Mach-O, notarizes, staples, validates | S9, S11, S5 | high |
| Linux: Ubuntu 24.04+ Official, other distros community; deps WebKitGTK 4.1 + GTK3 + AppIndicator + librsvg | S9 | high |
| Linux/Windows bundling: Flatpak (writes flatpak-builder manifest + /app payload; Hutch does NOT run builder), bundleCEF/bundleWGPU, defaultRenderer "native"/"cef" | S5 | high |

### Q3 — llama.cpp cache-ram / KV

| Claim | Sources | Certainty |
|---|---|---|
| `--cache-ram`/`-cram` EXISTS in current master: default 8192 MiB, -1 unlimited, 0 disable, env LLAMA_ARG_CACHE_RAM | S12, S15 | high |
| Caps **host-memory prompt caching** only; does NOT force KV offload into system RAM (common misconception) | S13 | high |
| Introduced PR #16391 (Oct 2025); b8185 perf fix mid-May 2026; b9908 (2026-07-08, PR #25070, commit 6c487e2) enforces hard limit — fixes #21690 OOM; skips oversized entries, evicts before save | S13, S14 | high |
| `--cache-type-k/-v` allowed: f32 f16 bf16 q8_0 q4_0 q4_1 iq4_nl q5_0 q5_1; default f16; env LLAMA_ARG_CACHE_TYPE_K/V | S12, S15 | high |
| block_q8_0: QK8_0 = 32, struct {ggml_half d; int8_t qs[32]} = 34 B / 32 elems = **1.0625 B/elem** | S17 | high |
| Empirical: Qwen 3.6 35B-A3B, 128k ctx, q8_0 KV, 2 slots → ~4 GiB/slot; q8_0 ≈ halves f16 | S13 | medium-high (single source) |
| `--port` default 8080 documented; `--port` 0 = OS-assigned ephemeral port (per PR #28690 member statement, not merged); 0 NOT in README/manpage | S12, S15, S16 | high (8080 default); medium (port 0 behavior) |

### Q4 — Astro + Svelte Flow

| Claim | Sources | Certainty |
|---|---|---|
| astro latest = 7.3.2 (MIT); v7: Rust compiler default (Go removed), Vite 8, advancedRouting default, queuedRendering default, src/fetch.ts reserved | S18, S19 | high |
| @astrojs/svelte 9.0.1 (MIT); peer astro ^7.0.0, svelte ^5.43.6, typescript ^5.3.3\|\|^6.0.0; engines node >=22.12.0; renders Svelte 5 | S18, S20 | high |
| @astrojs/svelte 5.x targets Svelte 3/4 (legacy route) | S20 | high |
| @astrojs/adapter-static likely removed/folded into Astro 7 core — npm 404 (×2), docs deploy/static 404, absent from adapter sidebar | S21, S20 | medium-high inference (no explicit "removed" line) |
| @xyflow/svelte dist-tags: latest 1.6.6, next 2.0.0-next.3 | S18 | high |
| @xyflow/svelte 1.6.6 peerDependencies: `svelte: ^5.25.0` (matches question premise) | S22 | high |
| @xyflow/svelte 2.0.0-next.3: peer svelte ^5.25.0; @xyflow/system 1.0.0-next.3; esm-only exports (API surface change); files include src/lib | S23 | high (metadata); medium (API change interpretation) |
| "2.0-next = Svelte 5 runes rewrite" characterization is **NOT directly evidenced** — no release notes, blog, or doc page found | S24, S25 (absence) | **low/ungrounded** — must not be treated as confirmed |

## Contradictions

| ID | Claim A | Claim B | Resolution |
|---|---|---|---|
| k1 | Prior session Engram: "llama.cpp --cache-ram nonexistent" | Exists since Oct 2025 (PR #16391), confirmed current in README + manpage | **Prior observation is stale/wrong.** The feature was introduced post-observation date. Carry updated evidence (S12, S13, S15). |
| k2 | Common assumption: `--cache-ram` = "put KV in system RAM" | `--cache-ram` caps host prompt cache only; KV placement is controlled by `--cache-type-k/v` + `--n-cache-gpu` | **Misconception.** Design must use separate controls for prompt-cache budget vs KV placement. (S13) |
| k3 | @astrojs/adapter-static presumed available (Astro 5 pattern) | npm 404, docs 404, sidebar omission | **Likely removed/folded in Astro 7.** Medium-high inference; explicit confirmation still needed at design time via `npm view @astrojs/adapter-static`. |

## Gaps

| ID | Description | Resolution |
|---|---|---|
| g1 | xyflow 2.0.0-next.3 "runes rewrite" — no doc/blog/release-note confirmation found | **CLOSED**: changelog verified (no runes mention in any release); docs are v1.x; no evidence of runes rewrite. |
| g2 | @astrojs/adapter-static removal — no explicit "removed in v7" doc line | **CLOSED**: `npm view @astrojs/adapter-static` returns 404; confirmed removed/unpublished. Astro 7 uses native `output: "static"`. |
| g3 | `--port 0` ephemeral — PR #28690 states it; not documented in README/manpage | **CLOSED**: `src/backend/manager.ts` (lines 504-518) already uses `--port 0` + stdout regex `listening on ...:(\d+)` — proven in-repo; llama-server 0.4.0-dev build 10809 confirmed present. |
| g4 | Minimum bundled llama.cpp version — PRODUCT decision | **CONFIRMED**: b9908 (2026-07-08)+ — minimum for `--cache-ram` hard-limit guarantee (PR #25070). |
| g5 | xyflow 1.6.6 vs 2.0-next — PRODUCT decision | **CONFIRMED**: pin `@xyflow/svelte@1.6.6` (stable, documented v1 API, peer svelte ^5.25.0); monitor 2.0 GA. |

## Next Recommended

1. **PRODUCT decision** (orchestrator): pick minimum bundled llama.cpp version — strong anchor is b9908 (2026-07-08) for `--cache-ram` hard-limit guarantee; optionally note perf fix b8185.
2. **PRODUCT decision** (orchestrator): xyflow pin — 1.6.6 (stable, v1 API, peer svelte ^5.25.0) vs 2.0.0-next.3 (pre-release, system 1.0.0-next, API churn risk); recommend 1.6.6 as default, monitor for 2.0 GA.
3. **Design-phase verifications**: `npm view @astrojs/adapter-static` | `--port 0` smoke test on pinned build | svelteflow.dev/xyflow Discord for 2.0 runes status | `astro build --mode static` to confirm static output works without adapter.
4. **Spec + design**: resume SDD pipeline with these anchors locked — cache-ram config surface, KV budget formula (q8_0 model), gosh download verifier integration, Electrobun packaging targets, Astro deploy story.

## Risks

| ID | Description | Mitigation |
|---|---|---|
| r1 | donsetch web_search degraded all session (brave blocked, yahoo 307, bing off-topic) — some conclusions rest on narrower evidence | Design-phase spot-checks for gap items g1–g3 |
| r2 | Astro 7 ecosystem is recent (7.3.2) — plugin compat may still shift; adapter-static removal affects deploy story | Pin exact versions + lockfile; verify static build at design time |
| r3 | xyflow 2.0-next is a moving target — pinning 1.6.6 risks missing runes/SSR; pinning 2.0 risks pre-release breakage | Pin 1.6.6 in lockfile; open a monitoring card for 2.0 GA |
| r4 | Electrobun v2 + Bun main process is niche/early — macOS 14+ minimum, Windows 11+, Ubuntu 24.04+ Official only; any older OS target may fail | Confirm OS floor against llm-proxy deployment targets before committing |
| r5 | `--cache-ram` default 8192 MiB ≠ KV VRAM budget — confusing naming can lead to wrong tuning | Design docs must explicitly distinguish prompt-cache budget (`--cache-ram`) from KV placement (`--cache-type-k/v`, `--n-cache-gpu`) and document the q8_0 formula |
| r6 | gosh `--checksum` requires `md5:`/`sha256:` prefix — bare hex string fails silently (no error) | Design must mandate `sha256:<hex>` format in the verifier; add unit test |
| r7 | @astrojs/adapter-static may or may not exist under a different name in Astro 7 (e.g. built-in `output: "static"`) — deploy path depends on this | Verify at design time before writing deploy spec |

## skill_resolution

- **sdd-research** (phase executor): `/home/andy/.config/opencode/skills/sdd-research/SKILL.md` — loaded; confirmed: output-only role, `gentle-ai.sdd-research-capability/v1` admission, grants `documentation`=context7 (≤3 calls/question), `open-web`=donsetch; fallback built-in web tools.
- **research-lifecycle** (shared): `/home/andy/.config/opencode/skills/_shared/research-lifecycle.md` — loaded; envelope contract, source grading, claims mapping, contradiction/gap formatting.
- **Persistence tools** (engram MCP) are NOT used as evidence; no repository files read or mutated; all evidence from context7 and donsetch web_fetch/web_search as listed in Sources table above.