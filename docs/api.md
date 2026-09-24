# HTTP & WebSocket API

WeaveLLM exposes three surfaces on one origin (default `http://127.0.0.1:4317`):

| Surface | Base path | Purpose | Auth-gated |
| --- | --- | --- | --- |
| OpenAI-compatible | `/v1` | Chat completions, completions, models, embeddings | Yes when enabled |
| Runtime/admin | `/api` | Health, model lifecycle, workflow CRUD + run | `/api/models` only |
| WebSocket | `/ws` | Live workflow runs (bind + run messages) | No |
| Static UI | `/`, `/ui` | Compiled frontend (GET/HEAD only) | No |

**Runtime config** (`env`): `WEAVELLM_HOST` (default `127.0.0.1`),
`WEAVELLM_PORT` (default `4317`; `0` = ephemeral), `WEAVELLM_AUTH`
(off by default; `1`/`true` enables the Bearer gate), `WEAVELLM_UI_DIR`
(compiled UI override).

## Auth gate

- **Off by default.** Enable with `WEAVELLM_AUTH=1` (or `true`).
- When enabled, requests must carry `Authorization: Bearer <key>`, where the
  key is the keychain secret scoped `auth` (set through the desktop UI
  settings; there is no file-based config).
- Rejections use the OpenAI envelope on `/v1`
  (`{"error":{"message":"Unauthorized","type":"authentication_error"}}`)
  and `{"error":"unauthorized"}` with 401 on `/api/models`.
- The gate applies to **all `/v1` routes and the `/api/models` branch only**.
  `/api/workflows`, `/api/health`, the static UI, and `/ws` are not gated.
- The gate is constant-time (hashed compare) — token length is not
  observable.

## `/v1` — OpenAI-compatible surface

### `GET /v1/models`

Lists every resolvable model id, in order: **external provider models →
local backend ids → `gateway/<workflow>`** virtual models. Response shape is
OpenAI `list` Envelope (`{"object":"list","data":[{"id", ...}]}`).

### `POST /v1/chat/completions`

Standard OpenAI body (`model`, `messages`, `stream`, `max_tokens`,
`temperature`, `top_p`, `stop`, `user`).

- **Model resolution:** `gateway/<name>` prefixes route to a stored workflow;
  the `X-Chain-ID` header picks the workflow for *any* model string (header
  wins). Otherwise: external adapter ids → local backend ids. Unmapped model
  ids get the OpenAI unknown-model 404 envelope
  (`model_not_found`, message `The model '<id>' does not exist or you do not
  have access to it`).
- **Streaming (`stream: true`):** OpenAI-wire SSE via the relay in
  `src/routes/relay.ts`. Exactly **one** terminal `data: [DONE]` is emitted,
  and the upstream call is aborted when the client disconnects.
- **Local models:** a local id that is not ready yet returns `503` (the hub
  gates readiness — see [local-backend.md](./local-backend.md)).
- **429 fallback:** chat calls ride the provider fallback chain (see
  [providers.md](./providers.md)).

### `POST /v1/completions` (legacy)

Accepts OpenAI legacy bodies: `prompt` can be a string or array; it becomes a
single `user` chat message forwarded through the same resolution chain.
Passthrough fields: `max_tokens`, `temperature`, `top_p`, `stop`, `user`,
`stream`. The response is converted back into the legacy completions shape.

### `POST /v1/embeddings`

Serves embeddings through the local backend when a model is designated via
the `settings` table (`embedding_model` key). When none is configured the
route answers the OpenAI 404 envelope (`model_not_found`).

## `/api` — runtime & admin surface

### `GET /api/health`

`{"status":"ok", ...}`; when the local backend is wired it includes the
current local model states. Not auth-gated.

### `/api/models` (auth-gated when enabled)

