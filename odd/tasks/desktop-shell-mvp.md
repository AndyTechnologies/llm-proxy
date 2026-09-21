# Desktop Shell MVP (Electrobun wiring)

- Feature: `desktop-shell-mvp`
- Branch: `sdd/weavellm` (work continues on PR #30)
- Created: 2026-09-20
- Mode: ODD, delegated direct

## Objective

Make `bun run start` run the FINAL desktop binary users will install (an
Electrobun webview window), and keep `bun run dev` as the local development
workflow (backend watch + Astro dev server with proxy, browser-based). Wiring
per `openspec/specs/desktop-app-shell/spec.md`: "Bun main process starts and
opens the webview window" (Requirement: Electrobun main process on Bun).

## Problem / Why

Today `start` = `bun run build:frontend && bun run src/main.ts`: the compiled
Astro SPA is served by the HTTP server and opened in a BROWSER. That is the
web path, not the desktop product. The Electrobun config exists but is stale
(old API), no webview window is ever opened, and the real Hutch toolchain is
not installed.

## Scope (authorized)

- Install/validate the real Hutch CLI (via `bunx electrobun` bootstrap).
- Refresh `electrobun.config.ts` to the current v2 shape (`app.*`,
  `build.bun.entrypoint`, `views`/assets copy for `views://`).
- Main process: open the webview window when running inside the Electrobun
  bundle; keep the HTTP server + API surface working (the SPA talks to
  `/api`, `/v1`, `/ws` — same port 4317 via the proxy or direct fetch).
- `start` → run the desktop bundle (Electrobun run of the built app).
- `dev` → unchanged (current workflow already does local development).
- Keep the `< 100 MB` gate and 3-target release matrix working
  (`build:binaries`), fixing the build invocation to the current API if
  needed after empirical verification.
- Tests + typecheck (`bun run typecheck && bun test`).

## Constraints

- Runtime is Bun ≥ 1.4, strict TS, ESM NodeNext (explicit `.js` imports).
- Native webview (WebKitGTK 4.1 / GTK3 on Linux); `bundleCEF: false`.
- Release builds via Hutch for darwin-arm64/darwin-x64/linux-x64; sizes < 100 MB.
- The local llama-server binary (b9908+) must keep working — boot preflight
  stays.
- No inline eslint disables; conventional commits; no AI attribution lines.

## Tasks

- [x] DSH-1 Install/validate the real Hutch toolchain (bootstrap + `hutch
      electrobun --help`); record exact version and Scratch install location.
      Evidence: `hutch electrobun --help` shows build/run/dev commands.
      → Hutch 0.24.3 at `~/.hutch/bin/hutch`; Cottontail 0.5.0 installed via
      local mirror (CDN stall); devkit `electrobun 2.0.2-beta.27` prepared
      (research pin 2.1.0 does not exist — 404; fixed to real release).
- [x] DSH-2 Refresh `electrobun.config.ts` to the current v2 API; define
      `views://mainview` assets (Astro `frontend/dist` → bundle copy) and the
      Bun entrypoint. Evidence: config typechecks; `hutch` reads it without
      schema errors.
      → v2 config done; bundle copy verified: `frontend/dist` →
      `Resources/app/ui/index.html` (build `build.copy`).
- [x] DSH-3 Main process desktop wiring: open the webview window from the
      bundled main process (Electrobun `BrowserWindow`, `views://` URL or
      local server URL per empirical result); gate so direct
      `bun run src/main.ts` still works without the bundle. Evidence:
      window opens under the bundle; server + `/api/health` still respond.
      → BrowserWindow wiring done; `Bun.serve` runs inside the bundle
      (logs: listening 4317). **BLOCKER found**: `uiDir` resolved to
      `process.cwd()/frontend/dist`, but the launcher chdirs to
      `build/.../WeaveLLM-dev/bin`, so GET / → 404 → black window. **Fixed**:
      `build.copy` ships the SPA into the bundle (`Resources/app/ui`) and
      `resolveUiDir` probes candidates (env override → repo
      `frontend/dist` → bundle `import.meta.dir/../ui`). Verified live:
      GET / → 200, webview fetches `/_astro/*` bundle assets, `/api/health`
      ok, cold start 199ms (budget ok).
- [ ] DSH-4 `start` script: build frontend, build the desktop bundle, run it
      (Electrobun run). `dev` unchanged. Evidence: `bun run start` opens the
      window; `bun run dev` still boots browser dev workflow.
- [ ] DSH-5 Closing checks: `bun run typecheck && bun test` full green;
      update `AGENTS.md` stack commands if scripts change; work-unit commit
      per task on `sdd/weavellm`.

## Verification commands

- `bun run typecheck && bun run lint && bun test`
- `bun run start` (window opens; server logs `listening` on 4317)
- `bun run dev` (backend + Astro dev still work)

## Route declaration

- DSH-1: inline bash (toolchain state check — small, no write to repo).
- DSH-2/3: delegated writer (2+ non-trivial files: config + main process).
- DSH-4/5: delegated writer for script changes + inline checks.