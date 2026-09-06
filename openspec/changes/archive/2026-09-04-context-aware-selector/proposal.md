# Proposal: Context-Aware Selector

## Intent

The pipeline editor's context window selector shows hardcoded options (`CONTEXT_STANDARDS = [512, 1024, ..., 65536]`) regardless of model capabilities or hardware constraints. Users can select context sizes that exceed GGUF metadata limits or available RAM, causing OOM crashes. The `/api/ui/models` endpoint returns `ctx` from config defaults (65536) instead of parsing actual GGUF file metadata.

## Scope

### In Scope
- GGUF binary header parser to extract `general.context_length` from model files
- RAM heuristic using `os.totalmem()` to estimate safe context limits
- `/api/ui/models` response enrichment with `ggufContextLength` and `hardwareMaxCtx`
- UI context selector filtered by GGUF metadata and hardware limits
- Visual indicator when selected context exceeds safe range

### Out of Scope
- GPU VRAM detection (deferred — requires `nvidia-smi` platform-specific logic)
- GGUF metadata beyond `general.context_length` (future enhancement)
- Automatic context size selection (user retains control)

## Capabilities

### New Capabilities
- `gguf-metadata`: GGUF binary header parsing to extract model metadata (context_length, architecture, quantization)

### Modified Capabilities
- `dashboard-api`: `/api/ui/models` response includes GGUF metadata and hardware limits
- `dashboard-ui`: Context selector filters options based on GGUF metadata and hardware

## Approach

1. **Tier 1 — GGUF parsing**: New `src/utils/gguf.ts` module reads binary headers (magic bytes + version + metadata KV pairs) using Bun's `ArrayBuffer/DataView`. Extract `general.context_length` (UINT32 type tag = 4). Return parsed metadata or fallback to config default.
2. **Tier 2 — RAM heuristic**: `os.totalmem()` provides total system RAM. Heuristic: max safe context = `(availableRam - overhead) / bytesPerToken`. Simple ratio-based, no ML.
3. **API enrichment**: Extend `modelDetails()` in `src/index.ts` to call GGUF parser and hardware check. Return `{id, file, loaded, ggufContextLength, hardwareMaxCtx}`.
4. **UI filtering**: Replace `CONTEXT_STANDARDS` with dynamic list from API response. Highlight safe range visually.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/utils/gguf.ts` | New | GGUF binary header parser |
| `src/index.ts:174-180` | Modified | Wire GGUF parser into `modelDetails()` |
| `src/dashboard/router.ts:195-220` | Modified | Extend model list response schema |
| `src/dashboard/router.ts:64` | Modified | Update `DashboardRouterDeps.modelDetails` interface |
| `src/ui/app.js:477-520` | Modified | Replace `CONTEXT_STANDARDS` with dynamic filtering |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| GGUF format variations across model versions | Low | Follow official GGUF spec; test with llama.cpp, mistral, phi models |
| RAM heuristic inaccurate for systems with swap | Medium | Document heuristic limitations; allow manual override in UI |
| Binary parsing edge cases (corrupt files) | Low | Graceful fallback to config default on parse failure |

## Rollback Plan

1. Revert `src/utils/gguf.ts` (new file — delete)
2. Revert `modelDetails()` changes in `src/index.ts`
3. Revert UI filtering in `src/ui/app.js` to hardcoded `CONTEXT_STANDARDS`
4. Restore original `/api/ui/models` response schema
5. Run `bun run typecheck && bun test` to confirm clean state

## Dependencies

None — pure internal enhancement using Bun's built-in binary APIs and Node.js `os` module.

## Success Criteria

- [ ] GGUF parser extracts `general.context_length` from test model files
- [ ] `/api/ui/models` returns `ggufContextLength` and `hardwareMaxCtx`
- [ ] UI context selector shows only valid options for selected model
- [ ] OOM prevented when user tries to select oversized context
- [ ] Graceful fallback when GGUF parse fails (uses config default)
- [ ] `bun run typecheck && bun run lint && bun test` all pass