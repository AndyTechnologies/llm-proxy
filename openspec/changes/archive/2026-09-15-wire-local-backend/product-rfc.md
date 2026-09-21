# Product RFC: wire-local-backend

## Goals / Non-goals

### Goals

- Connect managed llama-server lifecycle into the runtime boot path so local models are callable via `/v1/*` and the workflow engine.
- Expose model activation/deactivation via REST API consumed by the UI.
- Persist active model state in SQLite so active models survive restart.
- Wire a dedicated optional embedding model for `/v1/embeddings` and `rag_local`/`embeddings` nodes.
- Support lazy re-spawn on idle-stop with configurable idle timeout (default 10 min).
- Fail gracefully per model: missing GGUF/binary → model shown as error in UI; boot never fails for an individual model.

### Non-goals

- No "auto-activate all" mode at boot.
- No WebSocket-based spawn progress events (REST-only for management).
- No auto-activation of models post-download.
- No mandatory embedding model requirement; absence degrades to existing 404 with clear message.

---

## Domain Terminology & Business Rules

### Domain Terms

| Term | Definition |
|---|---|
| **Active model** | Model whose state is `active` in SQLite; llama-server spawned or will spawn on first request. |
| **Idle-stop** | Active model with no requests for N minutes (default 10) gets process stopped, releases RAM; next request re-spawns. |
| **Spawn** | Process creation: `llama-server --port 0` + stdout port parsing + health poll until ready. |
| **Dedicated embedder** | Small GGUF model (e.g. nomic/bge) spawned with `--embeddings` for vector requests; optional, degrades gracefully. |
| **Binary** | llama-server binary resolved via `WEAVELLM_LLAMA_BIN` env (default `llama` on PATH). Version floor: b9908+. |

### Business Rules

- One llama-server process per active model (no router mode).
- Model activation is always an explicit user action; never automatic.
- Version floor check runs once at boot (fail-fast if old); missing binary → model in error state, boot continues.

---

## Contracts (Inputs / Outputs / Events / External)

### New REST Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/models/:id/status` | — | `{id, state, pid?, port?, error?}` |
| POST | `/api/models/:id/activate` | — | `{state: "active", pid, port}` |
| POST | `/api/models/:id/deactivate` | — | `{state: "disabled"}` |

### Modified Endpoints

| Method | Path | Behavior Change |
|---|---|---|
| GET | `/v1/models` | Includes activated local models alongside existing externals. |
| POST | `/v1/chat/completions` | Resolves local model IDs via `localProvider`; while spawning → waits for health check. |
| POST | `/v1/embeddings` | Resolves via dedicated embedding provider if configured; otherwise existing 404. |
| GET | `/api/health` | Includes `localModels` field. |

### New Environment Variable

| Variable | Default | Purpose |
|---|---|---|
| `WEAVELLM_LLAMA_BIN` | `llama` (on PATH) | Path to llama-server binary. |

---

## Invariants & Validation

- A model can only be activated if both the binary and GGUF file are present.
- Activation always transitions through an explicit user call (never automatic).
- Only one llama-server process per model at any time (no duplicate spawn).
- Version floor is checked once at boot; if the binary is too old, boot fails immediately (global fail-fast).
- Idle-stop timer resets on every request to the model.
- Runtime state (pid/port) is reconstructed from the live process, never persisted in SQLite; only the `active` boolean is persisted.

---

## Failure Cases & Edge Cases

| Failure | Behavior |
|---|---|
| Missing GGUF for active model | Model shown as error in UI; boot continues normally. |
| Binary too old (below version floor) | Boot fails immediately (global fail-fast). |
| Spawn timeout | Manager stays in spawning→error; request returns 503. |
| Idle-stop re-spawn race | Single writer per manager, no races. |
| Model deactivated mid-request | Active request completes; new requests get error. |
| VRAM insufficient | Evict LRU → fallback CPU → spawn with warning. |
| Config change for loaded model | Download and re-spawn with new config. |

---

## Security / Privacy / Performance / Operational

### Security

- Management endpoints (`/api/models/*`) are behind the existing auth gate (`WEAVELLM_AUTH`).
- No new secrets introduced; binary path is environment-configured.

### Privacy

- No user data leaves the machine for local models (fully local inference).
- Embedding model data stays local.

### Performance

- Spawn readiness via health poll (300ms interval, 30s timeout).
- Idle-stop after 10 min default; configurable.
- N concurrent models supported (one process per model).

### Operational

- Crash restart with exponential backoff (existing in `LlamaProcessManager`).
- State visibility via REST API (`/api/models/:id/status`).
- Graceful shutdown: iterate all managers, call `stop()` on each, drain in-flight requests.
- No router process; processes loaded/unloaded directly. No config-change reload problem.

---

## Alternatives & Trade-offs

| Alternative | Why Not Chosen |
|---|---|
| Single router multiplexing all models | More complex; single point of failure; harder to reason about VRAM. Per-model processes are simpler and align with existing `LlamaProcessManager` design. |
| WebSocket spawn progress | Adds UI complexity and protocol surface; REST polling is sufficient for management. Marked as explicit non-goal. |
| Auto-activate on download | Surprises users with VRAM consumption; explicit activation is safer and more predictable. |
| Persistent pid/port in SQLite | Stale state on crash; reconstructing from live process is more reliable. Only the `active` boolean is persisted. |

---

## Acceptance Criteria (measurable)

1. POST `/api/models/:id/activate` starts llama-server, returns `{state: "active", pid, port}`.
2. GET `/v1/models` includes activated local models alongside external providers.
3. POST `/v1/chat/completions` with a local model ID returns a valid completion response.
4. Idle 10 min → process stops; next request re-spawns and succeeds.
5. Missing GGUF → model in error state, boot not blocked.
6. POST `/v1/embeddings` with no embedder configured → 404.
7. Full CI green: `bun run typecheck && bun run lint && bun test`.

---

## Unresolved Questions

None.
