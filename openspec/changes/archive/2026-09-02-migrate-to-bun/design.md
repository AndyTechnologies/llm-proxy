# Design: Migrate llm-proxy to Bun.js v1.4.0

## Technical Approach

Runtime-swap-first (Approach 1), phased P0→S3, behavior-preserving: SSE invariants, manager supervision, zod, OpenAI envelope. **Critical correction vs exploration #66:** Bun.spawn `Subprocess` has NO `onExit`. Exit supervision uses the `exited` Promise; signal exit resolves 128+signal. stdout/stderr are `Uint8Array`. Tests use `exited` only.

## Architecture Decisions

| # | Decision | Alternatives | Rationale |
|---|----------|--------------|-----------|
| ADR-1 | Runtime-swap slice boundary | Big-bang; HTTP-first | Each slice verifiable; Express is safety net during S1; SSE last isolates streaming risk. |
| ADR-2 | idleTimeout per-request | global `idleTimeout:0`; default | `server.timeout(req,0)` on SSE routes only: streams survive, non-stream chat/models keep 10s. Closes gateway-api Medium risk. |
| ADR-3 | DI for mocking | static import; spyOn | `spawnFn`/`now`/`sleep` deps; `mock.module("bun")` intercepts export; fakes streams, codes, signals. |
| ADR-4 | pnpm→bun lockfile | keep pnpm | Confirmed. `bun.lock` replaces `pnpm-lock.yaml`; git revert restores baseline. |
| ADR-5 | YAML API | `Bun.file().yaml()`; static import | Doesn't exist; static import can't honor CONFIG_FILE. `Bun.YAML.parse(await Bun.file(p).text())`; JSON via `JSON.parse`. |
| ADR-6 | Dev distribution | binary only | Dev: `bun run src/index.ts`; `--compile` is S3. `--compile-autoload-dotenv` default true keeps .env in binary. |

## Data Flow

**SSE streaming (S2 chain path):**

    POST /v1/chat/completions{stream:true} → Bun.serve.fetch
      auth → zod → chain resolve → runChain → runStepStream
      ReadableStream start: enqueue `data: {...}\n\n` per token
         no finish_reason seen → enqueue synthesized stop chunk (once)
         enqueue `data: [DONE]\n\n`; cancel (req.signal) → abort upstream
      new Response(stream, SSE headers); server.timeout(req,0)

**Manager restart-with-backoff (S1):**

    start → validate → writePresetIni → spawnFn
      stdout decode + "listening on" regex → detectPort
      health-poll + childDead re-check → state=running
      await child.exited  (replaces onExit)
        [intentionallyStopped return] [starting → waitForReady]
        state=error; cap exceeded → stop+dump lastStderr
        scheduleRestart(backoffMs; *=2 capped)

## File Changes

| File | Action | Notes |
|------|--------|-------|
| `package.json`, `bun.lock` | Mod/New | drop dotenv/js-yaml/tsx/@types/node; zod/eslint/ts stay |
| `src/config/load.ts`, `index.ts` | Mod | `Bun.YAML.parse(await Bun.file(p).text())`; drop `dotenv/config`; JSON path & zod unchanged; same error strings |
| `src/backend/manager.ts` | Mod | `child_process.spawn`→`Bun.spawn` (DI `spawnFn`); exit via `exited`; Uint8Array decode; keep port/backoff/cap/stderr/timeouts byte-for-byte |
| `src/backend/validation.ts` | Mod | `execFileSync("which")`→`Bun.which()` |
| `src/backend/preset.ts` | Mod | `fs.writeFileSync`→`Bun.file().write()`; pure render unchanged |
| `src/server.ts`, `middleware/*` | Mod | `createApp`→fetch handler; middleware plain fns; zod→400 OpenAI envelope; manual headers replace helmet |
| `src/middleware/proxy.ts` | Mod | pipe→`new Response(upstream.body)`; HOP_BY_HOP + 503/502 preserved |
| `src/routes/chat.ts`, `completions.ts` | Mod | Fetch handlers; SSE `ReadableStream`; abort via `req.signal` |
| `src/orchestrator/engine.ts` | Mod | `res.write`→`enqueue`; single terminal chunk + `[DONE]`; abort→cancel |
| `src/index.ts`, `routes/health.ts` | Mod | `Bun.serve`; JSON logs; `/health/live`; `/health/ready` 200 iff `running` else 503+state; drain |
| ~~`Dockerfile`~~ | REMOVED | REMOVED (maintainer decision 2026-09-02): Docker eliminated entirely; cross-compile deferred to GitHub Actions. `build:binary` (`bun --compile`) is the local compilation path. |
| `src/utils/ids.ts`, `providers/llama-server.ts` | None | `node:crypto`/fetch fine on Bun compat |

