# Design: Rewrite llm-proxy as an Intelligent LLM Gateway

## Technical Approach

Replace the JS-only Express 5 proxy (index.js/server.js/pipelines.js/prompts.js + llama-swap binary) with a strict-TypeScript ESM modular gateway. Express 5 keeps routing; http-proxy-middleware does direct passthrough; a bespoke chain engine orchestrates virtual models. Config loads chains from JSON/YAML; zod validates payloads; errors normalize to OpenAI shape. **The `llama-server` backend is now a MANAGED internal process** (`src/backend/`) spawned/supervised/shutdown by the gateway in router mode — no external `host:port` assumption (softened prior approach: llama-server at `:8080` was treated as operator-run; backend-management makes llm-proxy own its lifecycle). Maps proposal Approach + addendum (TS estricto, estructura modular, zod).

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
| Backend lifecycle | External process (prior) vs managed spawn | Managed owns boot/supervision/shutdown + config-driven models; external leaves llama.cpp to operator | Managed `src/backend/manager.ts` (backend-management) |
| Model registration | `--models-dir` (A) vs generated preset INI (B) | A: simple, global ctx/temp only, naming=filename; B: per-model ctx/temp/args, aligned with "manage models/ctxs/args" | Generated preset INI (B) |
| Model swap | process-per-model (prior llama-swap) vs router autoload | Native router swap reuses GPU, on-demand; no manual process pool | Router `--models-preset` autoload |

**Why bespoke engine**: current logic is exactly `for stage → buildMessages → call → refeed`. A framework adds ~2 deps and an abstraction over 40 lines. **Why adapter**: isolates the llama-server/llama-swap API surface (spec proxy-pipeline risk) so future providers plug in behind one interface. **Why res.pipe()**: spec mandates unbuffered SSE; buffering breaks real-time streaming and reintroduces the ReferenceError class of bugs. **Why managed backend**: the end user "only defines chains in YAML" and never touches llama.cpp — llm-proxy owns spawn, supervision, router config, and shutdown (backend-management purpose). **Why preset INI (B) over --models-dir (A)**: chains name models by friendly id (e.g. `SmolLM3-3B`) and must pin per-model ctx/temp/args; a generated INI maps those ids to exact GGUF files and overrides, which `--models-dir` (global ctx/temp, filename=id) cannot express.

## Backend Management

### Config schema (extends `src/config/schema.ts`)

```
llama:
  binary: "llama"            # path or PATH lookup
  host: 127.0.0.1
  port: 8080                 # 0 => dynamic free port
  autoStart: true
  startupTimeoutMs: 30000
  stopTimeoutMs: 5000
  requestTimeoutMs: 300000
  modelsDir: "~/Models"      # GGUF directory ("" = must use explicit file paths)
  autoload: true             # false => --no-models-autoload
  router: {                  # global server args
    ctx: 8192, n: 2048, nGpuLayers: -1, flashAttn: true,
    cacheTypeK: "q8_0", cacheTypeV: "q8_0", batch: 2048,
    ubatch: 512, tools: "all", parallel: 1
  }
  models: [                  # record keyed by id = id chains reference
    { id: "SmolLM3-3B",   file: "SmolLM3-3B-Q4_K_M.gguf", ctx: 8192, temp: 0.7 },
    { id: "Qwen2.5-Coder-3B-Instruct", file: "qwen2.5-coder-3b-instruct-q4.gguf", args: "--n-gpu-layers 99" }
  ]
```

`modelsDir` resolves relative `file` names; absolute `file` paths are allowed and skip `modelsDir`. `port: 0` requests an OS-allocated ephemeral port, which the manager reads back from the spawned process — eliminating fixed-port collisions (a decision over hardcoding 8080 dynamic seed).

### Generated preset INI (`--models-preset`)

The manager renders config `models[]` to llama.cpp preset INI and writes it to `.llm-proxy/models.ini` (gitignored, resolved under config dir). Format:

```ini
[SmolLM3-3B]
url = file:///home/andy/Models/SmolLM3-3B-Q4_K_M.gguf
ctx_size = 8192
temp = 0.7

[Qwen2.5-Coder-3B-Instruct]
url = file:///home/andy/Models/qwen2.5-coder-3b-instruct-q4.gguf
ctx_size = 8192
temp = 0.7
--n-gpu-layers = 99
```

