# Model Advanced Configuration Specification

## Purpose

Per-model runtime configuration persisted in SQLite: context scaling (YaRN), KV-cache quantization, and per-call samplers. These settings drive the llama-server spawn flags (backend-management).

## Requirements

### Requirement: Per-model configuration store

Each model's advanced config (ctx size, KV quant, YaRN, samplers) MUST be stored in SQLite and applied when that model's backend spawns.

#### Scenario: Config persists per model

- GIVEN two models with different settings
- WHEN the app restarts and each model spawns
- THEN each spawns with its own stored config

### Requirement: Automatic YaRN scaling

The system SHALL apply basic automatic YaRN: raise `--ctx-size` and pass `--rope-scaling yarn`, deriving `yarn_orig_ctx` from GGUF metadata (gguf-metadata). Any target scale below 1 MUST be rejected.

#### Scenario: 32K to 128K scaling

- GIVEN a model with `yarn_orig_ctx` 32768 and target ctx 131072
- WHEN the backend spawns
- THEN it runs with `--ctx-size 131072 --rope-scaling yarn` and scale ≥ 1

#### Scenario: Scale below 1 rejected

- GIVEN a target ctx smaller than the model's original context
- WHEN config is applied
- THEN the configuration is rejected with a clear message

### Requirement: KV cache quantization

The KV cache SHALL be quantized per model via `--cache-type-k`/`--cache-type-v`, with optional `--n-cache-gpu` offload. q8_0 SHALL be sized at 1.0625 bytes/element. `--cache-ram` SHALL cap only the HOST prompt cache and MUST NOT cap the KV cache.

#### Scenario: q8_0 KV configured

- GIVEN a model configured for q8_0 KV
- WHEN the backend spawns
- THEN `--cache-type-k q8_0 --cache-type-v q8_0` are passed

#### Scenario: cache-ram does not touch KV

- GIVEN a model with an explicit `--cache-ram` cap
- WHEN the backend spawns
- THEN the cap applies to the host prompt cache only and KV sizing is unaffected

### Requirement: Per-call samplers

Sampler overrides (temperature, top_p, min_p, typical_p, top_k, repeat_penalty) SHALL be settable per llm_call node and applied per call.

#### Scenario: Node-level override applied

- GIVEN a llm_call node with custom samplers
- WHEN the node executes
- THEN the request carries those sampler values