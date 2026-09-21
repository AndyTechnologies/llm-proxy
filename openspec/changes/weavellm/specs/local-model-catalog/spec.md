# Local Model Catalog Specification

## Purpose

Browse and select local models from three sources — curated list, Hugging Face search, and local file paths — with metadata and state persisted in SQLite as the model registry.

## Requirements

### Requirement: Curated model list

The system SHALL ship a curated catalog of recommended GGUF models (source URL, SHA256, suggested config) kept in sync with downloads.

#### Scenario: Curated models listed

- GIVEN the catalog view
- WHEN it is opened
- THEN curated entries appear with size, quant, and context metadata

### Requirement: Hugging Face search

The system SHALL search Hugging Face for GGUF repos and import selected files into the catalog.

#### Scenario: HF search adds a model

- GIVEN a HF search query
- WHEN results are imported
- THEN the selected GGUF is registered as downloadable with metadata

### Requirement: Local path registration

The system SHALL register local `.gguf` files by path, parsing metadata via the gguf-metadata capability.

#### Scenario: Local GGUF registered

- GIVEN a local path to a valid GGUF
- WHEN the user adds it
- THEN the model appears in the catalog with parsed metadata

#### Scenario: Invalid file rejected

- GIVEN a path that is not a GGUF
- WHEN the user adds it
- THEN registration fails with a clear parse error and no entry is created

### Requirement: SQLite model registry

Catalog state MUST persist in SQLite as the source of truth: metadata, config, download state, and readiness per model.

#### Scenario: Registry survives restart

- GIVEN registered models in the catalog
- WHEN the app restarts
- THEN the registry reloads the same entries from SQLite

### Requirement: NIAH context probe

The system SHALL support a needle-in-a-haystack (NIAH) probe that validates a model's effective context and records the result per model.

#### Scenario: Probe validates scaled context

- GIVEN a downloaded model with a declared scaled context (e.g., YaRN 32K→128K, scale ≥ 1)
- WHEN the NIAH probe runs
- THEN a pass/fail result for effective context is recorded against the model

#### Scenario: Probe failure surfaced

- GIVEN a model whose effective context is below the declared scale
- WHEN the probe completes
- THEN the catalog marks the model with a failed-probe warning