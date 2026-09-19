# Explore: wire-local-backend

Status: success (exploration complete; no blockers).

## Verdict

The RFCs describe an integration task on seams the codebase was explicitly shaped for. No acceptance criterion conflicts with existing code.

## File-by-file findings

- **src/main.ts** — boot wiring is the integration point; currently null closures. Needs hub creation, version-floor preflight, non-null DI closures, hub in api deps. High feasibility.
- **src/orchestrator/runner.ts** — local-first resolution exists; zero diff.
- **src/routes/v1.ts** — local resolution + /v1/models merge + embeddings 404 all exist; readiness-gating lives below this layer (hub wrapper).
- **src/routes/api.ts** — /api/models/* endpoints absent; ApiDeps grows a hub dep.
- **src/app/server.ts** — /api/health needs optional localModels field.
- **src/backend/manager.ts** — full lifecycle exists incl. re-spawn after idle-stop; IDLE_TIMEOUT_MS 5→10 min; optional in-flight drain on stop().
- **src/providers/llama-server.ts** — dynamic baseUrl + noteActivity; no change.
- **src/providers/embeddings.ts** — LlamaEmbedder fits the dedicated-embedder contract; spawn-args lacks --embeddings flag.
- **src/providers/registry.ts, types.ts** — no change (local stays outside).
- **src/db/schema.ts** — add active INTEGER NOT NULL DEFAULT 0 + idempotent ALTER migration for existing DBs.
- **src/app/config.ts** — WEAVELLM_LLAMA_BIN (default "llama") → llamaBin.
- **src/backend/spawn-args.ts** — optional embeddings flag for the embedder.

## Acceptance criteria validation

1. **activate endpoint** — buildable (hub + status()).
2. **/v1/models locals** — exists (v1.ts); non-null closures + healthy-only ids.
3. **chat/completions local** — buildable; needs readiness-gating wrapper.
4. **idle 10min + lazy re-spawn** — buildable; constant change + noteActivity.
5. **missing GGUF → error, boot ok** — buildable (skip manager, omit from list).
6. **embeddings no embedder → 404** — exists (zero diff).
7. **CI green** — buildable; existing tests unaffected (active default, constant).

## Blast radius

**Modified existing files**: main.ts, db/schema.ts, app/config.ts, app/types.ts, routes/api.ts, app/server.ts, backend/manager.ts, backend/spawn-args.ts + their tests.

**New files**: src/backend/hub.ts (+hub.test.ts).

**Unchanged**: runner.ts, v1.ts, registry.ts, types.ts, embeddings.ts, model-config.ts, fallback.ts, catalog.ts.

## Design decisions for propose phase

1. **Version-floor ENOENT ambiguity**: ENOENT on --version → per-model error + boot continues; parseable-but-old → global fail-fast.
2. **Embedder designation**: recommend settings row `embedding_model`; requires --embeddings in spawn-args.
3. **Spawn failure → err.status 503** so v1.ts providerError returns 503.
4. **Deactivation drain**: gate stop() on the in-flight counter (noteActivity).
