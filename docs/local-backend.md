# Local backend: managed llama-server

WeaveLLM runs **one `llama-server` child per active model**, fully supervised:
spawned with an ephemeral port, health-checked before it serves traffic,
restarted with exponential backoff on unexpected exit, and stopped after an
idle timeout. The `LocalBackendHub` (`src/backend/hub.ts`) is the source of
truth for local readiness and base URLs; the `LlamaProcessManager`
(`src/backend/manager.ts`) owns the actual process lifecycle.

Related: [architecture.md](./architecture.md) (boot order), [api.md](./api.md)
(`/api/models` surface), [providers.md](./providers.md) (the local provider
answers `/v1` through the same `Provider` contract).

## Preflight: version floor

`LocalBackendHub.preflight()` enforces a **llama.cpp b9908+** version floor —
it spawns the binary with `--version` and fails fast with an actionable boot
log message when the version is below the floor or unparseable.

- A **missing binary** is NOT a boot blocker: it is a per-model error. Boot
  proceeds and every model reports `error` state; activating one surfaces the
  same per-model error.
- The binary path comes from `WEAVELLM_LLAMA_BIN` (default `llama` on PATH).

## Spawn & readiness

`buildLlamaSpawnArgs` (`src/backend/spawn-args.ts`) builds the flag set, then
the manager starts `llama-server` with `--port 0`:

1. The **bound port is parsed from stdout** (the `listening on ...` line);
   the base URL becomes `http://127.0.0.1:<port>`.
2. **Readiness** is gated on a health poll (`GET /health` every ~300 ms,
   up to a 30 s start timeout). The model only reports `active` once healthy.
3. Spawn flags include the model path, context size, YaRN extension ratio
   (`--yarn-orig-ctx`), KV cache quantization, GPU layers (`--n-gpu-layers`),
   and flash attention. Arguments are vetted for shell metacharacters before
   use.

## Lifecycle states

`active` | `disabled` | `error` (exposed by `GET /api/models/:id/status`):

| Transition | What happens |
| --- | --- |
| `POST /api/models/:id/activate` | Verify the GGUF exists → build spawn args → start (spawn + health-poll) → persist `models.active = 1` (last) |
| `POST /api/models/:id/deactivate` | Drain in-flight requests (polling, up to 30 s) → stop the process → persist `active = 0` |
| Unexpected exit | `monitorExit` restarts with **exponential backoff** (1s → 2s → 4s … capped at 30 s, max 5 attempts), then `error` |
| Idle timeout | Stop after **10 minutes** without a request (polled every 1 s) |

## Per-request gating (`ensureReady`)

Every `/v1` chat request that resolves to a local id goes through
`hub.ensureReady()`:

- **already active** → fast path.
- **starting/stopped** → join the in-flight spawn (concurrent requests share
  one spawn through a latch).
- **failed** → `503` with a backend-not-ready error.
- The wait budget is the same 30 s start timeout; exceeding it answers `503`.

`restoreActive()` runs at boot **before the HTTP server starts**: models
persisted with `active = 1` are re-spawned so the first request never races a
cold backend.

## Model configuration

Per-model runtime settings come from the `model_config` table (defaults
applied by the model config mapping):

| Setting | Effect on spawn flags |
| --- | --- |
| `ctx_size` | `--ctx-size` |
| `kv_k` / `kv_v` | KV cache size (quantized) |
| `n_cache_gpu` | GPU cache layers |
| `cache_ram` | CPU offload amount |
| `ngl` | `--n-gpu-layers` (GPU offload) |
| `flash_attn` | `-fa on` |

The GGUF-derived context/yarn fields on the `models` row provide fallbacks.

## Embedding models

- A model is designated as the embedding model via the `settings` table
  (`embedding_model` key, set from the UI).
- When designated, the backend spawns `llama-server` **with `--embeddings`**,
  and `hub.embedder()` serves `/v1/embeddings` through the local provider
  (see [providers.md](./providers.md#embeddings)).
- With no designated model, `/v1/embeddings` answers the OpenAI-style 404
  (see [api.md](./api.md)).

## Status surface

`GET /api/models` and `GET /api/models/:id/status` report `active` /
`disabled` / `error` plus live process detail (pid, port). The same snapshot
appears in `GET /api/health` when the backend is wired.

## Test seams

The manager and hub are built for fakes: `spawnFn`, `now`, `sleep`, and
`healthCheck` are injected, so tests exercise restart, idle-stop, drain, and
readiness without spawning a real `llama-server` (`src/backend/manager.test.ts`,
`src/backend/hub.test.ts`).