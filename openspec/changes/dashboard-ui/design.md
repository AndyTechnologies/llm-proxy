# Design: Dashboard UI + Visual Pipeline Editor

## Technical Approach

Extend the Bun.serve fetch dispatcher (per exploration Option 1) with `/api/ui/*`
REST+SSE branches and serve the SPA at `/ui`. Replace the frozen `parseChains`
`Map` with a mutable, `Map<string, ParsedChain>`-compatible registry that reloads
atomically. Add a typed graph model + SAFE AST interpreter + graph engine, with an
automatic hybrid boundary that runs linear-compatible graphs on the existing
`runChain` and complex graphs (conditionals + branches) on the graph engine.
Config edits persist atomically (tmp+rename) and reload via a build-then-swap
gate. Bounded execution tracker + metrics + SSE pub/sub feed the dashboard.
Traces the approved RFC and all six specs; no new requirements.

## Architecture Decisions

| Decision | Choice & Rationale |
|---|---|---|
| Hybrid boundary | Linear-compatible (single path, no `condition`/branch/`loop`/composition) → `runChain`; else graph engine (shape auto-select, deterministic). |
| Registry | Mutable `PipelineRegistry` exposing `Map<string, ParsedChain>` + graph entries; additive, backward-compatible (RFC invariant #3). |
| Branching | Sequential-guarded default; parallel only on marked subgraphs, recombined at explicit `join`. |
| AST evaluator | Typed AST walker over discriminated unions; `eval`/`new Function`/URL/file/network forbidden (RFC invariant #5). |
| Streaming | Only last executed-path step streams (single terminal chunk, no buffering); intermediates non-streaming + `step:*` events; reuses `buildStreamBody`. |
| Config write | `Bun.write` tmp + `fs.renameSync`; re-validate before persist; reload swaps only on full success. |
| Frontend | Vanilla HTML/CSS/JS + native SVG + `<dialog>` + EventSource; build-free, WCAG AA. |
| Auth | Reuse `authGuard` on `/api/ui/*` + SSE when `BEARER_TOKEN` set; `/ui` static always open. |

## Data Flow

```
Browser (/ui) ──GET /api/ui/* ──▶ server.ts dispatcher ──▶ dashboard/router.ts
     ▲  │               (authGuard, withSecurity, server.timeout(req,0) for SSE)
     │  └──▶ POST apply ─▶ service.apply(draft)
     │                         ├─ zod-validate (configSchema)
     │                         ├─ Bun.write(tmp)+rename ─▶ YAML on disk
     │                         └─ registry.reload() (build+validate, swap)
     │                                    │  emits pipeline:reloaded → events bus ─▶ SSE clients
     └──── EventSource /api/ui/events ◀── events.ts pub/sub (bounded)
                              execution tracker (N=100) / metrics ◀── graph-engine
```

Execution: `/v1/...` → registry → hybrid selector → `runChain` OR `graph-engine`;
each emits lifecycle events to `execution-tracker`/`metrics` → `events.ts`.

## File Changes

Registry + engine: `src/orchestrator/registry.ts`, `graph.ts`, `graph-engine.ts`, `composition.ts` (Create). Dashboard: `src/dashboard/router.ts`, `service.ts`, `execution-tracker.ts`, `metrics.ts`, `events.ts` (Create). Config: `src/config/watcher.ts`, `defaults.ts`, `write.ts` (Create). SPA: `src/ui/index.html`, `app.js`, `styles.css` (Create). Modify: `src/index.ts` (wire registry/engine/watcher/events/tracker; boot `defaults.ts`), `src/server.ts` (add `/api/ui/*` + `/ui` branches), `src/routes/chat.ts`, `completions.ts`, `models.ts` (read via registry; route complex graphs to graph engine).

## Interfaces / Contracts

```ts
type NodeType = "start" | "end" | "llm_call" | "condition" | "loop" | "join";
type GraphNode = { id: string; type: NodeType; parallel?: boolean
  ; model?: string; provider?: string
  ; condition?: AstExpr; body?: string[]; pipeline?: string; params?: Record<string,string> };
type GraphEdge = { from: string; to: string; guard?: "true" | "false" };
type AstExpr = { op: "exists"; field: CtxField }
  | { op: "not"; child: AstExpr }
  | { op: "logical"; and: true; args: AstExpr[] }        // AND/OR
  | { op: "compare"; field: CtxField; op2: "=="|"!="|"<"|"<="|">"|">="; value: unknown };
type CtxField = "lastResponse.status"|"lastResponse.content"|"error"|string; // variables
type ExecutionStatus = "running"|"completed"|"failed"|"retrying";
type UiError = { error: { message: string; type: string; param: string|null; code: string|null } };
```

`registry` = `{ asMap(): Map<string,ParsedChain>; getGraph(id): GraphPipeline|undefined;
  reload(graphs, chains): Promise<void>; // build+validate all, swap only if all ok
  }`. It holds linear `ParsedChain` (served to `runChain`) and `GraphPipeline`
(served to graph engine); the hybrid selector picks by shape.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Registry reload swap/no-swap; cyclic/no-start graph rejection; AST safe eval + unsafe rejection; composition depth; atomic write (tmp+rename) | `bun test`, pure fns + injected deps |
| Unit | Graph engine seq-guarded, parallel+join, loop bound, single-terminal stream, retry once | Pure, fake providers |
| Unit | Events bounded buffer + eviction; tracker N=100; metrics | Pure |
| Integration | `/api/ui/*` auth boundary, error envelope, apply→reload→SSE `pipeline:reloaded`, `/v1/*` no-buffer invariant | Dispatch tests |
| E2E | `/ui` loads, path-traversal 4xx, editor validates/apply, WCAG keyboard | Manual + fetch smoke |

## Threat Matrix

N/A — no VCS/PR automation boundary. This change is a serving/editor feature: the
five VCS rows (doc-like paths, git repo selection, commit/push/PR state) do not
apply. Adjacent security concerns (path-traversal on `/ui` static, SSRF via
condition context — variables never carry URLs, write-isolation on tmp+rename,
SSE backpressure) are covered by the specs and unit tests above as requirements,
not expanded VCS rows.

## Migration / Rollout

No data migration. Chained PRs: (a) registry+watcher+config write, (b) graph
engine+composition, (c) dashboard API+SSE+tracking, (d) static UI. Registry is
additive and `Map`-compatible, so existing routes stay green per slice; revert of
any slice restores the frozen `parseChains` boot path.

## Open Questions

- None blocking. (`defaultChain` stays reporting-only per RFC; model `.gguf`
  detection is editor-candidate only, registered via apply.)
