# Design: Rewrite llm-proxy as an Intelligent LLM Gateway

## Technical Approach

Replace the JS-only Express 5 proxy (index.js/server.js/pipelines.js/prompts.js + llama-swap binary) with a strict-TypeScript ESM modular gateway. Express 5 keeps routing; http-proxy-middleware does direct passthrough; a bespoke chain engine orchestrates virtual models. Config loads chains from JSON/YAML; zod validates payloads; errors normalize to OpenAI shape. llama-server at `:8080` replaces llama-swap (process management dropped). Maps proposal Approach + addendum (TS estricto, estructura modular, zod).

## Architecture Decisions

| Decision | Options | Tradeoff | Chosen |
|---|---|---|---|
| Engine | Mastra/LangChain vs bespoke | Frameworks add deps + abstraction; needs are 2 conditionals (429, tool_calls) + sequential steps | Bespoke `orchestrator/` (addendum #6, out-of-scope) |
| Provider access | Direct fetch per module vs adapter interface | Direct duplicates base URL/SSE/error handling; adapter isolates llama-server API drift (risk) | `providers/llama-server.ts` adapter |
| Streaming | Buffer+parse vs passthrough | Buffering stores whole payload (memory, latency); spec fixes `res.pipe()` unbuffered + `[DONE]` | `res.pipe()` unbuffered direct |
| Passthrough vs chain | http-proxy-middleware vs custom proxy | Middleware handles SSE/abort for single-hop; engine owns multi-step | middleware for direct, engine for chains |
| Config | js-yaml only vs js-yaml+json | Spec: "JSON or YAML" | js-yaml for `.yaml`, `JSON.parse` for `.json` |
| Auth | Always-on vs optional | BEARER_TOKEN env decides (spec gateway-security) | Optional Bearer middleware |
| Payload validation | Manual (current) vs zod | zod formalizes schemas, rejects before proxy (spec) | zod schemas in `types/` |

**Why bespoke engine**: current logic is exactly `for stage → buildMessages → call → refeed`. A framework adds ~2 deps and an abstraction over 40 lines. **Why adapter**: isolates the llama-server/llama-swap API surface (spec proxy-pipeline risk) so future providers plug in behind one interface. **Why res.pipe()**: spec mandates unbuffered SSE; buffering breaks real-time streaming and reintroduces the ReferenceError class of bugs.

## Data Flow

```
Client ── POST /v1/chat/completions
  → [auth] → [zod validate] → [resolve target: model prefix|X-Chain-ID]
    ├─ provider model → http-proxy-middleware → llama-server:8080 → SSE pipe → client
    └─ gateway/<chain> or header chain → engine.runSteps():
        stepA (non-stream, 429 fallback / tool_calls route) → refeed context → … → lastStep → pipe → client
Errors → [errorHandler] → { error:{message,type,param,code} }
```

### Sequence: multi-step chain streaming (final step only streams)

```
Client   Engine            llama-server:8080
  │ POST gateway/thinker        │
  ├─ run stepA (stream:false) ─►│
  │ ◄────── choices[0].message ─┤ → previousContent = extractContent
  ├─ stepB … lastStep (pipe) ─► │
  │ ◄────── SSE data:… [DONE] ──┤
  ├─ res.pipe() unbuffered ─────┘
  Client disconnect (res 'close') → AbortController.abort() → upstream aborted
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/server.ts` | Create | Creates Express app, mounts middleware+routes, error handler |
| `src/index.ts` | Create | Boots config → app → listen; SIGINT/TERM shutdown; no llama-swap |
| `src/config/index.ts`, `src/config/load.ts`, `src/config/schema.ts` | Create | Load JSON/YAML, `llamaServer` (host:8080) replaces `llamaSwap`; zod-typed config |
| `src/types/openai.ts` | Create | ChatCompletionRequest/Response/Chunk, ErrorResponse, Completion* interfaces |
| `src/types/chain.ts` | Create | Chain/Step interfaces |
| `src/types/zod.ts` | Create | zod schemas (chat, completion, model ref) |
| `src/routes/chat.ts`, `completions.ts`, `models.ts` | Create | /v1 endpoints; chat+completions normalize payload |
| `src/middleware/auth.ts` | Create | Optional Bearer (BEARER_TOKEN) → 401 |
| `src/middleware/proxy.ts` | Create | http-proxy-middleware; SSRF config-only target |
| `src/middleware/errors.ts` | Create | Global error → OpenAI shape; guard headersSent |
| `src/orchestrator/engine.ts` | Create | Sequential runner; on_429 fallback; tool_calls_route; context refeed; stream-last |
| `src/orchestrator/parser.ts` | Create | Parse chain config → Step[], resolve providers |
| `src/providers/llama-server.ts` | Create | Adapter: `chat()`, `chatStream()`, normalize; developer→system, flatten array, finiteNumber |
| `src/providers/types.ts` | Create | `Provider` interface (isolation for future providers) |
| `src/utils/ids.ts`, `sanitize.ts`, `extract.ts` | Create | TS ports of micro.js helpers |
| `llm-proxy.config.yaml` | Modify | New chain schema: steps w/ `on_429`, `tool_calls_route`, `passthrough`; remove llamaSwap |
| `tsconfig.json` | Create | `strict:true`, module NodeNext, target ES2022 |
| `package.json` | Modify | `tsx` dev, `tsc` build, scripts; deps added (helmet, zod, http-proxy-middleware, dotenv); drop cors/llama-swap |
| `index.js`, `server.js`, `pipelines.js`, `prompts.js`, `llama-swap/`, `utils/` | Delete | Replaced by src/ |

## Interfaces / Contracts

```ts
interface ChatMessage { role: "system"|"user"|"assistant"|"developer"; content: string|Part[] }
interface ChatCompletionRequest { model: string; messages: ChatMessage[]; stream?: boolean; temperature?: number; top_p?: number; max_tokens?: number; tool_calls?: ... }
interface Choice { index: number; message: { role: string; content?: string|string[]; tool_calls?: ToolCall[] }; finish_reason: string|null }
interface ChatCompletionResponse { id: string; object: "chat.completion"; created: number; model: string; choices: Choice[]; usage?: Usage }
interface ChatCompletionChunk { id: string; object: "chat.completion.chunk"; created: number; model: string; choices: { index:number; delta: Partial<Message>; finish_reason: string|null }[] }
interface ErrorResponse { error: { message: string; type: string; param: string|null; code: string|null } }

interface Step { type: "generate"|"refine"|"passthrough"; provider: string; model: string; system?: string; assistant?: string; user?: string; on_429?: string; tool_calls_route?: string }
interface Chain { name: string; displayName?: string; steps: Step[] }
interface Provider { chat(req: unknown): Promise<unknown>; chatStream(req: unknown, signal: AbortSignal): AsyncIterable<string> }
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Build | `tsc --noEmit` strict | Success criterion; `npm run build` |
| Unit | parser, sanitize (NaN, dev→system, flatten), ids, extract | Smoke via tsx scripts |
| Integration | routes → engine → adapter (mocked fetch) | Smoke: engine order, 429 fallback, tool_calls route, context refeed |
| E2E | 3 endpoints SSE + `[DONE]`, 404 unknown, error shape, X-Chain-ID | Manual smoke (no runner, strict_tdd false) |

## Threat Matrix

Routing/proxy boundary — applicable. SSRF is the adversarial case: upstream target MUST come only from config/provider settings (spec gateway-security).

| Boundary | Min cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Upstream URL authority | client-controlled field vs config-derived target | Applicable | middleware derives target from `config.llamaServer`, never request body; zod strips unknown URL fields | Smoke: request with URL field routed to config host, not supplied value |
| Chain resolution | `model` prefix, `X-Chain-ID`, unknown chain | Applicable | orchestrator matches `gateway/<name>` or header; unknown → 404 | Smoke: unknown chain → `{error}` 404 |

`N/A` rows (docs-like exec, git selection/commit/push, PR commands): no shell/VCS/exec-file boundary in this gateway rewrite — out of scope.

## Migration / Rollout

Full rewrite on own branch/PR chain; drop-in binary `llm-proxy` preserved. `CONFIG_FILE` env honored. llama-server must be reachable at `:8080` (operator-run, not managed). Chain config for `orchestrator/thinker/coder/verifier` migrated verbatim to new step schema (generate/refine/passthrough). Revert = git revert/discard branch; old JS files intact until merge.

## Open Questions

- [ ] Confirm llama-server `/v1/models` shape for real-model listing (adapter isolates if differs)
- [ ] tool_calls passthrough from intermediate steps to a real tool runner is only routed, not executed (in-scope limit) — confirm
