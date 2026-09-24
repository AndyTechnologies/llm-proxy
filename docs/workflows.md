# Workflows: DAGs as models

A workflow is a **directed acyclic graph** of typed `nodes` connected by
`edges`. Stored as YAML in the `workflows` table, each saved workflow is
exposed as a **virtual model** `gateway/<name>` on the OpenAI surface and can
be executed over the WebSocket or the `/api` surfaces.

Related: [api.md](./api.md) (workflow endpoints), [providers.md](./providers.md)
(nodes call providers), [architecture.md](./architecture.md) (runner wiring).

## Anatomy

```yaml
name: my-pipeline
version: 1
nodes:
  - id: start
    type: start
  - id: draft
    type: llm_call
    model: local-model
    mode: generate
  - id: done
    type: end
edges:
  - from: start
    to: draft
  - from: draft
    to: done
```

- **`name`** (required) is the workflow id; `id` and `version` are optional.
- **`edges`** are `{from, to, guard?}`; `guard` is `true`/`false` and only
  meaningful out of `condition` / `router` nodes.
- A graph must have **exactly one `start`** and **at least one `end`**.

## Node types (14)

| Type | Behavior |
| --- | --- |
| `start` | Entry point; seeds the run |
| `end` | Terminal node; its branch result becomes the completion |
| `llm_call` | Calls a provider (`model`, optional `provider` kind/model pair) |
| `condition` | Evaluates an expression; edges fan out on `guard` |
| `router` | Like `condition` but routing through guard edges |
| `loop` | Iterates its `body` sub-graph with an iteration bound |
| `fan` | Sparks parallel branches (see `parallel`) |
| `join` | Merges branch outputs (variables already merged) |
| `pipeline` | Composes a fixed inner DAG (max depth 5) |
| `rag_local` | Embed → retrieve chunks → answer with sources |
| `data.code` | Runs JS in the sandbox; output lands in `variables.code` |
| `memory` | Loads/stores key/value memory (`kv_memory`) |
| `embeddings` | Produces embeddings through the local backend |
| `output` | Values a branch; output aggregation point |

## `llm_call` modes & routing

| Mode | Message construction |
| --- | --- |
| `generate` | Scaffolds: system prompt (if set), prior history/drafts concatenated, then the newest user message + optional direct `user` text |
| `refine` | Re-feeds the previous step's `lastContent` as the latest user turn — iterative refinement over scaffolds |
| `passthrough` | Forwards the original conversation untouched (no scaffold); the response replaces `lastResponse` |

Conditional routing after a call:

- **`on_429`** — when the provider answers 429, the node emits a `reroute`
  event and the schedule continues at the target node instead of failing.
- **`tool_calls_route`** — when the response contains tool calls, the run
  continues at the target node with the calls available downstream
  (`tool_calls_route` target).

A node can set `parallel: true` to run connected fan/join branches
concurrently.

## Execution model

`runGraphEngine` (`src/orchestrator/engine.ts`) schedules by dependency
order (wave scheduler): a node runs when all its predecessors completed; a
`fan`/`parallel` group is emitted in one wave; a `join` aggregates the latest
branch outputs. Every node emits lifecycle events (`step:start`,
`step:complete`, `step:error`, `reroute`, `run:complete`) which the runner
relays over the WebSocket ([api.md](./api.md#ws--live-workflow-runs)).

- **Expressions** (`condition`/`router`) are parsed ASTs evaluated against the
  branch context (`variables`, `lastResponse`, `history`).
- **`data.code`** runs inside the sandbox — on Linux via `unshare -n` (no
  network), on macOS via `sandbox-exec` through a policy inspection
  ([architecture.md](./architecture.md#module-map)). The sandbox denies
  network access, fs escape, and process.env leaks.
- **Validation** (`validateGraph`): exactly one `start`, ≥ 1 `end`, edges
  reference real nodes, required per-type fields present (e.g. `llm_call.model`,
  `condition.condition`, `loop.body`, `data.code.code`), known models check
  when a model list is supplied, acyclicity enforced except across `loop`
  boundaries, connectivity required.
- **Execution log:** every run is recorded (`execution_log`) with status,
  error, and duration; `GET /api/workflows/:name/logs` reads it back.

## RAG & memory

- `rag_local`, `embeddings`, and `memory` nodes are present in the taxonomy.
- The chunk and kv-memory **stores are currently stubbed**: retrieval calls
  return empty results and memory load/store calls are no-ops until a
  persistence backend is wired into `makeRuntimeServices` (they are injected
  as `chunks: () => null`, `memory: () => null` at boot).
- Embeddings *are* live: they flow through the local backend when an
  embedding model is designated ([local-backend.md](./local-backend.md)).

## Gateway exposure

`makeWorkflowRunner` (`src/orchestrator/runner.ts`) is the execution path:

- **Virtual model id:** each saved workflow is callable as
  `gateway/<name>` via POST `/v1/chat/completions`.
- **`X-Chain-ID` header:** selects the workflow for *any* model string,
  overriding the `gateway/` prefix. This is how the workflow editor runs a
  graph under a chosen model id.
- **Input:** OpenAI chat body (`messages`).
- **Output:** an OpenAI completion object (`object: "chat.completion"`,
  `model: "gateway/<name>"`, `usage: null`).
- **Errors:** unknown workflow → 404 (`not_found`); parse/validation/engine
  failure → 502 (`workflow` error envelope).

## Workflow endpoints

| Surface | Endpoint | Notes |
| --- | --- | --- |
| CRUD | `GET/PUT/DELETE /api/workflows[/:name]` | YAML upsert validated before save |
| Run (REST) | `POST /api/workflows/:name/run` | OpenAI chat body → completion |
| Logs | `GET /api/workflows/:name/logs` | Execution history |
| Live | `/ws` (`bind` + `run`) | Streaming relay of the completed transcript |

Full payload details in [api.md](./api.md).