Global router args form the `[server]` section default; per-model keys override. The friendly `id` from config IS the preset section name, so a chain step's `model: SmolLM3-3B` maps 1:1 to the registered router id with no name normalization.

### `src/backend/manager.ts` — `LlamaServeManager`

```
class LlamaServeManager {
  start(): Promise<void>   // spawn + wait-ready; SuperviseRestart on unexpected exit
  stop(): Promise<void>    // SIGTERM → wait stopTimeoutMs → SIGKILL; no orphan
  status(): BackendStatus  // { state, pid, models: string[], baseUrl }
  // baseUrl = http://127.0.0.1:<port> (dynamic port read from proc)
}
```

- **start()**: validate binary exists (PATH or abs path), `modelsDir` + each GGUF exist (fail-fast, spec Req "Missing GGUF/Binary fails fast"); spawn `llama serve` with router args + `--models-dir <modelsDir>` (so the preset ids resolve) + `--models-preset <ini>` + autoload flag; poll `GET /health` (or `/v1/models`) until `startupTimeoutMs`; on timeout/exit-before-ready → throw actionable error.
- **Supervision**: on unexpected `exit`, backoff-restart (1s→2s→4s→cap 30s), never infinite-fast; if process was intentionally stopped via `stop()`, do not restart.
- **stop()**: graceful SIGTERM, wait `stopTimeoutMs`, SIGKILL fallback — mirrors old LlamaSwapManager shutdown.

### Boot integration (`src/index.ts`)

Load config → validate → create `LlamaServeManager` → **`await manager.start()` BEFORE `app.listen()`** (spec "readiness gate"). On start failure: clear message (missing binary / missing GGUF / never-ready) + `process.exit(1)`. Shutdown: `await manager.stop()` before process exit. Provider `baseUrl` comes from `manager.status().baseUrl`, not a static config host.

### Provider integration (`src/providers/llama-server.ts`)

The adapter's `baseUrl` reads from the manager (dynamic host/port) instead of `config.llamaServer.host:port`. The engine already injects `model: step.model` per step (preserved); the managed backend performs swap on demand by that field (no manual pool). Provider auto-discovers registered models from `manager.status().models` for `/v1/models` real-model listing (replacing the live-fetch fallback).

### Health endpoint (`src/routes/health.ts`)

Extend response to include `backend: manager.status()` → `{ state, pid, models }` (spec "Health reports managed backend state").

### Backend lifecycle (sequence)

```
Boot:  load config → manager.start():
         validate(binary, modelsDir, gguFs) → spawn llama serve --models-preset
         → wait-ready poll /v1/models → ready
       ── app.listen() (traffic gated on ready)
Request: client → engine → provider.chat(stream) → fetch /v1/chat/completions (model: step.model)
         → router autoloads model on demand → swap → response → res.pipe() → client
Shutdown: SIGINT/SIGTERM → manager.stop(): SIGTERM → wait → SIGKILL → exit
```

### Data flow (router with on-demand swap)

```
Client ── POST /v1/chat/completions (model gateway/<chain>)
  → [auth][zod][resolve chain] → engine runs steps sequentially
      step: payload.model = step.model  →  provider(manager.baseUrl) → llama-server router
             router: model not loaded? → autoload from preset INI
             → generate → refeed → … → lastStep (stream) → res.pipe() → client
Provider model (real, non-chain) → adapter directly to manager.baseUrl → router swap by model field
```

## Data Flow

```
Client ── POST /v1/chat/completions
  → [auth] → [zod validate] → [resolve target: model prefix|X-Chain-ID]
    ├─ provider model → http-proxy-middleware → manager.baseUrl (managed llama-server) → SSE pipe → client
    └─ gateway/<chain> or header chain → engine.runSteps():
        stepA (non-stream, 429 fallback / tool_calls route) → refeed context → … → lastStep → pipe → client
Errors → [errorHandler] → { error:{message,type,param,code} }
```

### Sequence: multi-step chain streaming (final step only streams)

