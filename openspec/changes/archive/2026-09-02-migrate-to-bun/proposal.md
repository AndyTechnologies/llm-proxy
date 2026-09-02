# Proposal: Migrate llm-proxy to Bun.js v1.4.0

## Intent

Complete Node.js → Bun.js v1.4.0 migration: runtime, package manager, bundler, test runner all-on-Bun; compiled binary as delivery artifact; hardening (graceful shutdown, health, JSON logs). Behavior-preserving: SSE invariants, manager debt fixes, zod, OpenAI-compatible surface.

## Scope

### In Scope
- **P0**: `bun install` + `bun.lock` replace pnpm; `bun test` bootstrap; drop dotenv/js-yaml/tsx/@types/node; native config load `Bun.YAML.parse(await Bun.file(path).text())` (`Bun.file().yaml()` does not exist); Express 5 runs on Bun.
- **S1**: manager → `Bun.spawn` (stdout "listening on" detection; onExit restarts); debt fixes preserved (port-collision fail-fast, restart cap, backoff, configurable timeouts); `Bun.which()`; `Bun.file().write()`.
- **S2**: routes → `Bun.serve` (models/health first; chat/completions SSE last); SSE MUST set `idleTimeout: 0` or `server.timeout(req,0)` (10s default kills silent streams); engine `res.write` → `ReadableStream.enqueue` preserving one-terminal-chunk + `[DONE]` + abort; proxy → `Response(res.body)` with hop-by-hop + 503/502 preserved; helmet → manual headers; zod error mapping preserved.
- **S3**: `bun build --compile` binary; ~~Docker multi-arch~~ REMOVED (2026-09-02: maintainer decision, GitHub Actions later); `/health/live` + `/health/ready`; JSON logs; shutdown drain (`server.stop()`).

### Out of Scope
- New features beyond hardening; llama-server + GGUF + `.llm-proxy/` stay external; zod schema untouched; no CI.

## Capabilities

### New Capabilities
- `config-load`: native Bun YAML loading, CONFIG_FILE honored, zod validation, .env precedence.
- `health-endpoints`: /health/live + /health/ready (readiness gated on manager state), JSON logs, shutdown drain.

### Modified Capabilities
- `gateway-api`: Bun.serve-hosted routes; NEW requirement SSE MUST use idleTimeout 0; preserved: single `[DONE]`, client-abort, normalized OpenAI errors.
- backend-management, proxy-pipeline, gateway-security, pipeline-orchestration, virtual-model-routing: implementation-only — no deltas.

## Approach

Approach 1 (runtime-swap first), verified per slice:

| Slice | Work | Verify |
|-------|------|--------|
| P0 | install/lock, test bootstrap, deps removal, native config, Express intact | parity vs archived smoke matrix; `tsc --noEmit`; `bun test` |
| S1 | manager → Bun.spawn | `bun:test` backend/manager (mock.module("bun")); supervision smoke |
| S2 | routes → Bun.serve; SSE last | `bun:test` routes/stream, orchestrator/engine, middleware/errors; >10s silent-stream probe |
| S3 | binary, Docker, health, JSON logs | smoke vs external llama-server/GGUF; SIGTERM drain |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/config/*`, `src/backend/*` | Modified | Bun.YAML.parse; Bun.spawn; Bun.which(); Bun.file().write() |
| `src/server.ts`, `middleware/*`, `routes/*` | Modified | Express → Bun.serve; SSE idleTimeout 0 |
| `src/orchestrator/engine.ts`, `src/middleware/proxy.ts` | Modified | write → enqueue; pipe → Response(res.body) |
| `src/index.ts` | Modified | drain; health endpoints; JSON logs |
| `package.json`, `bun.lock` | New | pnpm → bun |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| SSE regression (single [DONE], abort) | High | route tests w/ Bun.serve fixture; SSE last |
| Manager regression | High | mock.module("bun") tests first |
| Express-on-Bun gaps | Med | P0 parity gate; fallback direct Phase B |
| pnpm→bun lockfile | Med | Handoff-confirmed; git revert restores pnpm-lock |
| Slow non-SSE routes | Low | explicit per-route timeouts |

## Rollback Plan

- P0/S1: revert to Node baseline commit; restore pnpm-lock.yaml; Express keeps serving.
- S2: Express stays until Phase B lands; per-slice commits revertible; failing slice does NOT advance.
- S3: additive; source fallback `bun run src/index.ts`; images tagged by git SHA.

## Dependencies

- Bun v1.4.0 (on PATH); external llama-server + GGUF + presets for smoke parity.

## Success Criteria

- [ ] `bun test` green: config/load, backend/validation, backend/preset, backend/manager, orchestrator/engine, middleware/errors, routes/stream
- [ ] `tsc --noEmit` exit 0
- [ ] P0 parity: archived smoke matrix on Bun (boot order, single [DONE], 404/400 shapes, supervision restart, fail-fast)
- [ ] SSE probe: silent >10s survives; [DONE] exactly once; abort releases slot
- [ ] Binary boots vs external llama-server/GGUF; /health/live + /health/ready respond; SIGTERM drains; no orphans