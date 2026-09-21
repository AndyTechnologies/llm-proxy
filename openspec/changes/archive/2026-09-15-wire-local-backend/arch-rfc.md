# Architecture RFC: wire-local-backend

## 3D Model State

Three independent dimensions define a model's runtime state:

| Dimension | Values | Meaning |
|---|---|---|
| **VRAM Load** | `loaded` / `unloaded` | Process running in RAM vs stopped. |
| **Direct Permission** | `active` / `disabled` | Receives direct requests via `/v1/*`. |
| **Integrity** | `healthy` / `error` | Valid GGUF + binary vs broken. |

### State Combinations

| VRAM Load | Permission | Integrity | Behavior |
|---|---|---|---|
| loaded | active | healthy | Receives direct + workflows; process running. |
| unloaded | active | healthy | Receives direct + workflows; process stopped (idle or VRAM eviction); lazy re-spawn on next request. |
| unloaded | disabled | healthy | NO direct requests (not in `/v1/models`); workflows CAN use it (load on demand). |
| * | * | error | No requests of any type. |

### State Persistence

- Boolean `active` column in existing `models` table (SQLite) — the only persisted dimension.
- Runtime state (pid/port) reconstructed from the live process, never persisted.
- Integrity checked at boot and on activation; stored in memory for the session.

---

## VRAM Management

### VRAM-Heuristic Spawn

1. **Detection**: Before spawn, detect available VRAM (`nvidia-smi` / `ROCm` / `/proc/driver/nvidia/gpus`).
2. **Comparison**: Model VRAM demand calculated from GGUF size, quant, ctx size, and offload layers.
3. **Eviction**: If insufficient VRAM, evict LRU active processes until enough is freed.
4. **Fallback CPU**: If VRAM insufficient even after evicting all, spawn with `--n-gpu-layers 0` and display a clear UI warning.

### Process Topology

- No router process; processes are loaded/unloaded directly.
- No config-change reload problem — each process is a standalone `llama-server` instance.

---

## Constraints & Non-goals

### Constraints

- One llama-server process per active model (no router mode).
- Model activation is always an explicit user action; never automatic.
- Version floor check runs once at boot (fail-fast if old).
- Missing binary → model in error state, boot continues.
- Management endpoints are behind the auth gate.

### Non-goals

- No "auto-activate all" mode at boot.
- No WebSocket-based spawn progress events (REST-only).
- No auto-activation of models post-download.
- No mandatory embedding model requirement.

---

## Boundaries

### Manager Topology

- One `LlamaProcessManager` instance per active model, stored in `Map<string, LlamaProcessManager>`.
- Single owner of runtime state per model — no races between API handlers and boot.
- Each manager is fully independent: no shared state between managers.

### Provider Resolution

- Local provider injected via closure: `localProvider: () => managerForActiveModel(model)`.
- `localModels: () => activeModelIds()`.
- Preserves existing DI seams in `makeRuntimeServices` and `makeV1Handler`.
- External providers and local providers coexist in the same resolution chain.

### Boot Wiring Order

1. Read SQLite models → determine `active=true` models.
2. Version floor check (binary version); if too old → boot fails immediately.
3. For each `active=true` model: create manager + provider, attempt spawn, set state.
4. Models missing GGUF → skip manager creation, set error state, boot continues.

### Shutdown

- Iterate all managers, call `stop()` on each (existing graceful shutdown in `manager.ts`).
- Drain in-flight requests before terminating processes.

---

## Architecture Decisions

| Decision | Rationale |
|---|---|
| Per-model process (1:1) over router multiplexing | Simpler mental model; aligns with existing `LlamaProcessManager` design; VRAM management is per-model; no shared state between processes. |
| REST-only management (no WebSocket) | Sufficient for management; avoids UI protocol complexity; polling `/api/models/:id/status` is enough. |
| Only `active` boolean persisted in SQLite | Pid/port are ephemeral — reconstructing from live process is more reliable than persisting stale state after crash. |
| VRAM heuristic with CPU fallback | Graceful degradation over hard failure; user sees a warning instead of an error. |
| Closure-based provider injection | Preserves existing DI seams; no architectural changes to `makeRuntimeServices` or `makeV1Handler`. |
| Version floor as global fail-fast | Binary incompatibility affects all models; better to fail early than produce corrupted responses. |

---

## Quality Attributes

### Performance

- Spawn readiness gated by health poll: 300ms interval, 30s timeout.
- Idle-stop default: 10 min; configurable.
- N concurrent models supported (one process per model, bounded by VRAM/RAM).

### Operations

- Crash restart with exponential backoff (existing in `LlamaProcessManager`).
- State visibility via REST API (`/api/models/:id/status`, `GET /v1/models`).
- Graceful shutdown: iterate managers, stop each, drain in-flight requests.
- No config-change reload problem — each process is standalone.

### Security

- Management endpoints behind existing auth gate (`WEAVELLM_AUTH`).
- No new secrets introduced; binary path is environment-configured.
- No user data leaves the machine for local models.

### Scalability (N-process)

- One process per model; no shared state between managers.
- Bounded by available VRAM and system RAM.
- VRAM heuristic manages contention automatically.

### Availability (process-level)

- `LlamaProcessManager` restarts on unexpected exit with backoff (max 5 attempts).
- Idle-stop + lazy re-spawn provides automatic recovery from VRAM pressure.

---

## Invariants

- Exactly one `LlamaProcessManager` per active model at any time (no duplicate spawn).
- A model's `active` boolean in SQLite is the source of truth for whether it should be running.
- Runtime state (pid/port) is always derived from the live process, never from persisted state.
- Version floor is checked once at boot; binary too old → global fail-fast.
- Idle-stop timer resets on every request to the model.
- Single writer per manager — no concurrent mutations of manager state.
- In-flight requests complete before process termination on deactivation.
- Providers resolve local model IDs through the same chain as external adapters (no special-case routing).

---

## Failure Cases

| Failure | Behavior |
|---|---|
| Missing GGUF for active model | Manager not created; model in error state; boot continues; `/v1/models` omits it. |
| Binary too old (below version floor) | Boot fails immediately (global fail-fast). |
| Spawn timeout (30s health poll expires) | Manager transitions to error state; request returns 503. |
| Idle-stop re-spawn race | Single writer per manager; no concurrent spawn possible. |
| Model deactivated mid-request | Active request completes; new requests get error. |
| VRAM insufficient for any model | Evict LRU active processes → if still insufficient, fallback to CPU spawn with `--n-gpu-layers 0` + UI warning. |
| Config change for loaded model | Download new GGUF, stop current process, re-spawn with new config. |
| Unexpected process exit | `LlamaProcessManager` restarts with exponential backoff (max 5 attempts). |

---

## Acceptance Criteria (structural)

1. `makeRuntimeServices` receives non-null `localProvider()` and `localModels()`.
2. `makeV1Handler` resolves local model IDs alongside external adapters.
3. `GET /api/models/:id/status` returns correct lifecycle state for all state combinations.
4. Version floor at boot: old binary → boot fails; new binary → continues.
5. Idle-stop 10 min → process stopped → re-spawn on request.
6. Missing GGUF → error state; boot not blocked; `/v1/models` omits it.
7. All existing tests pass + new tests for: boot wiring, activate/deactivate, idle-stop, missing GGUF.

---

## Unresolved Questions

None.
