# Delta for Config Load

## ADDED Requirements

### Requirement: Atomic config write

The system MUST persist the full config atomically by writing to a temporary file in the same directory and renaming over the target. The persisted config MUST always be either the complete new content or the previous content, never a partially written mixture.

#### Scenario: Atomic save replaces the config without a partial window

- GIVEN an operator applies an edit to the running config
- WHEN the service persists it
- THEN the bytes are written to a temp file and renamed atomically over `llm-proxy.config.yaml`

#### Scenario: Failed write leaves the prior config intact

- GIVEN a write that aborts before the rename (e.g. disk error)
- WHEN the save fails
- THEN the original config file remains unchanged and an error envelope is returned

### Requirement: YAML round-trip re-serialization

The system MUST re-serialize the whole validated config to YAML on save. Comments and original formatting SHALL be lost (accepted behavior), and the round-tripped config MUST remain schema-valid.

#### Scenario: Edited config round-trips to valid YAML

- GIVEN a config with an added pipeline
- WHEN it is validated and persisted
- THEN the file is valid YAML, is readable by the loader, and stays schema-valid

### Requirement: Config defaults generation

The system MUST generate a minimal valid config (`defaults.ts`) when no config file exists, scanning the models directory for `*.gguf`. The generated config MUST validate against the schema so the gateway can boot without manual YAML.

#### Scenario: Missing config boots on generated defaults

- GIVEN no `llm-proxy.config.yaml` and a `modelsDir` containing `m1.gguf`
- WHEN the gateway boots
- THEN a minimal valid config is generated listing `m1` as a candidate model and the gateway starts

### Requirement: Reload path on apply

An accepted apply MUST recompile and validate the new config and reload the mutable registry atomically. A rejected apply MUST roll back any partial change and return `400` with the normalized error envelope, writing nothing.

#### Scenario: Valid apply reloads the registry

- GIVEN an operator applies a valid new pipeline
- WHEN the service persists and reloads
- THEN the registry reflects the new pipeline and `pipeline:reloaded` is emitted over SSE

#### Scenario: Invalid apply writes nothing

- GIVEN an operator applies a draft that fails schema validation
- WHEN the service processes it
- THEN nothing is written to disk, the previous registry stays active, and a `400` `{error:{...}}` envelope is returned

## MODIFIED Requirements

### Requirement: Zod schema validation preserved

The system MUST validate the raw record with the existing zod schema, unchanged. Invalid config MUST fail with a zod error listing issue messages. Validation SHALL be re-applied on every apply before any persistence or registry reload.

#### Scenario: Valid config yields typed result

- GIVEN a raw record satisfying the schema
- WHEN schema validation runs
- THEN a typed `GatewayConfig` is returned with default providers normalized

#### Scenario: Invalid config fails validation

- GIVEN a raw record missing required fields
- WHEN schema validation runs
- THEN validation fails with zod issue messages

#### Scenario: Apply is gated by re-validation

- GIVEN an operator applies a draft
- WHEN the draft fails fresh schema validation
- THEN the apply is rejected with `400` and nothing is persisted or reloaded

## REMOVED Requirements

(none)

## RENAMED Requirements

(none)
