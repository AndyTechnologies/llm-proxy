# Design: Context-Aware Selector

## Technical Approach

Replace the hardcoded `CONTEXT_STANDARDS` array with a two-tier dynamic system: (1) parse GGUF binary headers to extract `general.context_length` per model, (2) derive a hardware max context from system RAM. Both signals flow through the existing `modelDetails()` → `/api/ui/models` pipeline into the SPA, where the context editor filters options dynamically.

## Architecture Decisions

| Decision | Option | Tradeoff | Decision |
|----------|--------|----------|----------|
| GGUF parsing location | Standalone `src/utils/gguf.ts` | Fits existing utils pattern; no backend coupling | **Chosen** |
| RAM heuristic location | Function inside `gguf.ts` (exports `hardwareMaxCtx()`) | Keeps hardware logic in one module alongside GGUF parsing | **Chosen** |
| Caching strategy | None initially; parse on each model list request | GGUF headers are small (few KB); RAM check is fast `os.totalmem()`; caching adds complexity without measurable perf gain at dashboard request rates | **Chosen** (defer caching to future if profiling shows need) |
| UI filtering approach | Client-side: filter `CONTEXT_STANDARDS` at render time using API metadata | Server-side would couple rendering to backend; client-side keeps SPA independent and testable | **Chosen** |

## Data Flow

```
┌─────────────────┐    ┌──────────────────┐    ┌──────────────┐
│  GGUF file on   │    │  os.totalmem()   │    │              │
│  disk           │    │  os.freemem()    │    │              │
└────────┬────────┘    └────────┬─────────┘    │              │
         │                      │               │              │
         ▼                      ▼               │              │
   parseGgufHeader()     hardwareMaxCtx()       │              │
   → ggufContextLength   → integer              │              │
         │                      │               │              │
         └──────────┬───────────┘               │              │
                    ▼                           │              │
            modelDetails() in index.ts          │              │
            merges GGUF + HW into each entry    │              │
                    │                           │              │
                    ▼                           │              │
        GET /api/ui/models response             │              │
        {ggufContextLength, hardwareMaxCtx}     │              │
                    │                           │              │
                    ▼                           │              │
        state.models in SPA                     │              │
        (fetched on load + models:changed SSE)  │              │
                    │                           │              │
                    ▼                           ▼              │
        contextEditorHtml(node)                             │
        filters CONTEXT_STANDARDS by                         │
        min(ggufContextLength, hardwareMaxCtx)               │
        marks > hardwareMaxCtx as unsafe                     │
                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Module Design

### New: `src/utils/gguf.ts`

Exports:

```ts
interface GgufParseResult {
  ggufContextLength: number | null;
  architecture: string | null;
}

function parseGgufHeader(filePath: string): GgufParseResult;
// Reads first 256KB of file (sufficient for header).
// Validates magic 0x47475546 ("GGUF"), version, KV count.
// Scans metadata KV pairs for "general.context_length" (UINT32, tag=4).
// Returns { ggufContextLength, architecture } or nulls on any error.
// NEVER throws — all errors caught and returned as null fields.

function hardwareMaxCtx(bytesPerToken?: number): number;
// Reads os.totalmem(), reserves ~25% for OS/process overhead.
// Divides remaining by bytesPerToken (default 4 for fp32, heuristic).
// Returns positive integer floor-divided to nearest power-of-two boundary.
```

Binary parsing details:
- Read via `Bun.file(filePath).arrayBuffer()` (lazy, no full-file read)
- Validate magic: `DataView.getUint32(0, true) === 0x47475546`
- Read version (`getUint32(4, true)`), tensor_count (`getBigUint64(8, true)`), metadata_kv_count (`getBigUint64(16, true)`)
- Scan KV pairs starting at offset 24: read key length (uint64 LE), key bytes (UTF-8), type tag (uint32 LE), value based on tag
- For UINT32 (tag=4): value is `getUint32(offset, true)`
- For STRING (tag=8): length-prefixed UTF-8 bytes
- Stop scanning after `metadata_kv_count` entries or 256KB boundary

### Modified: `src/index.ts`

Extend `modelDetails()` wiring (line ~174) to call `parseGgufHeader()` and `hardwareMaxCtx()`:

```ts
modelDetails: () =>
  Object.entries(config.llama.models ?? {}).map(([id, m]) => {
    const filePath = path.join(config.llama.modelsDir, m.file);
    const gguf = parseGgufHeader(filePath);
    return {
      id,
      file: m.file,
      ctx: m.ctx,
      temp: m.temp,
      ggufContextLength: gguf.ggufContextLength,
      hardwareMaxCtx: hardwareMaxCtx(),
    };
  }),
