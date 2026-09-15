# Keychain Secrets Specification

## Purpose

Secure storage of provider API keys and the proxy's optional auth key: sealed with AES-256-GCM under a key held by the OS keychain (macOS Keychain; Linux Secret Service).

## Requirements

### Requirement: OS keychain-backed master key

The system SHALL derive the encryption key from the OS keychain (Keychain on macOS, Secret Service on Linux). No plaintext key material SHALL be persisted outside the keychain.

#### Scenario: Key provisioned on fresh install

- GIVEN a fresh install
- WHEN the keychain initializes
- THEN a master key is created in the OS keychain and no key material is written to disk

### Requirement: AES-256-GCM sealing

Stored secrets SHALL be encrypted with AES-256-GCM using a unique nonce per record before any persistence (SQLite).

#### Scenario: Secret round-trip

- GIVEN a stored provider key
- WHEN the system reads it
- THEN the returned value matches the original plaintext

#### Scenario: Tampered ciphertext fails

- GIVEN a stored record whose ciphertext was modified
- WHEN the system reads it
- THEN decryption fails with an error surfaced, never a partial plaintext

### Requirement: Provider API keys

The app SHALL let users store, update, remove, and test provider API keys through the UI. Keys MUST NEVER appear in logs, exports, or error messages.

#### Scenario: Key stored via UI

- GIVEN the settings view
- WHEN the user saves a provider key
- THEN the key is sealed and stored, and the UI shows only a masked indicator

#### Scenario: Key never logged

- GIVEN any request using a key
- WHEN logs are produced
- THEN no log line contains the key material

### Requirement: Proxy auth key

The optional external auth key (gateway-security) SHALL be stored through the same keychain mechanism.

#### Scenario: Auth key stored

- GIVEN auth enabled in settings
- WHEN the key is saved
- THEN it is sealed in the keychain and the proxy validates against it