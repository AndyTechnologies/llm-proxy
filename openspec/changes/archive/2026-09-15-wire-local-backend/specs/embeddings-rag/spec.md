# Delta for Embeddings Rag

**Files:** `openspec/specs/embeddings-rag/spec.md`

### Changes

1. Add dedicated embedding model designation via `settings` table.
2. Add `--embeddings` spawn flag.
3. Add embedder lifecycle tied to activation of the designated model.
4. Formalize the existing 404 behavior when no embedder is configured.

## ADDED Requirements

### Requirement: Embedder lifecycle tied to model activation

The dedicated embedding model's manager SHALL be managed by `LocalBackendHub` like any other model. When the embedding model is deactivated, `hub.embedder()` SHALL return `null` until it is re-activated. When the embedding model crashes and restarts, the embedder SHALL resume when the process becomes healthy again.

#### Scenario: Deactivate embedding model clears embedder

- GIVEN an active embedding model
- WHEN it is deactivated
- THEN `hub.embedder()` returns `null` and `/v1/embeddings` returns 404

#### Scenario: Re-activate embedding model restores embedder

- GIVEN a deactivated embedding model
- WHEN it is re-activated
- THEN `hub.embedder()` returns a non-null `LlamaEmbedder`

### Requirement: Spawn args support embeddings mode

`LlamaSpawnArgsInput` SHALL include an optional `embeddings?: boolean` field. When `true`, the args array SHALL include `--embeddings`.

#### Scenario: Embeddings flag produces correct args

- GIVEN a spawn args input with `embeddings: true`
- WHEN `buildLlamaSpawnArgs` is called
- THEN the returned args include `--embeddings`

#### Scenario: No embeddings flag omits the arg

- GIVEN a spawn args input with `embeddings` omitted or `false`
- WHEN `buildLlamaSpawnArgs` is called
- THEN the returned args do not include `--embeddings`


## MODIFIED Requirements

### Requirement: Local embeddings

The system SHALL generate embeddings via a local llama.cpp embeddings model. A dedicated model SHALL be designated via a `settings` table row with key `embedding_model` and value equal to a model ID. `LocalBackendHub.embedder()` SHALL return a `LlamaEmbedder` wrapping that model's manager when configured and healthy, or `null` when not configured. The spawn args for the designated model SHALL include `--embeddings`.

#### Scenario: Embeddings produced with dedicated model

- GIVEN a model designated as the embedding model via `settings.embedding_model`
- WHEN the model is activated
- THEN `hub.embedder()` returns a non-null `LlamaEmbedder` and `/v1/embeddings` returns vectors

#### Scenario: No embedding model configured → 404

- GIVEN no `settings` row with key `embedding_model`
- WHEN `POST /v1/embeddings` is called
- THEN a 404 response is returned (existing behavior preserved)

#### Scenario: Embedding model missing GGUF → embedder returns null

- GIVEN `settings.embedding_model` points to a model whose GGUF is missing
- WHEN the hub starts
- THEN `hub.embedder()` returns `null` and `/v1/embeddings` returns 404

#### Scenario: Embedding model activated with --embeddings flag

- GIVEN a model designated as the embedding model
- WHEN it is activated
- THEN the llama-server process is spawned with `--embeddings` in its args
