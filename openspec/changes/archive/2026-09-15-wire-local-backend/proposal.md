# Proposal: wire-local-backend

## Intent

Wire the managed `llama-server` lifecycle (already implemented in `src/backend/manager.ts`) into the runtime boot path so local models become callable via `/v1/*` and the workflow engine, expose model activation/deactivation through a REST management API, persist active state across restarts, and support an optional dedicated embedding model — all while preserving the existing DI seams in `makeRuntimeServices`, `makeV1Handler`, and `makeApiHandler` with zero changes to the provider registry, orchestrator, or v1 dispatch logic.

---

## Scope

### Modified files

| File | Change |
|---|---|
| `src/main.ts` | Hub creation, version-floor preflight, non-null DI closures, hub in api deps |
| `src/app/types.ts` | `llamaBin` field on `AppConfig` |
| `src/app/config.ts` | `WEAVELLM_LLAMA_BIN` env resolution |
| `src/app/server.ts` | Optional `localModels` field in health response |
| `src/db/schema.ts` | `active INTEGER NOT NULL DEFAULT 0` on `models` + idempotent ALTER migration |
| `src/routes/api.ts` | `/api/models` routes (GET list, GET :id/status, POST :id/activate, POST :id/deactivate); `ApiDeps` grows `hub` field |
| `src/backend/manager.ts` | `IDLE_TIMEOUT_MS` 5→10 min; optional in-flight drain guard on `stop()` |
| `src/backend/spawn-args.ts` | `embeddings?: boolean` on `LlamaSpawnArgsInput`; `--embeddings` flag |
| `src/routes/api.test.ts` | Tests for new `/api/models` endpoints |
| `src/backend/manager.test.ts` | Tests for idle-timeout change and drain guard |
| `src/backend/spawn-args.test.ts` | Tests for `--embeddings` flag |
| `src/db/schema.test.ts` | Tests for migration + active column |
| `src/app/config.test.ts` | Tests for `WEAVELLM_LLAMA_BIN` |
| `src/app/server.test.ts` | Tests for `localModels` in health |
| `src/main.test.ts` | Tests for hub wiring in boot |

### New files

| File | Purpose |
|---|---|
| `src/backend/hub.ts` | `LocalBackendHub` — single orchestrator for all local model managers |
| `src/backend/hub.test.ts` | Unit tests for hub activate/deactivate/status/stopAll |

---

## Approach

### 1. `LocalBackendHub` (`src/backend/hub.ts`)

Central module owning all local model lifecycle. One instance created at boot, injected into DI closures and api deps.

**Interface:**

```typescript
interface LocalBackendHub {
  activate(modelId: string): Promise<{ state: "active"; pid: number; port: number }>
  deactivate(modelId: string): Promise<{ state: "disabled" }>
  status(modelId: string): ModelStatus
  statusAll(): ModelStatus[]
  localProvider(modelId: string): LlamaServerProvider | null
  localModels(): string[]
  embedder(): LlamaEmbedder | null
  stopAll(): Promise<void>
}

interface ModelStatus {
  id: string
  state: "active" | "disabled" | "error"
  pid?: number
  port?: number
  error?: string
}
```

**Internals:**

- `Map<string, LlamaProcessManager>` — one manager per active model.
- `activate(modelId)`: validates GGUF exists, creates manager, spawns, records in-memory status. Persists `active=1` to SQLite.
- `deactivate(modelId)`: drains in-flight requests (see Design Decision 4), calls `stop()`, removes manager from map, persists `active=0`.
- `status(modelId)`: returns current in-memory state (not from SQLite).
- `localProvider(modelId)`: returns the `LlamaServerProvider` wrapper for a healthy active model, `null` otherwise.
- `localModels()`: returns IDs of active+healthy models (for `/v1/models` merge).
- `embedder()`: returns the dedicated embedder provider if configured and healthy, `null` otherwise.
- `stopAll()`: iterates all managers, drains, calls `stop()`. Called from graceful shutdown.

**Readiness-gating wrapper:** `localProvider()` returns a provider whose `chat`/`chatStream` methods await the manager's health poll before forwarding. If the manager is not yet ready (still spawning), the request blocks until ready or times out (30s). If in error state, throws immediately.

**Version-floor preflight (boot):** Before creating any managers, hub runs `--version` against `llamaBin`:
- ENOENT (binary not found): all models enter `error` state with actionable message; boot continues.
- Parseable but old (below b9908): `process.exit(1)` — global fail-fast per RFC.
- Parseable and current: proceed.

**Embedder manager:** If `settings` table has `embedding_model` key pointing to a valid model ID, hub creates a dedicated manager for that model with `--embeddings` flag and wraps it as a `LlamaEmbedder`. If the key is absent or model is invalid, `embedder()` returns `null` (current 404 behavior preserved).

### 2. Boot wiring (`src/main.ts`)

