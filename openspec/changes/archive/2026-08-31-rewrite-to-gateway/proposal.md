# Proposal: Rewrite llm-proxy as an Intelligent LLM Gateway

## Intent

llm-proxy is a JS-only Express 5 proxy hardcoding `generate`/`refine` pipelines toward a llama-swap (Go) binary. Users need a configurable, strict-TypeScript, OpenAI-compatible gateway orchestrating model chains against the native `llama server` API — dropping the llama-swap binary and the hand-rolled JS bugs (e.g. broken `v1/completions` streaming ReferenceError).

## Scope

### In Scope
- JS → strict TS; interfaces for all OpenAI requests/responses.
- Modular tree: `server.ts`, `routes/`, `middleware/` (auth, proxy, errors), `orchestrator/` (engine, parser), `providers/` (llama-server), `config/`.
- Drop llama-swap; proxy to `llama server` at `:8080` via http-proxy-middleware.
- Configurable engine: sequential steps + conditional logic (429 fallback, tool_calls routing); JSON/YAML; context between steps.
- OpenAI compat: `/v1/chat/completions`, `/v1/completions`, `/v1/models`; SSE via `res.pipe()` + `[DONE]`; OpenAI-shaped errors.
- Agentic: pipelines as virtual models; invoke via `model` (`gateway/<chain>`) or `X-Chain-ID`.
- Security: helmet, optional Bearer auth, zod validation, SSRF guard.
- Migrate pipelines `orchestrator`, `thinker`, `coder`, `verifier` to new chain format (adds `passthrough`); preserve multi-stage reasoning.

### Out of Scope
- Model/process management (llama-server owns loading).
- LangChain; Mastra unused — bespoke minimal engine.
- A test runner (strict_tdd false; verify via smoke tests).

## Capabilities

### New Capabilities
- `gateway-api`: OpenAI endpoints, SSE streaming, error normalization.
- `pipeline-orchestration`: configurable chain engine, conditional steps, context passing.
- `virtual-model-routing`: pipelines as virtual models; model/X-Chain-ID invocation.
- `gateway-security`: helmet, Bearer auth, zod validation, SSRF guard.

### Modified Capabilities
- `proxy-pipeline`: re-scoped from hardcoded llama-swap orchestration to configurable engine toward llama-server.
- Removed: llama-swap process management.

## Approach

Express 5 TS/ESM. Zod-validated payloads → orchestrator resolves chain (by model prefix or header) → engine runs steps sequentially, refeeding context, applying 429 fallback and tool_calls routing → llama-server adapter at `:8080` → SSE streamed via `res.pipe()` unbuffered → errors normalized to OpenAI shape. Config from JSON/YAML.

## Affected Areas

- Removed: `index.js`, `server.js`, `pipelines.js`, `prompts.js`, `llama-swap/`, `utils/`
- New: `src/` (modular TS tree), `providers/llama-server.ts`
- Modified: `llm-proxy.config.yaml` (new chain schema: stages, conditional)

## Risks

- llama-server API differs from llama-swap (Med) → adapter isolates surface; smoke-test
- SSE streaming regressions (Med) → `res.pipe()` unbuffered keeps JSON intact
- Chain migration loses reasoning fidelity (Med) → migrate verbatim; smoke-test

## Rollback Plan

Full rewrite on its own branch/PR chain. Revert = `git revert` of merged PRs or discard branch; old `index.js`/config intact until merge. Low coupling.

## Dependencies

- Runtime: `express`, `http-proxy-middleware`, `helmet`, `zod`, `dotenv`
- Dev: `typescript`, `tsx`, `@types/express`, `@types/node`
- Minimal set; drop `cors` (helmet) and the llama-swap binary.

## Success Criteria

- [ ] `tsc --noEmit` passes with `strict: true`
- [ ] All four existing pipelines run end-to-end via the new chain engine (smoke test)
- [ ] All three OpenAI endpoints stream clean, `[DONE]` terminated
- [ ] Virtual-model invocation via `model` prefix and `X-Chain-ID` both work
- [ ] No llama-swap binary referenced anywhere
