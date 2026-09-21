# Delta for GGUF Metadata

Delta over `openspec/specs/gguf-metadata/spec.md` (parse + context extraction are unchanged): adds YaRN original-context derivation and a rope-scale guard for model-advanced-config.

## ADDED Requirements

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