```
Client   Engine            manager.baseUrl (llama-server router)
  │ POST gateway/thinker        │
  ├─ run stepA (stream:false, model:SmolLM3-3B) ─►│ autoload SmolLM3-3B
  │ ◄────── choices[0].message ─┤ → previousContent = extractContent
  ├─ stepB … lastStep (pipe, model:Qwen…) ─►│ router swaps on demand
  │ ◄────── SSE data:… [DONE] ──┤
  ├─ res.pipe() unbuffered ─────┘
  Client disconnect (res 'close') → AbortController.abort() → upstream aborted
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/server.ts` | Create | Creates Express app, mounts middleware+routes, error handler |
| `src/index.ts` | Modify | Boots config → `manager.start()` → app.listen; SIGINT/TERM `manager.stop()`; fail-fast exit |
| `src/backend/manager.ts` | **Create** | `LlamaServeManager`: spawn, wait-ready, supervised restart (backoff), graceful stop, status |
| `src/backend/preset.ts` | **Create** | Render config `models[]` → llama.cpp preset INI → write `.llm-proxy/models.ini` |
| `src/backend/validation.ts` | **Create** | Fail-fast checks: binary resolvable, modelsDir exists, each GGUF file exists |
| `src/config/index.ts`, `load.ts`, `schema.ts` | Modify | Add `llama`/`models`/`router` schemas; zod-typed backend config |
| `src/types/openai.ts` | Create | ChatCompletionRequest/Response/Chunk, ErrorResponse, Completion* interfaces |
| `src/types/chain.ts` | Create | Chain/Step interfaces |
| `src/types/zod.ts` | Create | zod schemas (chat, completion, model ref) |
| `src/routes/chat.ts`, `completions.ts`, `models.ts` | Create | /v1 endpoints; models lists manager-registered real models + virtual |
| `src/routes/health.ts` | Modify | Include `backend: manager.status()` (state/pid/models) |
| `src/middleware/auth.ts` | Create | Optional Bearer (BEARER_TOKEN) → 401 |
| `src/middleware/proxy.ts` | Create | http-proxy-middleware; target = manager.baseUrl; SSRF config-only |
| `src/middleware/errors.ts` | Create | Global error → OpenAI shape; guard headersSent |
| `src/orchestrator/engine.ts` | Create | Sequential runner; on_429 fallback; tool_calls_route; context refeed; stream-last |
| `src/orchestrator/parser.ts` | Create | Parse chain config → Step[], resolve providers; step `model` = registered router id |
| `src/providers/llama-server.ts` | Modify | `baseUrl` from manager (dynamic); models from `manager.status()`; existing chat/chatStream preserved |
| `src/providers/types.ts` | Create | `Provider` interface (isolation for future providers) |
| `src/utils/ids.ts`, `sanitize.ts`, `extract.ts` | Create | TS ports of micro.js helpers |
| `llm-proxy.config.yaml` | Modify | Chain schema + new `llama`/`llama.models`/`llama.router` sections; steps reference model ids |
| `.gitignore` | Modify | Ignore `.llm-proxy/` (generated preset) |
| `tsconfig.json` | Create | `strict:true`, module NodeNext, target ES2022 |
| `package.json` | Modify | `tsx` dev, `tsc` build, scripts; deps added (helmet, zod, http-proxy-middleware, dotenv); drop cors/llama-swap |
| `index.js`, `server.js`, `pipelines.js`, `prompts.js`, `llama-swap/`, `utils/` | Delete | Replaced by src/ |

## Interfaces / Contracts

