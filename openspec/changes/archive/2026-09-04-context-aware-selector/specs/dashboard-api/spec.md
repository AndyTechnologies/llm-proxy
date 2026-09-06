# Dashboard API — Delta Spec

Modifies: `openspec/specs/dashboard-api/spec.md`

## MODIFIED Requirements

### Requirement: Model list endpoint

The system SHALL expose `GET /api/ui/models` returning `{models:[{id,file,loaded,ggufContextLength,hardwareMaxCtx}], modelsDir, autoRefresh}`. The model list SHALL merge registered models from `config.llama.models` with `.gguf` files detected on disk, where detected files are editor candidates only (not auto-registered). Each model entry SHALL include `ggufContextLength` (integer or null from GGUF header parsing) and `hardwareMaxCtx` (integer, derived from system RAM heuristic).
(Previously: response shape was `{id,file,loaded}` with no GGUF metadata or hardware limits)

#### Scenario: List merges registered and detected models

- GIVEN two registered models and one on-disk `.gguf` not yet registered
- WHEN `GET /api/ui/models` is called
- THEN the response lists all three files, marking the on-disk file as not `loaded`

#### Scenario: Detected model is a candidate, not auto-registered

- GIVEN a `.gguf` present on disk but absent from `config.llama.models`
- WHEN the model list is returned
- THEN the file is listed as a candidate with `loaded: false`, and is not added to config automatically

#### Scenario: Model entry includes GGUF context length

- GIVEN a registered model whose GGUF file contains `general.context_length = 8192`
- WHEN `GET /api/ui/models` is called
- THEN the model entry has `ggufContextLength: 8192`

#### Scenario: Model entry includes hardware max context

- GIVEN a system with 16 GB total RAM
- WHEN `GET /api/ui/models` is called
- THEN each model entry has `hardwareMaxCtx` set to a positive integer derived from available RAM

#### Scenario: GGUF parse failure returns null, not error

- GIVEN a registered model whose GGUF file is corrupt or unreadable
- WHEN `GET /api/ui/models` is called
- THEN the model entry has `ggufContextLength: null` and the endpoint still succeeds
