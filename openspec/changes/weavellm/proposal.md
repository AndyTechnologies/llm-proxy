# Proposal: WeaveLLM — Full Rewrite

## Intent

Replace llm-proxy gateway with WeaveLLM: Electrobun desktop app with visual workflow editor, local model management, multi-provider proxy, embeddings/RAG. One binary, zero setup.

## Scope

### In Scope
- Electrobun + Astro/Svelte shell (macOS 14+/Ubuntu 24.04+)
- Workflow editor + engine: @xyflow/svelte 1.6.6, YAML, DAG validation, 10+ node types, techniques, virtual models
- Model catalog + downloads: curated/HF/local, gosh SHA256+resume, SQLite
- Per-model config: YaRN auto, KV quant, samplers
- 4 providers + AES-256-GCM keys; /v1/* proxy (4317, optional auth)
- Embeddings + RAG; data.code sandbox (no-net, tmp-only)
- /ws streaming; NIAH; auto-update; tests fresh

### Out of Scope
- Windows; legacy chains; complex auto-update UI

## Capabilities

### New Capabilities
- `desktop-app-shell`: packaging, SPA, auto-update
- `workflow-editor`: visual editor, YAML, validation
- `workflow-engine`: DAG exec, node taxonomy, techniques, virtual models
- `local-model-catalog`: curated + HF + local, NIAH
- `model-downloads`: gosh, resume, SHA256
- `model-advanced-config`: YaRN, KV quant, SQLite, samplers
- `keychain-secrets`: AES-256-GCM, OS keychain
- `external-proxy`: /v1/*, port, auth
- `embeddings-rag`: vector, memory, rag_local
- `data-code-sandbox`: isolated, no net, timeout
- `websocket-streaming`: /ws events

### Modified Capabilities
- `backend-management`: router/preset → single-model spawn + YaRN/KV flags; llama.cpp b9908+
- `gguf-metadata`: + yarn_orig_ctx derivation + rope-scale guard
- `external-providers`: openai-only → 4 providers + keychain + fallback
- `gateway-security`: optional auth, keychain, localhost

## Approach

Port gguf.ts, manager.ts, graph.ts, Provider contract, openai types; all else fresh. SPA in Electrobun webview; gosh sidecar; bun:sqlite; Bun.serve + WebSocket.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/` | Rewritten | All replaced |
| `openspec/specs/` | Modified | 10 archived, 4 deltas |
| `scripts/build-binaries.ts` | Modified | Electrobun/Hutch |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Electrobun+Bun early | Med | Pin; test floors |
| Budget > 400 lines | High | Chained PRs |
| gosh checksum prefix | Med | Validate; unit test |
| --cache-ram naming | Med | Spec docs |
| Linux WebKitGTK deps | Low | Flatpak bundles |

## Rollback Plan

Tag master pre-rewrite; git reset if abandoned; PR slices revertable; legacy specs archived.

## Dependencies

- Electrobun v2 + Hutch; gosh v0.6.3+; llama.cpp b9908+; Bun 1.4+
- Astro 7.3.2, Svelte 5.57.0, @astrojs/svelte 9.0.1, @xyflow/svelte 1.6.6

## Success Criteria

- [ ] Bundle < 100 MB, 3 targets
- [ ] Cold start < 2s
- [ ] GGUF via gosh + SHA256
- [ ] Editor workflow e2e
- [ ] MoA 3+1 → synthesis
- [ ] Embeddings + rag_local
- [ ] 4 providers, encrypted keys
- [ ] Auto-update check
- [ ] Tests green
- [ ] YaRN 32K→128K, scale ≥1