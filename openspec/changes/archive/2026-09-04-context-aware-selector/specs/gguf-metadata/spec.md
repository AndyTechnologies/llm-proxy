# GGUF Metadata Specification

## Purpose

Parse GGUF binary file headers to extract model metadata (context_length, architecture, quantization) enabling context-aware UI decisions.

## Requirements

### Requirement: GGUF header parsing

The system SHALL read the GGUF binary header from a `.gguf` file using Bun's `ArrayBuffer`/`DataView` APIs, validating magic bytes (`GGUF` in little-endian) and version, then extracting metadata key-value pairs until end of header.

#### Scenario: Valid GGUF file is parsed

- GIVEN a valid `.gguf` file on disk with a standard header
- WHEN the GGUF parser is invoked on that file
- THEN the parser returns a metadata object containing the extracted KV pairs

#### Scenario: Non-GGUF file is rejected

- GIVEN a file that does not start with the GGUF magic bytes
- WHEN the GGUF parser is invoked
- THEN the parser returns a fallback result indicating parse failure, not an exception

### Requirement: Context length extraction

The system SHALL extract the `general.context_length` metadata value from parsed GGUF headers as a `UINT32` (type tag 4). The extracted value SHALL be returned as `ggufContextLength` (integer or `null` if absent).

#### Scenario: Model with context_length metadata

- GIVEN a GGUF file containing `general.context_length = 8192`
- WHEN the parser extracts context length
- THEN `ggufContextLength` is `8192`

#### Scenario: Model without context_length metadata

- GIVEN a GGUF file that does not contain `general.context_length`
- WHEN the parser extracts context length
- THEN `ggufContextLength` is `null`

### Requirement: Graceful fallback on parse failure

The system SHALL NOT throw or propagate exceptions from GGUF parsing. On any parse error (corrupt header, I/O failure, unsupported version), the system SHALL return a fallback result with `ggufContextLength: null` and continue without interrupting the calling flow.

#### Scenario: Corrupt GGUF file returns null, not error

- GIVEN a file with valid magic bytes but truncated/corrupt metadata
- WHEN the parser attempts extraction
- THEN `ggufContextLength` is `null` and no exception propagates

#### Scenario: Unreadable file returns null

- GIVEN a `.gguf` file path that cannot be read (permissions, missing)
- WHEN the parser attempts extraction
- THEN `ggufContextLength` is `null` and no exception propagates
