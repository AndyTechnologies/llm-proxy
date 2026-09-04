# Delta for Dashboard API

## MODIFIED Requirements

### Requirement: Pipeline validate endpoint

The system SHALL expose `POST /api/ui/pipelines/:id/validate` accepting `{nodes:[...],edges:[...]}` and returning `{valid:true}` or `{valid:false,errors:[...]}`. The `steps` format SHALL NOT be accepted. Validation MUST check acyclicity (except loop boundaries), valid references, model existence, exactly one `start` and ≥1 `end`, required fields per node type, and bounded composition depth.
(Previously: endpoint accepted both `{steps:[...]}` and `{nodes:[...],edges:[...]}`.)

#### Scenario: Valid graph passes

- GIVEN a graph with one `start`, one `end`, a valid `llm_call`, and no cycles
- WHEN validation runs
- THEN `{valid:true}` is returned

#### Scenario: steps format is rejected

- GIVEN a payload with `{steps:[...]}`
- WHEN validation runs
- THEN `{valid:false, errors:[...]}` is returned indicating `steps` format is not accepted

#### Scenario: Cyclic graph is rejected

- GIVEN a graph with a cycle outside a `loop` boundary
- WHEN validation runs
- THEN `{valid:false, errors:[...]}` is returned naming the cycle

#### Scenario: Missing start is rejected

- GIVEN a graph with zero `start` nodes
- WHEN validation runs
- THEN `{valid:false, errors:[...]}` is returned

### Requirement: Apply endpoint

The system SHALL expose `POST /api/ui/apply` accepting `{config:{...}}` with graph-format pipelines (`nodes`/`edges`). The apply SHALL zod-validate using `graphNodeSchema`/`graphEdgeSchema`, persist atomically (including `pos` and `ctx` fields), reload the registry from `graphMap`, and return `{status:"applied", reloadedPipelines:[...]}` on success or `400 {error:{message,type,param,code}}` on failure. A failed apply MUST write nothing.
(Previously: apply stripped `pos` fields and accepted `steps` format; response used `reloadedChains`.)

#### Scenario: Valid apply reports reloaded pipelines

- GIVEN a valid new config with one added pipeline including `pos` and `ctx` fields
- WHEN `POST /api/ui/apply` runs
- THEN `{status:"applied", reloadedPipelines:["<added>"]}` is returned and the registry updates

#### Scenario: pos and ctx are preserved on apply

- GIVEN a pipeline with nodes having `pos: {x: 100, y: 200}` and `ctx: {maxTokens: 1024}`
- WHEN `POST /api/ui/apply` runs and the config is reloaded
- THEN the persisted config includes `pos` and `ctx` on each node

#### Scenario: Invalid apply returns 400 envelope

- GIVEN a config draft that fails schema validation
- WHEN `POST /api/ui/apply` runs
- THEN `400` with `{error:{message,type,param,code}}` is returned and no file is written

## ADDED Requirements

### Requirement: normalizeGraph accepts arrays

The system's `normalizeGraph` utility SHALL accept both array and object forms of `nodes` and `edges`, normalizing them to the canonical format expected by the graph engine. This ensures round-trip consistency between the editor (which may send arrays) and the persisted config.
(Previously: `normalizeGraph` only handled object form; arrays from the editor caused inconsistencies.)

#### Scenario: Array form nodes/edges are normalized

- GIVEN a payload with `nodes: [{id:"a",...}]` (array form)
- WHEN `normalizeGraph` processes it
- THEN the output is in the canonical format accepted by the graph engine

#### Scenario: Object form nodes/edges are normalized

- GIVEN a payload with `nodes: {a:{id:"a",...}}` (object form)
- WHEN `normalizeGraph` processes it
- THEN the output is in the canonical format accepted by the graph engine

#### Scenario: Round-trip editor to config is consistent

- GIVEN an editor draft with `nodes` and `edges` in array form
- WHEN the draft is applied, persisted, and reloaded
- THEN the reloaded config matches the original draft's semantics (positions, modes, conditions preserved)