| Method & path | Behavior |
| --- | --- |
| `GET /api/models` | All models with lifecycle state (`active` \| `disabled` \| `error`) |
| `GET /api/models/:id` | Single model detail |
| `GET /api/models/:id/status` | Lifecycle state |
| `POST /api/models/:id/activate` | Spawn the model (verify GGUF → start → persist `active=1`) |
| `POST /api/models/:id/deactivate` | Drain in-flight requests (up to 30 s), stop, persist `active=0` |

Details on the lifecycle, spawn flags, and readiness gating live in
[local-backend.md](./local-backend.md).

### `/api/workflows`

| Method & path | Behavior |
| --- | --- |
| `GET /api/workflows` | List `[{name, version, updatedAt}]` |
| `GET /api/workflows/:name` | Full record (includes the YAML graph) |
| `PUT /api/workflows/:name` | Upsert: parse + validate the graph, then save (`{ok, name, version}`) |
| `DELETE /api/workflows/:name` | `204` on success, `404` when unknown |
| `POST /api/workflows/:name/run` | Execute with an OpenAI chat body; returns the completion result |
| `GET /api/workflows/:name/logs` | Execution history for that workflow |

Workflow semantics — node types, guards, modes, gateway exposure — live in
[workflows.md](./workflows.md).

## `/ws` — live workflow runs

Plain `GET /ws` (non-upgrade) answers `426 WebSocket upgrade required`.

Client → server messages (JSON):

| Message | Meaning |
| --- | --- |
| `{"type":"bind","workflow":"<name>"}` | Bind the socket to a workflow; validates against the store, answers `status bound` or an error for unknown names |
| `{"type":"run","messages":[{"role","content"}, ...]}` | Run the bound workflow with that conversation; each item must be `{role, content}` strings |

Server → client events:

| Event | Payload |
| --- | --- |
| `status` | `{workflow, state}` — `bound` \| `running` \| `ok` \| `error` |
| `step_started` | `{nodeId, nodeType}` |
| `step_completed` | `{nodeId, ms}` |
| `token` | Raw OpenAI-wire SSE `data:` payload(s) — see below |
| `error` | `{workflow, nodeId?, error}` |

**Token semantics:** the `token` event relays the *completed* run's
OpenAI-wire SSE in a single chunk, followed by exactly one `token` event with
`data: [DONE]` — live per-token deltas are not streamed yet. The engine runs
to completion, then the final transcript is relayed.

**Disconnect semantics:** closing the socket aborts the in-flight run
(upstream request is cancelled via its `AbortController`).

## Static UI serving

`serveStaticUi` (`src/app/static-ui.ts`) serves the compiled frontend:

- **GET/HEAD only** — assets, `/`, `/ui`, and `/ui/` resolve to `index.html`
  (SPA entry); extensionless asset misses fall back to `index.html` too.
- Existing assets are served with content-type inferred by Bun.
- Malformed paths (bad encoding, null bytes, `..`) resolve to `null` → 404.
- The `/v1`, `/api`, and `/ws` namespaces are **reserved** — they always hit
  their handlers, never static files.

See [desktop-ui.md](./desktop-ui.md) for the page map and dev workflow.

## Error summary

| Condition | Status | Body |
| --- | --- | --- |
| Unknown model id | 404 | OpenAI `model_not_found` envelope |
| Auth rejected (`/v1`) | 401 | OpenAI `authentication_error` envelope |
| Auth rejected (`/api/models`) | 401 | `{"error":"unauthorized"}` |
| Local model not ready | 503 | Backend-not-ready error |
| Unknown workflow name (`/api`/`/ws`) | 404 (`/api`) / `error` event (`/ws`) | `{"error":"not_found"}` |
| Bad JSON body | 400 | `{"error":"invalid JSON body"}` |
| Missing `messages` | 400 | `{"error":"missing messages array"}` |
| Unhandled method | 405 | `{"error":"method_not_allowed"}` |
| Unmatched path | 404 | OpenAI-style `invalid_request_error` (not found) |
| Non-upgrade `/ws` | 426 | `WebSocket upgrade required` |