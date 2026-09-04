# Delta for Config Load

## MODIFIED Requirements

### Requirement: Zod schema validation preserved

The system MUST validate the raw record with a zod schema that accepts `nodes`/`edges` graph format via `graphNodeSchema` and `graphEdgeSchema`. The `steps` array format SHALL be removed from the schema. `graphNodeSchema` SHALL validate fields: `id`, `type`, `model`, `mode` (generate/refine/passthrough, default generate for llm_call), `on_429` (optional), `tool_calls_route` (optional), `system`/`assistant`/`user` (optional), `pos` (optional object with `x`/`y`), `ctx` (optional), `condition` (recursive via `z.lazy` for condition nodes), `pipeline`/`params` (for pipeline nodes). `graphEdgeSchema` SHALL validate: `source`, `target`, `condition` (optional). Invalid config MUST fail with a zod error listing issue messages. Validation SHALL be re-applied on every apply before any persistence or registry reload.
(Previously: `chainConfigSchema` accepted `steps` arrays; `nodes`/`edges` from the dashboard were stripped by zod.)

#### Scenario: Valid graph config yields typed result

- GIVEN a raw record with `nodes` and `edges` satisfying the graph schema
- WHEN schema validation runs
- THEN a typed `GatewayConfig` is returned with pipelines normalized

#### Scenario: steps array fails validation

- GIVEN a raw record using `steps` instead of `nodes`/`edges`
- WHEN schema validation runs
- THEN validation fails indicating `steps` is not accepted

#### Scenario: Graph node with mode validates

- GIVEN a node with `type: "llm_call"`, `mode: "refine"`, and `on_429: "fallback"`
- WHEN schema validation runs
- THEN the node is accepted with all optional fields preserved

#### Scenario: Recursive condition validates

- GIVEN a condition node with `condition: {op: "compare", ...}` (nested via `z.lazy`)
- WHEN schema validation runs
- THEN the recursive structure validates correctly

#### Scenario: Apply is gated by re-validation

- GIVEN an operator applies a draft
- WHEN the draft fails fresh schema validation
- THEN the apply is rejected with `400` and nothing is persisted or reloaded

### Requirement: YAML round-trip re-serialization

The system MUST re-serialize the whole validated config to YAML on save. Comments and original formatting SHALL be lost (accepted behavior), and the round-tripped config MUST remain schema-valid. The serialized output SHALL include `pos`, `ctx`, `mode`, `on_429`, `tool_calls_route`, and `condition` fields for each node.
(Previously: `pos` was deleted during serialization (`delete out.pos`); graph fields were not preserved in round-trip.)

#### Scenario: Edited config round-trips to valid YAML

- GIVEN a config with a pipeline containing `pos`, `ctx`, `mode`, and `on_429` fields
- WHEN it is validated and persisted
- THEN the file is valid YAML, is readable by the loader, and stays schema-valid

#### Scenario: pos is preserved in round-trip

- GIVEN a pipeline with node positions `{x: 100, y: 200}`
- WHEN the config is saved and reloaded
- THEN the node positions are preserved as `{x: 100, y: 200}`

#### Scenario: mode and ctx are preserved in round-trip

- GIVEN a pipeline with a node having `mode: "refine"` and `ctx: {maxTokens: 1024}`
- WHEN the config is saved and reloaded
- THEN both `mode` and `ctx` fields are present with their original values

### Requirement: Atomic config write

The system MUST persist the full config atomically by writing to a temporary file in the same directory and renaming over the target. The persisted config MUST always be either the complete new content or the previous content, never a partially written mixture. The serialized graph nodes SHALL include `pos` fields (not stripped).
(Previously: `buildPayload` in graph-model.js deleted `pos` before serialization.)

#### Scenario: Atomic save replaces the config without a partial window

- GIVEN an operator applies an edit to the running config
- WHEN the service persists it
- THEN the bytes are written to a temp file and renamed atomically over `llm-proxy.config.yaml`

#### Scenario: Failed write leaves the prior config intact

- GIVEN a write that aborts before the rename (e.g. disk error)
- WHEN the save fails
- THEN the original config file remains unchanged and an error envelope is returned
