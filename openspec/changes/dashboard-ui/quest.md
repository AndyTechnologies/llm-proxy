# Quest: dashboard-ui

## Approval: approved

## RFC

### Goals / Non-goals

**Goals**
- Dashboard web (`/ui`) to inspect pipelines, models, and executions.
- Visual drag-and-drop pipeline editor that validates the graph and hot-applies changes without restarting.
- A pipeline engine that executes both **linear chains** and **complex graphs** (conditionals and multiple branches), reusing the linear engine when the graph is compatible and using a graph engine otherwise.
- **Pipeline composition**: a pipeline can invoke another pre-defined pipeline.
- **Atomic** configuration save (never a partially written file).
- Condition evaluation via a **safe AST interpreter** (forbid `eval` / `new Function`).

**Non-goals**
- Re-introduce Express / Express-style route mounting.
- Change `defaultChain` routing (remains reporting-only).
- Automatically register disk models without operator action.

### Domain Terminology & Business Rules

- **Pipeline**: an executable chain; modeled in the editor as a **graph** (nodes/edges).
- **Node types**: `start`, `end`, `llm_call`, `condition` (if-else), `loop`.
- **Hybrid execution**: if the graph is serializable to / compatible with the linear chain (`ParsedChain`), it executes on the existing linear engine. A graph with conditionals and multiple branches executes on the **graph engine**.
- **Branching**: by default **sequential-guarded** (a single branch chosen by the condition, propagating `lastResponse`/`variables`). Explicitly marked subgraphs may run in **parallel** and recombine at an explicit **join** (parallel opt-in).
- **Composition**: a node may invoke another pipeline (its final output becomes the invoker's `lastResponse`) with a **max depth** (e.g. 5); exceeding it fails with a clear error. Supports **input parameters/variables** to the invoked pipeline.
- **AST expressions**: `compare`, `logical` (AND/OR), `not`, `exists`. Minimal context: `lastResponse.status`, `lastResponse.content`, `error`, `variables`.
- **Streaming**: intermediate steps run non-streaming to the client and emit progress events (`step:*`); **only the last step** of the executed path streams (single terminal chunk).
- **YAML round-trip**: the whole config is re-serialized atomically on save; comments/format are lost (accepted).
- **Manual retry**: only failed `llm_call` steps of a failed execution, max 1 retry per step, non-streaming, result stored.
- **Disk models**: scanned `.gguf` are editor candidates; the operator can add detected ones to `config.llama.models` via apply.

### Contracts (Inputs / Outputs / Events / External)

**API `/api/ui/*`** (REST + SSE):
- `GET /api/ui/pipelines` → list with `{id, description, nodeCount, lastExecution}`.
- `GET /api/ui/models` → `{models:[{id,file,loaded}], modelsDir, autoRefresh}`.
- `GET /api/ui/executions?limit=N` → `[{id, pipelineId, status, totalLatencyMs}]` (bounded in-memory history).
- `POST /api/ui/pipelines/:id/validate` → `{steps:[...]}` or `{nodes:[...],edges:[...]}` → `{valid:true}` or `{valid:false,errors:[...]}`.
- `POST /api/ui/apply` → `{config:{...}}` → `{status:"applied", reloadedChains:[...]}` or `400 {error:{message,type,param,code}}`.
- `POST /api/ui/executions/:executionId/steps/:nodeId/retry` → `{success:true, retryExecutionId}` or error.
- `GET /api/ui/events` (SSE): `execution:started`, `step:started`, `step:completed`, `step:failed`, `execution:completed`, `pipeline:reloaded`, `models:changed`. Format `event:<name>\ndata:<json>\n\n`.

**Frontend `/ui`** (static SPA): ARIA + keyboard navigation + WCAG AA contrast.

### Invariants & Validation

- **Atomic write**: write to temp + rename; config always complete/absent, never corrupted.
- **Atomic registry reload**: compile/validate all; swap reference only if all succeed; a failed reload keeps the previous registry.
- **Graph validation**: acyclic (except within `loop` boundaries), valid references, model existence, exactly one `start` and ≥1 `end`, required fields per node type; bounded composition depth.
- **No code evaluation**: conditions only via AST; forbid `eval`/`new Function`.
- **Single terminal stream** on the executed path; never buffer `/v1/*` streams.

### Failure Cases & Edge Cases

- Invalid config on apply → `400` with normalized envelope; nothing written.
- Failed reload → previous config retained.
- Composition depth exceeded → clear error; no infinite cycles.
- Slow/disconnected SSE client → bounded buffer + eviction (backpressure).
- Disconnected streaming execution → retry runs non-streaming and is stored.
- No `BEARER_TOKEN` → dashboard open; with `BEARER_TOKEN` → `/api/ui/*` + SSE protected.
- `autoStart:false` → dashboard works even when the backend is not managed.

### Security / Privacy / Performance / Operational

- **Security**: AST interpreter (no `eval`); minimal context (no URLs, no file/network access); writes validated against schema before persisting; `/v1/*` streams never buffered/transformed.
- **Performance**: vanilla frontend + native SVG (no D3/sigma/xyflow); bounded SSE buffer; bounded in-memory history; parallel opt-in only on marked subgraphs.
- **Operational**: SPA served as static assets; no client build step; single compilable server output.

### Alternatives & Trade-offs

- **Hybrid engine (chosen)** vs. linear-only: hybrid covers complex graphs + composition at the cost of a bigger engine; linear-only is simpler but cannot run complex pipelines.
- **Sequential-guarded + parallel opt-in (chosen)** vs. full fork/join: hybrid is deterministic by default; full fork/join has costlier concurrency semantics.
- **Composition with max depth (chosen)** vs. forward-only: the former allows bounded recursion/reuse; the latter is more restrictive.
- **Vanilla frontend (chosen)** vs. framework: light and build-free, but more manual code.
- **Full atomic round-trip (chosen)** vs. preserving comments: the former is robust; the latter is fragile.

### Acceptance Criteria (measurable)

- `bun run typecheck && bun run lint && bun test` green.
- `/api/ui/*` errors return `{error:{message,type,param,code}}`.
- On apply, YAML persists atomically and the registry reloads without restart.
- A complex pipeline (conditionals + branches) runs on the graph engine; a linear pipeline runs on the linear engine.
- Pipeline composition respects max depth, propagates input params and `lastResponse`.
- `/v1/*` streaming invariants preserved (single terminal chunk, no buffering).
- The editor validates a graph; unsafe AST input is rejected (no `eval`).
- `/api/ui/models` lists registered and detected models; adding a detected `.gguf` to `config.llama.models` is possible via apply.

### Unresolved Questions (blocking)
- None. (Stack confirmed by the project: Bun.serve + TypeScript.)
