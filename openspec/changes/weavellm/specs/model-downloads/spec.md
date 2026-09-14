# Model Downloads Specification

## Purpose

Download GGUF models through the gosh CLI sidecar (goshitsarch-eng/gosh-dl-cli, MIT) v0.6.3+ with SHA256 verification and resumable transfers, driven from the catalog.

## Requirements

### Requirement: gosh CLI integration

The system MUST drive downloads via the gosh CLI v0.6.3+ sidecar, parsing its `--output json` progress and completing files into the models directory.

#### Scenario: Download completes

- GIVEN a catalog model with a source URL
- WHEN the user starts the download
- THEN gosh downloads the GGUF and the system records completion from its JSON output

#### Scenario: Progress reported

- GIVEN an active download
- WHEN gosh emits progress JSON
- THEN the UI reflects bytes/percentage live

### Requirement: Integrity verification

Every download MUST verify a SHA256 checksum before registration. The system SHALL pass the checksum in the `sha256:<hex>` form (prefix required by gosh). A mismatch MUST discard the file and MUST NOT register the model.

#### Scenario: Checksum verified

- GIVEN a completed gosh download
- WHEN verification runs
- THEN the file is registered only if its digest matches the expected `sha256:<hex>`

#### Scenario: Checksum mismatch

- GIVEN a completed download whose digest differs
- WHEN verification runs
- THEN the file is discarded, the model is not registered, and an error is surfaced

### Requirement: Resumable downloads

Downloads SHALL resume from interruption via gosh `resume` (single) and `resume-all` (batch) instead of restarting.

#### Scenario: Interrupted download resumes

- GIVEN a download interrupted mid-transfer
- WHEN the user resumes it
- THEN transfer continues from the last completed chunk

#### Scenario: Batch resume

- GIVEN several interrupted multi-file downloads
- WHEN `resume-all` is issued
- THEN each interrupted file resumes

### Requirement: Download queue and cancellation

The system SHALL queue downloads, allow cancellation, and persist download state in SQLite.

#### Scenario: Concurrent downloads tracked

- GIVEN two models queued
- WHEN both are downloading
- THEN each is tracked independently with per-file progress

#### Scenario: Cancel leaves resumable state

- GIVEN an in-flight download
- WHEN the user cancels it
- THEN gosh is terminated and partial state is marked resumable