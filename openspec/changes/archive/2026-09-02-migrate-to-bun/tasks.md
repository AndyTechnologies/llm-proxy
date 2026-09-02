# Tasks: Migrate llm-proxy to Bun.js v1.4.0

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1900–2300 (P0 350 · S1 500 · S2a 450 · S2b 450 · S3 300) |
| 800-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR P0 → PR S1 → PR S2a → PR S2b → PR S3 |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

**Build gate (retro):** `bun build src/index.ts --target=bun --outdir dist` must exit 0 in every slice. Fix `--target=bun` landed in S3; S1/S2 gates didn't run build. All future slice gates include build.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| P0 | install/lock, deps, native config, Express-on-Bun parity | PR 1 | `bun test config/load`; `tsc --noEmit` | `bun run src/index.ts` vs archived smoke matrix | revert package.json/bun.lock/src/config |
| S1 | manager→Bun.spawn, validation, preset | PR 2 | `bun test backend/manager` | supervision smoke against real llama-server | revert backend/* |
| S2a | middleware/engine/server + models route (non-SSE) | PR 3 | `bun test middleware/errors`; `bun test orchestrator/engine` | live models/health on Bun.serve | revert middleware/*, server.ts, models.ts |
| S2b | SSE chat/completions + stream tests + open question | PR 4 | `bun test routes/stream`; `>10s` probe | live chat/completions SSE vs llama-server | revert chat.ts/completions.ts, engine stream path |
| S3 | binary, ~~Docker~~ health, JSON logs, drain | PR 5 | `bun test health`; e2e | SIGTERM drain + /health/live/ready | additive; revert index |

## Phase P0 — Runtime Swap / Foundation

- [x] P0.1 `bun install`; add `bun.lock`, delete `pnpm-lock.yaml`; remove dotenv/js-yaml/tsx/@types/node/@types/js-yaml from package.json
- [x] P0.2 Update scripts: `build: bun build src/index.ts --outdir dist`, keep `typecheck: tsc --noEmit`, `lint: eslint .`
- [x] P0.3 RED `src/config/load.test.ts`: `mock.module("bun")`; YAML/yml/json parse, non-object fail, missing-file fail (error strings: "Config file is not an object" / "Config file not found") — CORRECTION: runtime fact (Bun 1.4.0) — `mock.module("bun")` cannot intercept the builtin bun module (verified in-file + preload); tests inject fake LoaderDeps (file/yamlParse) per ADR-3 DI instead. See apply-progress.
- [x] P0.4 GREEN `src/config/load.ts` → `Bun.YAML.parse(await Bun.file(p).text())`; drop dotenv/config; keep zod + JSON + .env precedence
- [x] P0.5 REFACTOR: extract shared error constants; verify `tsc --noEmit` exit 0
- [x] P0.6 P0 parity gate: run Express-on-Bun baseline against archived rewrite-to-gateway smoke matrix (boot order, single [DONE], 404/400 shapes, 401); must pass before S1

## Phase S1 — Manager → Bun.spawn

- [x] S1.1 RED `src/backend/manager.test.ts`: DI stubs (spawnFn/now/sleep) per ADR-3 — CORRECTION: `mock.module("bun")` cannot intercept the builtin bun module (verified during P0.3); 13 tests contract `exited` Promise (NEVER onExit), decode Uint8Array streams before "listening on" regex
- [x] S1.2 GREEN `src/backend/manager.ts`: `Bun.spawn` (DI spawnFn), supervision via `exited`; sync-throw catch on posix_spawn; port-collision fail-fast, restart cap, backoff, stderr bound (4KB tail + flush-before-diagnostics), timeouts byte-for-byte; dynamic-port detection reads BOTH streams (llama.cpp logs the URL-form "listening on http://…" banner to stderr — found by S1.6 smoke, regression-tested)
- [x] S1.3 RED `src/backend/validation.test.ts`: missing/not-on-PATH/absolute-not-found → error (Bun.which seam `whichFn`)
- [x] S1.4 GREEN `src/backend/validation.ts`: `execFileSync("which")` → `Bun.which()` fail-fast; seam injectable (Bun.which ignores live process.env.PATH mutations — reads startup snapshot)
- [x] S1.5 RED `src/backend/preset.test.ts` + GREEN `preset.ts`: `fs.writeFileSync` → async `Bun.file().write()`; render unchanged; manager `start()` awaits the write
- [x] S1.6 Supervision smoke vs real llama-server (CPU-forced, 3B Q4, dynamic port): port 0 parsed from stderr URL banner → running → /health 200 → clean SIGTERM stop, no orphans; `tsc --noEmit` + `bun test` (39) + `eslint .` all green

## Phase S2 — Routes → Bun.serve (SSE last)

- [x] S2.1 RED `src/middleware/errors.test.ts` + GREEN middleware: plain fns; zod→400 OpenAI envelope; manual headers replace helmet; hop-by-hop + 503/502 preserved in proxy
- [x] S2.2 RED `src/orchestrator/engine.test.ts` + GREEN `engine.ts`: `res.write` → `ReadableStream.enqueue`; single [DONE], one terminal chunk (finish_reason stop), abort→cancel
- [x] S2.3 GREEN `src/server.ts`: `createApp` → Bun.serve fetch handler; preserve `GET /health` aggregate (backend state, pid, models, chains)
- [x] S2.4 GREEN `routes/models.ts` + `chat.ts`/`completions.ts`: Fetch handlers; SSE ReadableStream; `server.timeout(req,0)` on stream routes only
- [x] S2.5 RED `src/routes/stream.test.ts`: Bun.serve fixture — `>10s` silent probe survives; client abort releases slot; exact-one [DONE]
- [x] S2.6 Bounded open question: integration test confirms `server.timeout(req,0)` covers passthrough SSE (`new Response(upstream.body)`); record verdict in spec
- [x] S2.7 Full `bun test` + `tsc --noEmit`; SSE parity smoke (single [DONE], abort) vs external llama-server

## Phase S3 — Binary / Docker / Ops

- [x] S3.1 RED `src/index.test.ts`/route `health.test.ts`: /health/live 200; /health/ready 200 iff state==="running" else 503+state; legacy /health preserved
- [x] S3.2 GREEN `src/index.ts` + `routes/health.ts`: JSON logs (level+message); /health/live + /health/ready; SIGINT/SIGTERM drain via `server.stop(timeout)` bounded force-close; stop backend, exit 0, no orphans
- [x] S3.3 ~~Add `Dockerfile`~~ → REMOVED (mantainer decision 2026-09-02; GitHub Actions later). Dockerfile + .dockerignore deleted; `build:binary` (`bun --compile`) is the local cross-compilation path.
- [x] S3.4 `bun build --compile` binary; binary boots vs external llama-server/GGUF
- [x] S3.5 E2E: SIGTERM drain (in-flight + hung connection force-closed), no orphan; `bun test` + `tsc --noEmit` + `lint` green
