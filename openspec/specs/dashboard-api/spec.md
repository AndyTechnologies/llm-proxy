# Dashboard API Specification

## Purpose

The `/api/ui/*` REST + SSE surface that lets the dashboard inspect pipelines, models, and executions and hot-apply configuration to the gateway.

## Requirements

### Requirement: Pipeline list endpoint

The system SHALL expose `GET /api/ui/pipelines` returning a list of `{id, description, nodeCount, lastExecution}` for every registered pipeline.

#### Scenario: List returns registered pipelines

- GIVEN a gateway with three registered pipelines
- WHEN `GET /api/ui/pipelines` is called
- THEN a JSON array of three pipeline summaries is returned, each with `id`, `description`, `nodeCount`, and `lastExecution`

### Requirement: Model list endpoint

The system SHALL expose `GET /api/ui/models` returning `{models:[{id,file,loaded}], modelsDir, autoRefresh}`. The model list SHALL merge registered models from `config.llama.models` with `.gguf` files detected on disk, where detected files are editor candidates only (not auto-registered).

#### Scenario: List merges registered and detected models

- GIVEN two registered models and one on-disk `.gguf` not yet registered
- WHEN `GET /api/ui/models` is called
- THEN the response lists all three files, marking the on-disk file as not `loaded`

#### Scenario: Detected model is a candidate, not auto-registered

- GIVEN a `.gguf` present on disk but absent from `config.llama.models`
- WHEN the model list is returned
- THEN the file is listed as a candidate with `loaded: false`, and is not added to config automatically

### Requirement: Execution list endpoint

The system SHALL expose `GET /api/ui/executions?limit=N` returning `[{id, pipelineId, status, totalLatencyMs}]` from bounded in-memory history (N=100 by default).

#### Scenario: List returns recent executions bounded by limit

- GIVEN 150 recorded executions and `?limit=10`
- WHEN the endpoint is called
- THEN the 10 most recent executions are returned in order

#### Scenario: History is bounded

- GIVEN more than 100 recorded executions
- WHEN the oldest entries are examined
- THEN the in-memory history keeps at most the newest 100

### Requirement: Pipeline validate endpoint

The system SHALL expose `POST /api/ui/pipelines/:id/validate` accepting `{nodes:[...],edges:[...]}` and returning `{valid:true}` or `{valid:false,errors:[...]}`. Validation MUST check acyclicity (except loop boundaries), valid references, model existence, exactly one `start` and ≥1 `end`, required fields per node type, and bounded composition depth.

#### Scenario: Valid graph passes

- GIVEN a graph with one `start`, one `end`, a valid `llm_call`, and no cycles
- WHEN validation runs
- THEN `{valid:true}` is returned

#### Scenario: Cyclic graph is rejected

- GIVEN a graph with a cycle outside a `loop` boundary
- WHEN validation runs
- THEN `{valid:false, errors:[...]}` is returned naming the cycle

#### Scenario: Missing start is rejected

- GIVEN a graph with zero `start` nodes
- WHEN validation runs
- THEN `{valid:false, errors:[...]}` is returned

### Requirement: Apply endpoint

The system SHALL expose `POST /api/ui/apply` accepting `{config:{...}}`, which zod-validates, writes atomically, reloads the registry, and returns `{status:"applied", reloadedChains:[...]}` on success or `400 {error:{message,type,param,code}}` on failure. A failed apply MUST write nothing.

#### Scenario: Valid apply reports reloaded chains

- GIVEN a valid new config with one added chain
- WHEN `POST /api/ui/apply` runs
- THEN `{status:"applied", reloadedChains:["<added>"]}` is returned and the registry updates

#### Scenario: Invalid apply returns 400 envelope

- GIVEN a config draft that fails schema validation
- WHEN `POST /api/ui/apply` runs
- THEN `400` with `{error:{message,type,param,code}}` is returned and no file is written

### Requirement: Step retry endpoint

The system SHALL expose `POST /api/ui/executions/:executionId/steps/:nodeId/retry` for failed `llm_call` steps only. Retry SHALL be non-streaming, limited to max 1 retry per step, store the result, and return `{success:true, retryExecutionId}` or an error envelope.

#### Scenario: Failed llm_call step retries once

- GIVEN a failed execution whose `llm_call` step A is retryable
- WHEN retry is requested on step A
- THEN a non-streaming retry runs, the result is stored, and `{success:true, retryExecutionId}` is returned

#### Scenario: Non-llm_call step is not retryable

- GIVEN a failed execution whose condition node C is the failed step
- WHEN retry is requested on step C
- THEN an error envelope is returned and no retry runs

#### Scenario: Already-retried step is refused

- GIVEN an `llm_call` step A that was retried once and failed again
- WHEN a further retry is requested on step A
- THEN an error envelope is returned and no further retry runs

### Requirement: SSE events endpoint

The system SHALL expose `GET /api/ui/events` as Server-Sent Events emitting `execution:started`, `step:started`, `step:completed`, `step:failed`, `execution:completed`, `pipeline:reloaded`, `models:changed`, each as `event:<name>\ndata:<json>\n\n`. The bus SHALL use a bounded buffer and evict slow/disconnected clients (backpressure), and SHALL disable the per-request SSE idle timeout like `/v1/*` streams.

#### Scenario: Client receives execution progress events

- GIVEN a connected SSE client and a running execution
- WHEN the execution passes through started/completed steps
- THEN the client receives `execution:started`, then `step:*` events, then `execution:completed` in the declared event format

#### Scenario: Slow client is evicted, not allowed to stall the bus

- GIVEN an SSE client that stops reading
- WHEN the bounded buffer fills
- THEN the slow client is evicted and the remaining clients keep receiving events

### Requirement: Error envelope contract

Every `/api/ui/*` error MUST return `{error:{message,type,param,code}}`.

#### Scenario: API failure is normalized

- GIVEN a `/api/ui/*` request that fails
- WHEN the response is produced
- THEN the body is `{error:{message,type,param,code}}` with an appropriate status code

### Requirement: Auth boundary

When `BEARER_TOKEN` is set, `/api/ui/*` and the SSE endpoint SHALL be protected by the auth guard and return 401 without a valid token; the static `/ui` SPA SHALL remain open. When no token is set, everything SHALL be open.

#### Scenario: Token protects the API but not the SPA

- GIVEN `BEARER_TOKEN` is set
- WHEN an unauthenticated request hits `/api/ui/events`
- THEN a 401 is returned; an unauthenticated request to `/ui` still loads the SPA

#### Scenario: No token leaves everything open

- GIVEN `BEARER_TOKEN` is unset
- WHEN a request hits any `/api/ui/*` route or `/ui`
- THEN it proceeds without authentication
