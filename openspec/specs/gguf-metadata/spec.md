# GGUF Metadata Specification

## Purpose

Parse GGUF binary file headers to extract model metadata (context_length, architecture, block count, KV-head count, quantization) enabling context-aware UI decisions.

## Requirements

### Requirement: GGUF header parsing

The system SHALL read the GGUF binary header from a `.gguf` file using Bun's `ArrayBuffer`/`DataView` APIs over a bounded window (default 256 KB, since native context keys live at the start of the metadata KV section), validating the magic bytes and version, then iterating metadata key-value pairs with exact per-tag skipping (including recursively skipping `ARRAY` values of any element tag: strings, floats, ints). Unhandled or clipped values stop the sweep without failing the parse.

#### Scenario: Valid GGUF file is parsed

- GIVEN a valid `.gguf` file on disk with a standard header (`GGUF` ascii = `0x46554747` as LE uint32)
- WHEN the GGUF parser is invoked on that file
- THEN the parser returns `parsed: true` plus the extracted fields (architecture, context length, block count, KV-head count, file type as available)

#### Scenario: Non-GGUF file is rejected

- GIVEN a file that does not start with the GGUF magic bytes
- WHEN the GGUF parser is invoked
- THEN the parser returns `parsed: false` with all fields `null`, never an exception

### Requirement: Context length extraction

The system SHALL extract the `{arch}.context_length` UINT32 value — where `{arch}` comes from the parsed `general.architecture` string — from parsed GGUF headers and return it as `ggufContextLength` (integer or `null` if absent). An `ARRAY` value (per-rank export, e.g. tensor-parallel Grok/granite) SHALL be read as its first element. `general.context_length` is NOT a real GGUF key and SHALL NOT be matched.

#### Scenario: Model with context_length metadata

- GIVEN a GGUF file containing `llama.context_length = 32768` and `general.architecture = "llama"`
- WHEN the parser extracts context length
- THEN `ggufContextLength` is `32768`

#### Scenario: Architecture-gated key resolution

- GIVEN a GGUF file whose architecture is only known after `general.architecture` is read
- WHEN the parser sweeps the metadata section
- THEN it skips every pre-architecture key by exact layout, then matches `{arch}.context_length` once the architecture is known

#### Scenario: KV-head count written as an ARRAY

- GIVEN a GGUF file (e.g. IBM-Grok) whose `{arch}.attention.head_count_kv` is stored as an `ARRAY` of UINT32 (one value per tensor-parallel rank)
- WHEN the parser extracts the KV-head count
- THEN `headCountKv` is the FIRST element of the array

### Requirement: Graceful fallback on parse failure

The system SHALL NOT throw or propagate exceptions from GGUF parsing. On any parse error (corrupt header, I/O failure, unsupported version), the system SHALL return a fallback result with `parsed: false` and all fields `null`, and continue without interrupting the calling flow.

#### Scenario: Corrupt GGUF file returns null, not error

- GIVEN a file with valid magic bytes but truncated/corrupt metadata
- WHEN the parser attempts extraction
- THEN fields reachable before the corruption are returned, later fields are `null`, and no exception propagates

#### Scenario: Unreadable file returns null

- GIVEN a `.gguf` file path that cannot be read (permissions, missing)
- WHEN the parser attempts extraction
- THEN `parsed: false`, all fields `null`, and no exception propagates
### Requirement: YaRN original context derivation and rope-scale guard

The system SHALL expose `yarn_orig_ctx` derived from the parsed `{arch}.context_length` for YaRN scaling (model-advanced-config). When a scaled context is requested, the system MUST enforce a rope-scale guard: the target ctx MUST be ≥ `yarn_orig_ctx` (scale ≥ 1); configurations with scale < 1 MUST be rejected.

#### Scenario: Original context derived

- GIVEN a GGUF with `llama.context_length = 32768`
- WHEN YaRN config is resolved
- THEN `yarn_orig_ctx` is 32768 and the scale for a 131072 target is 4

#### Scenario: Scale guard rejects ratio below 1

- GIVEN a model with `yarn_orig_ctx` 32768 and a target ctx of 8192
- WHEN config is applied
- THEN the configuration is rejected with a clear message

#### Scenario: Scale guard passes at ratio ≥ 1

- GIVEN a model with `yarn_orig_ctx` 32768 and a target ctx of 32768 or larger
- WHEN config is applied
- THEN the configuration is accepted with scale ≥ 1
