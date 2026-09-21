# Portable single-file binary (weavellm)

**Status:** In progress
**Branch:** sdd/weavellm
**Feature identity:** portable-single-binary

## Objective

`bun run build:binary` MUST produce a single self-contained executable `dist/weavellm`
that packages the COMPLETE application (Electrobun shell + Bun main process + SPA UI)
and opens the Electrobun interface when run — NOT an installer, NOT an auto-updater,
NOT a Cottontail/Hutch setup bundle.

## Problem / Why

The original desktop-app-shell spec said "single-binary" but the release pipeline was
wired to the Hutch `--env=stable` channel, which produces Cottontail **setup/update**
artifacts (`linux-x64-WeaveLLM-Setup.tar.gz`, `stable-linux-x64-update.json`,
`stable-linux-x64-WeaveLLM.tar.zst`) — an installer/self-update mechanism, exactly what
the user does not want. Additionally:

- `build:binary` today: `bun build src/main.ts --compile --outfile dist/weavellm`
  compiles ONLY the backend server main process — no UI, no webview. Not the app.
- `build:binaries` today: `scripts/build-binaries.ts` runs
  `hutch electrobun build --env=stable`, which produces Cottontail install/update
  artifacts under `artifacts/`; the stable bundle does not even contain the flat
  `Resources/app` UI (its resources are packed in an update payload tar.zst).

User requirement (explicit): "el binario resultante debe ser autocontenido … que
`bun run build:binary` empaquete la aplicación completa, y que NO sea un instalador,
sino una aplicación binaria que descargas y simplemente al hacer `weavellm` abra la
interfaz Electrobun." User chose the **single-file executable** format (AppImage-style
self-extracting) over a portable tarball folder.

## Decision (user-selected): single-file self-extracting executable

Format: one ELF `dist/weavellm` (AppImage-style):

1. Build the Electrobun **dev** bundle (the flat self-contained runnable bundle —
   `build/<target>/WeaveLLM-dev/` — whose launcher resolves `Resources` relative to its
   own `bin/` dir, runs without Hutch, and includes the SPA in `Resources/app/ui`).
   The dev bundle is the correct payload; the hutch `stable` channel is Cottontail
   install/update machinery and is NOT used for this artifact.
2. Compress the bundle dir (tar.gz, measured ~44.4 MB for the current dev bundle).
3. Compile a tiny native **C stub** (`ccc` available on host) that:
   - reads the payload appended to its own ELF (or embedded in the binary),
   - on first run, extracts the bundle to `$XDG_CACHE_HOME/weavellm/<payload-hash>/`
     (or `~/.cache/weavellm/<payload-hash>/`),
   - sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` by default (explicit env override wins),
   - execs `<extracted>/bin/launcher` (the flat launcher runs standalone).
4. Appending the 44 MB payload to a ~30 KB C stub keeps the single file **well under
   the 100 MB gate** (spec AC #1). A Bun-compiled stub (`bun build --compile` = 77.6 MB
   minimum) would exceed the gate once the payload is added — rejected with evidence.
5. Result: ONE downloadable file; user runs `weavellm` (or `./weavellm`) and the
   Electrobun UI opens. No installer, no system integration, no auto-update.

## Scope

- `package.json`: `build:binary` -> `bun run scripts/build-binary.ts`
- New `scripts/build-binary.ts`: orchestrates the pipeline (frontend build? stable? ->
  hutch dev build -> tar.gz -> append payload -> compile stub -> size gate).
- New `scripts/selfextract.c` (or `.zig`/`.rs`): the stub.
- `scripts/build-binaries.ts`: keep the matrix/size-gate script for the release matrix,
  but `build:binary` becomes the single-file portable artifact path. Verify what
  `build:binaries` should still do (it currently targets Cottontail setup artifacts).
- Spec sync: `openspec/specs/desktop-app-shell/spec.md` — rework the "self-updates via
  Hutch" requirement into "portable self-contained single-file binary, no installer",
  keep the <100 MB gate, host-only matrix note.

## Constraints

- Keep strict typecheck/lint/tests green (`bun run typecheck && bun run lint && bun test`).
- No inline eslint disables.
- Conventional commits.
- The dev bundle already in `build/dev-linux-x64/WeaveLLM-dev/` is a valid payload source
  (109 MB raw / 44 MB tar.gz) and is known to run standalone (verified launcher path
  resolution: `Resources` relative to `dirname(argv0)`).
- Exact run matrix remains host-only (Electrobun v2 has no cross-compile).

## Acceptance criteria

1. `bun run build:binary` produces `dist/weavellm` as a single ELF.
2. The file contains the complete app: running it opens the Electrobun window with the
   SPA (verified by launching on this host).
3. No installer artifacts are produced by `build:binary` (no `-Setup`, `-update.json`,
   `.deb`, AppImage, self-update flow).
4. `dist/weavellm` stays under 100 MB (gate enforced).
5. `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set by default inside the stub on Linux
   (explicit env override still wins).