```

Import `parseGgufHeader` and `hardwareMaxCtx` from `./utils/gguf.js`. Import `path` from `node:path`.

### Modified: `src/dashboard/router.ts`

Update `modelDetails()` return type in `DashboardRouterDeps`:

```ts
modelDetails: () => {
  id: string; file?: string; ctx?: number; temp?: number;
  ggufContextLength: number | null;
  hardwareMaxCtx: number;
}[];
```

Update the `GET /api/ui/models` response object construction (line ~201) to include the two new fields in each model entry.

### Modified: `src/ui/app.js`

Replace `CONTEXT_STANDARDS` usage in `contextEditorHtml()`:

```js
function contextEditorHtml(node) {
  const current = modelCtx(node.model);
  const override = node.params?.ctx;
  const model = state.models.find((m) => m.id === node.model);
  const ggufMax = model?.ggufContextLength;
  const hwMax = model?.hardwareMaxCtx;

  // Dynamic ceiling: prefer GGUF if present, else hardware, else no limit
  const effectiveMax = ggufMax != null
    ? (hwMax != null ? Math.min(ggufMax, hwMax) : ggufMax)
    : hwMax ?? null;

  // Filter standards to those <= effectiveMax, or show all if unknown
  const standards = (effectiveMax != null
    ? CONTEXT_STANDARDS.filter((c) => c <= effectiveMax)
    : CONTEXT_STANDARDS
  ).map((c) => String(c));

  // Options above hwMax (but within ggufMax) get an "unsafe" CSS class
  const isUnsafe = (val) => hwMax != null && val > hwMax;

  // ... rest of select build with isUnsafe class on <option> elements
}
```

The hardcoded `CONTEXT_STANDARDS` array remains as the master list but is filtered per-model at render time. Options exceeding `hardwareMaxCtx` get a dimmed/flagged CSS class (`ctx-unsafe`).

## Interfaces / Contracts

### Dashboard API response shape change

`GET /api/ui/models` response:

```ts
{
  models: Array<{
    id: string;
    file: string;
    loaded: boolean;
    ctx?: number;
    temp?: number;
    ggufContextLength: number | null;  // NEW
    hardwareMaxCtx: number;            // NEW
  }>;
  modelsDir: string;
  autoRefresh: boolean;
}
```

### gguf.ts public API

```ts
export interface GgufParseResult {
  ggufContextLength: number | null;
  architecture: string | null;
}

export function parseGgufHeader(filePath: string): GgufParseResult;
export function hardwareMaxCtx(bytesPerToken?: number): number;
```

## Error Handling

| Failure | Behavior |
|---------|----------|
| GGUF magic mismatch | Returns `ggufContextLength: null`, no exception |
| Truncated/corrupt metadata | Returns `ggufContextLength: null`, no exception |
| File not found / unreadable | Returns `ggufContextLength: null`, no exception |
| `os.totalmem()` unavailable | `hardwareMaxCtx()` returns `65536` (safe fallback matching `DEFAULT_CTX`) |
| API call fails | SPA keeps existing `CONTEXT_STANDARDS` fallback |

All errors in `parseGgufHeader` are caught internally. The function is designed as fail-null, never fail-throw.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit: `gguf.test.ts` | Valid GGUF parse, magic rejection, corrupt header, missing `context_length` key, architecture extraction | Fixture `.gguf` files (real header bytes crafted from spec); mock `Bun.file` for I/O error paths |
| Unit: `gguf.test.ts` | `hardwareMaxCtx` with known RAM values | Mock `os.totalmem()` and `os.freemem()` |
| Unit: `router.test.ts` | Models endpoint returns new fields | Existing test doubles extended with `ggufContextLength` and `hardwareMaxCtx` |
| Integration | `modelDetails()` enriches entries with GGUF + HW data | End-to-end with real `.gguf` fixture and mocked `os.totalmem` |
| UI | Context selector filters by effective max | Manual + snapshot test of `contextEditorHtml` output with mocked `state.models` |

## Threat Matrix

N/A — no routing, shell commands, subprocesses, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration required. The API response gains two new fields (`ggufContextLength`, `hardwareMaxCtx`) — additive, not breaking. The SPA gracefully handles missing fields (falls back to full `CONTEXT_STANDARDS` if metadata is absent).

## Open Questions

- [ ] Should `hardwareMaxCtx` account for currently loaded models' VRAM usage, or just total system RAM? Current design uses total RAM heuristic only.
- [ ] Should `parseGgufHeader` support reading from the watched models directory path, or require absolute paths? Current design assumes absolute path resolved by the caller.
- [ ] Bytes-per-token heuristic: 4 bytes (fp32) is conservative. Should this be configurable or derived from quantization metadata in the GGUF header?