## Interfaces

```ts
interface ManagerDeps { config: LlamaConfig; logger?: (m: string) => void;
  spawnFn?: typeof spawn; now?: () => number; sleep?: (ms: number) => Promise<void>; }
interface SpawnedProc { pid: number|null; exitCode: number|null; signalCode: string|null;
  stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>; kill(signal?: string): void; }
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | config/load (.yaml/.yml/.json, non-object, missing) | `mock.module("bun")`; assert error strings |
| Unit | manager restart/backoff/cap/port-collision | Fake `exited` code/signal; assert state, stderr bound |
| Unit | engine single-[DONE]/terminal-chunk/abort | Collect stream chunks; assert sequence |
| Integration | routes/stream Bun.serve fixture | >10s silent probe; `server.timeout(req,0)`; abort releases slot |
| E2E | binary + health/drain | `bun run` + `--compile` vs llama-server; SIGTERM drain, no orphans |
| Smoke | parity | Archived matrix: boot order, 404/400 shape, restart, fail-fast |

Gates: `tsc --noEmit` (bun build skips typecheck) + `bun test`.

## Threat Matrix

Subprocess + `Bun.which` → process-integration boundary. No doc/git/PR.

| Boundary | Design response | RED tests |
|---|---|---|
| Executable resolution | `Bun.which` PATH + absolute exists-check; fail-fast | missing/not-on-PATH/absolute-not-found → error |
| Spawn args | Args array (no shell); env whitelist + CUDA | `spawnFn` exact argv; no shell join |
| Exit supervision | `exited`/`signalCode`; non-zero restartable; cap | exit 3→restart; SIGTERM after stop→no restart; cap→state error |
| Port-collision childDead | Re-check after health 200 | alive→ready; dead-after-200→earlyExitError |

## Migration / Rollout

No data migration. Per-slice commits revertible; failing slice does not advance; S3 additive (source fallback). `.env` (Bun native): `.env < .env.{NODE_ENV} < .env.local`, process env wins.

## Spec Risk Resolution

- **gateway-api idleTimeout** → ADR-2 per-request `server.timeout(req,0)`; 10s kept elsewhere.
- **health-endpoints ready 503** → `/health/ready` 200 iff `state==="running"` else 503+state.
- **config-load JSON parity** → `.json` via `JSON.parse` unchanged.
- **onExit correction** → manager built on `exited`; RED tests assert this.

## Open Questions

- [x] Confirm `server.timeout(req,0)` also covers passthrough SSE (`new Response(upstream.body)`).
  **VERDICT (S2b, runtime-verified)**: YES. In a Bun.serve fetch handler the 2nd argument is the `Server`; `server.timeout(req, 0)` accepts the `Request` (the handler's 1st arg) and disables its idle timeout. It is applied at the stream-route dispatcher (server.ts) per-request BEFORE invoking the chain or passthrough handler, so it covers both `buildStreamBody` chains and the passthrough `new Response(upstream.body)`. Confirmed by the >10s live smoke (stream survived) and by unit fixture with a 1s idleTimeout + 1.5s silence (survived only with the override; the default 10s idle kills a 16s-silent stream — runtime probe).