6. Re-running uses the cached extraction (same payload hash) and does not re-extract.

## Applicable checks

- `bun run typecheck`
- `bun run lint`
- `bun test`
- Manual: `dist/weavellm` launches the Electrobun UI on this host.

## Tasks

- [x] T1: `scripts/build-binary.ts` — pipeline: hutch dev build (or reuse existing
      bundle), tar.gz payload, append payload + metadata to stub, size gate, emit
      `dist/weavellm`. Evidence: `dist/weavellm` 44,440,965 bytes (42.4 MB) < 100 MB gate.
- [x] T2: `scripts/selfextract.c` — ELF stub: locate embedded payload, extract to
      `$XDG_CACHE_HOME/weavellm/<sha256>`, set render env, exec `bin/launcher`.
      Evidence: compiles clean `-Wall -Wextra`; fake-launcher smoke: extract + marker
      skip + DMABUF default [1] with explicit override [0] + exit-code propagation.
- [x] T3: Wire `package.json` `build:binary`; reconcile `build:binaries` scope/gate
      (doc comment only: Cottontail installer flow, not the portable path).
- [x] T4: Spec sync `desktop-app-shell` — portable single-file, no installer/updater
      (commit 78d38e3: replaces only the auto-update requirement, 23+/16−).
- [x] T5: Tests for any pure helpers (payload layout, hash key, env merge) + verify.
      16 tests in scripts/selfextract-layout.test.ts; typecheck/lint green; 462 tests pass.

## Commits

- a72ee22 feat(build): portable single-file self-extract mechanism (layout + tests + C stub)
- dfc71fc feat(build): assemble dist/weavellm via build:binary pipeline
- 78d38e3 docs(spec): replace auto-update with portable single-file contract

## Verification of record

- Writer: all commands green + payload proof (trailer parsed, sliced payload tar lists
  bin/launcher + Resources/app/ui/index.html), stub smoke via fake launcher (no GUI).
- Parent spot check: typecheck/lint green; bun test 462 pass / 42 files.
- Independent verifier (read-only, adversarial): PASS on all 9 claims; two notes —
  path wording `build/dev-linux-x64/WeaveLLM-dev` (dev- env prefix), and a rare
  extract-failure-while-peer-waits corner (extract_bundle never re-mkdirs). No claim
  failures.
- RDD: off (global) — assessment unassessable due to pre-existing untracked state;
  treated as high tier, independent verifier ran.
- ✅ REAL GUI LAUNCH (2026-09-20, reported): `dist/weavellm` run live — stub extracted
  real payload to ~/.cache/weavellm/72380d67…, launcher exec'd, GTK event loop started,
  server listening 4317, SPA assets (index, _astro CSS, WorkflowEditor/ModelBadge js)
  served 200, clean stopEventLoop exit. Cold start 3572 ms on FIRST run (includes
  44 MB extraction); cached runs expected well under budget.
- ✅ CACHED RUN CONFIRMED BY USER (2026-09-20): second `dist/weavellm` launch was
  noticeably faster — extraction skipped via `.complete` marker, cold-start budget
  back under target. Acceptance criterion cache-reuse closed.
- Remaining: real GUI launch of dist/weavellm not yet done (verification used a fake
  launcher to avoid opening the window); dynamic glibc + tar/rm dependency OK for
  Ubuntu 24.04+ targets.