```
hub = LocalBackendHub(db, config.llamaBin)
hub.preflight()               // version floor + ENOENT → per-model error
await hub.restoreActive()     // read active=1 from DB, spawn each

makeRuntimeServices({
  ...
  localProvider: (id) => hub.localProvider(id),
  localModels: () => hub.localModels(),
  embedder: hub.embedder(),
})

makeV1Handler({ ... })        // unchanged signature; receives non-null closures
makeApiHandler({ ... hub })   // hub added to ApiDeps
```

### 3. `/api/models` routes (`src/routes/api.ts`)

Extend `ApiDeps` with `hub: LocalBackendHub`. Add route matching after the existing `/api/workflows` block:

| Method | Path | Handler |
|---|---|---|
| GET | `/api/models` | `jsonResponse(hub.statusAll(), 200)` |
| GET | `/api/models/:id/status` | `hub.status(id)` or 404 |
| POST | `/api/models/:id/activate` | `hub.activate(id)` → 200 or 4xx/503 |
| POST | `/api/models/:id/deactivate` | `hub.deactivate(id)` → 200 or 404 |

All behind existing auth gate. No new auth surface.

### 4. Schema migration (`src/db/schema.ts`)

- Add `active INTEGER NOT NULL DEFAULT 0` to `MODELS_TABLE` CREATE statement (for fresh DBs).
- Add idempotent ALTER in `applySchema` for existing DBs:
  ```sql
  PRAGMA table_info(models)
  ```
  If `active` column absent → `ALTER TABLE models ADD COLUMN active INTEGER NOT NULL DEFAULT 0`.
- Add `embedding_model` key support via existing `settings` table (no schema change needed).

### 5. Config (`src/app/config.ts`, `src/app/types.ts`)

- `AppConfig` gains `llamaBin: string`.
- `resolveAppConfig` reads `WEAVELLM_LLAMA_BIN` env, defaults to `"llama"`.
- `AppEnv` interface gains `WEAVELLM_LLAMA_BIN?: string`.

### 6. Spawn args (`src/backend/spawn-args.ts`)

- Add `embeddings?: boolean` to `LlamaSpawnArgsInput`.
- When `embeddings === true`, push `"--embeddings"` to the args array.
- Update `buildLlamaSpawnArgs` test cases.

### 7. Health endpoint (`src/app/server.ts`)

- `/api/health` response gains optional `localModels` field: `hub.localModels()`.
- Only present when hub is wired (non-null).

---

## Design Decisions

### 1. Version-floor ENOENT handling

| Scenario | Behavior |
|---|---|
| Binary not found (ENOENT on `--version`) | All models enter `error` state with message "llama-server binary not found at '<path>'". Boot continues. |
| Parseable but old (build < b9908) | `process.exit(1)` — global fail-fast. |
| Parseable and current (build >= b9908) | Proceed. |

**Rationale:** ENOENT is a deployment configuration issue (wrong path), not a code incompatibility. Per-model degradation lets the rest of the system (workflows, external providers) keep working. An old binary is a code-level incompatibility that could corrupt responses — fail immediately.

### 2. Embedder designation

- A `settings` table row with key `embedding_model` and value = model ID designates the dedicated embedder.
- When set: hub creates that model's manager with `--embeddings` flag and wraps it as `LlamaEmbedder`.
- When not set: `embedder()` returns `null`; `/v1/embeddings` returns 404 (existing behavior).
- No UI for this in this change — power users set it via SQLite directly. UI configuration is future work.

### 3. Spawn failure → HTTP 503

Hub's readiness-gating wrapper catches spawn errors and attaches `err.status = 503` before rethrowing. This ensures the existing `providerError` mapper in `v1.ts` produces a 503 response (Service Unavailable), not 502 (Bad Gateway, which implies an upstream failure).

### 4. In-flight drain on deactivation

Deactivation uses the `noteActivity` counter already exposed by `LlamaServerProvider`:

1. Read current in-flight count.
2. If 0: call `stop()` immediately.
3. If > 0: poll every 1s for up to 30s until counter reaches 0, then `stop()`.
4. If timeout: force `stop()` anyway (requests will fail with connection reset, which is acceptable for a deactivation).

This prevents killing a process while requests are mid-flight, matching the Product RFC invariant "active request completes before process termination."

---

## Non-Goals

- Workflow engine changes (runner.ts, graph.ts — zero diff confirmed)
- New UI screens (dashboard already shows model status from `/api/models`)
- Distribution/packaging (binary bundling, installers)
- Embedding model configuration UI (settings table is sufficient for initial release)
- VRAM heuristic spawn (explicit future work; current change spawns unconditionally)
- Auto-activate on download (explicit non-goal per RFC)

---

## Acceptance Criteria

1. **POST `/api/models/:id/activate`** starts llama-server, returns `{state: "active", pid, port}`.
2. **GET `/v1/models`** includes activated local models alongside external providers.
3. **POST `/v1/chat/completions`** with a local model ID returns a valid completion response.
4. **Idle 10 min** → process stops; next request re-spawns and succeeds.
5. **Missing GGUF** → model in error state, boot not blocked.
6. **POST `/v1/embeddings`** with no embedder configured → 404.
7. **Full CI green:** `bun run typecheck && bun run lint && bun test`.