```ts
// schema.ts additions
const modelConfigSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),          // name inside modelsDir OR absolute path
  ctx: z.number().int().positive().optional(),   // per-model override
  temp: z.number().optional(),                   // per-model override
  args: z.string().optional(),                   // extra CLI args per model
});
const routerConfigSchema = z.object({
  ctx: z.number().int().positive().default(8192),
  n: z.number().int().positive().default(2048),
  nGpuLayers: z.number().int().default(-1),
  flashAttn: z.boolean().default(true),
  cacheTypeK: z.string().default("q8_0"),
  cacheTypeV: z.string().default("q8_0"),
  batch: z.number().int().positive().default(2048),
  ubatch: z.number().int().positive().default(512),
  tools: z.string().default("all"),
  parallel: z.number().int().positive().default(1),
});
const llamaConfigSchema = z.object({
  binary: z.string().default("llama"),
  host: z.string().default("127.0.0.1"),
  port: z.union([z.literal(0), z.number().int().positive()]).default(8080),
  autoStart: z.boolean().default(true),
  startupTimeoutMs: z.number().int().positive().default(30000),
  stopTimeoutMs: z.number().int().positive().default(5000),
  requestTimeoutMs: z.number().int().positive().default(300000),
  modelsDir: z.string().default("~/Models"),
  autoload: z.boolean().default(true),
  router: routerConfigSchema.default({}),
  models: z.record(modelConfigSchema).default({}),   // id → model
});

// manager.ts
interface BackendStatus {
  state: "starting" | "running" | "stopped" | "error";
  pid: number | null;
  models: string[];          // registered router ids
  baseUrl: string;           // http://127.0.0.1:<dynamicPort>
}

// providers/llama-server.ts — baseUrl now sourced from manager
interface LlamaServerProviderDeps { getBaseUrl: () => string; models: () => string[]; }
// engine unchanged: payload.model = step.model (preserved)
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Build | `tsc --noEmit` strict | Success criterion; `npm run build` |
| Unit | parser, sanitize (NaN, dev→system, flatten), ids, extract, preset renderer | Smoke via tsx scripts |
| Unit | preset INI generation (model→section, ctx/temp/args), modelsDir resolution, dynamic port | tsx smoke: golden INI string |
| Integration | manager start/wait-ready with a stub health endpoint; supervised restart on killed child; graceful stop (no orphan) | Mock `llama` binary via spawnable stub in tests |
| Integration | routes → engine → adapter (mocked fetch using manager baseUrl) | Smoke: engine order, 429 fallback, tool_calls route, context refeed, model injected per step |
| Fail-fast | missing binary / missing GGUF / never-ready → actionable startup error, no listen | Smoke: bad config exits non-zero with clear message |
| E2E | 3 endpoints SSE + `[DONE]`, 404 unknown, error shape, X-Chain-ID, health reports backend state | Manual smoke (no runner, strict_tdd false) |

## Threat Matrix

Routing/proxy + **subprocess/process-integration** boundary — applicable. SSRF is the adversarial case: upstream target MUST come only from config/provider settings (spec gateway-security). New: the `llama` binary is an executable invoked as a subprocess.

| Boundary | Min cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Upstream URL authority | client-controlled field vs config-derived target | Applicable | middleware derives target from `manager.baseUrl`, never request body; zod strips unknown URL fields | Smoke: request with URL field routed to config host, not supplied value |
| Chain resolution | `model` prefix, `X-Chain-ID`, unknown chain | Applicable | orchestrator matches `gateway/<name>` or header; unknown → 404 | Smoke: unknown chain → `{error}` 404 |
| Binary path authority | PATH lookup, absolute path from config | Applicable | binary resolved only from `llama.binary` config; fail-fast if not found | Smoke: bad path → actionable startup error |
| Process supervision | unexpected exit → restart; SIGTERM → graceful stop | Applicable | backoff-restart capped; no restart after intentional stop; stop kills child (no orphan) | Smoke: kill child → restarted; stop() → process gone |
| Per-model file authority | `file` in modelsDir vs absolute path | Applicable | resolve relative under `modelsDir`; validate exists at boot | Smoke: missing GGUF → startup error naming file |

`N/A` rows (docs-like exec, git selection/commit/push, PR commands): no git/VCS/PR automation boundary in gateway.

## Migration / Rollout

Config gathers new `llama` (binary/models/router) section; existing `llamaServer.host:port` block is replaced by the managed backend (autoStart default true). Chain `model` values map 1:1 to new `models[].id` (existing chain config migrates verbatim if ids reuse current step model names). Generated `.llm-proxy/` preset is regenerated on each start (idempotent). Feature flag: none needed — `autoStart:false` preserves prior operator-run external-mode behavior. Revert = git revert/discard branch; old JS files intact until merge.

## Open Questions

- [ ] Confirm llama-server/proxy router's exact `--models-preset` INI syntax (section keys: `url`, `ctx_size`, `temp`, arg passthrough) — adapter in `preset.ts` isolates drift
- [ ] Confirm whether router `--models-preset` needs `--models-dir` alongside to resolve GGUF `url` files (assumed yes in design)
- [ ] Confirm http-proxy-middleware passthrough for non-chain provider models targets manager.baseUrl identically to engine steps
