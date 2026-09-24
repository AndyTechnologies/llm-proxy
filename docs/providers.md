# Providers: the `Provider` contract

WeaveLLM isolates **all** model interaction — local and external — behind one
contract, `Provider` (`src/providers/types.ts`):

```ts
interface Provider {
  chat(request: Record<string, unknown>, chainName?: string): Promise<Record<string, unknown>>;
  chatStream(request: Record<string, unknown>, signal: AbortSignal): AsyncIterable<string>;
}
```

- `chat` returns the final completion object.
- `chatStream` yields **raw SSE `data:` payloads** (OpenAI-wire), and respects
  the caller's `AbortSignal` — the routes abort the upstream call when the
  client disconnects.
- The orchestrator, routes, and workflow engine only ever speak this
  interface. New providers plug in without touching them.

Related: [architecture.md](./architecture.md) (registry wiring),
[local-backend.md](./local-backend.md) (the local provider),
[workflows.md](./workflows.md) (providers inside `llm_call` nodes).

## Registry & kinds

`buildProviderRegistry` (`src/providers/registry.ts`) builds the adapter set
from the database:

- **`providers` rows** are the source of truth: `kind`, `base_url`,
  `fallback_id` (which provider is the fallback target).
- **`models` rows** declare the model ids each provider serves.
- Built-in kinds: `openai`, `anthropic`, `openrouter` (default base URLs
  `https://api.openai.com/v1`, `https://api.anthropic.com/v1`,
  `https://openrouter.ai/api/v1`; explicit `base_url` overrides).
- **The local backend is the `local` kind**: it answers through
  `hub.localProvider()` with the same contract, gated on readiness
  ([local-backend.md](./local-backend.md)).

## Keys: keychain-backed secrets

- Keys resolve **once** at registry build time from the keychain `SecretStore`
  (`src/secrets/keychain.ts`), scope `provider:<kind>`.
- The store encrypts secrets with AES-256-GCM; the SQLite `secrets` table only
  holds nonce + ciphertext. The master key lives in the OS keychain
  (`security` on macOS, `secret-tool` on Linux) — it is never on disk.
- A provider **without a stored key is marked `misconfigured`** and refuses
  calls (`ProviderMisconfiguredError`): it never sends empty credentials.
- The gateway auth key is the keychain secret scoped `auth`.
- Non-secret per-kind headers can be interpolated with `${ENV}` placeholders
  at registry build time; credentials never come from headers.

## Fallback chains

`chatWithFallback` / `chatStreamWithFallback`
(`src/providers/fallback.ts`) retry across linked providers:

- A chain follows `fallback_id` links up to **3 hops** (cycles are guarded by
  a visited set).
- Retryable errors only: **429, 5xx, and network failures**. A misconfigured
  provider is not retried.
- **Streaming never duplicates tokens:** chunks are buffered until the first
  "commit" chunk (real content or tool-call delta); only then are they
  flushed downstream. If the upstream fails *after* commit, the error is
  thrown — a fallback would duplicate already-emitted tokens. 429 fallback on
  a commit boundary just re-runs from the next provider with the un-emitted
  buffer dropped.

## Local provider

`LlamaServerProvider` (`src/providers/llama-server.ts`) wraps a started
backend: it POSTs to the manager's base URL (e.g. `http://127.0.0.1:<port>/v1/chat/completions`)
and translates status/content into the contract shape. Workflow chain
metadata (`__gatewayQuery`) is lifted into the URL query instead of the
payload.

## Embeddings

`makeLlamaEmbedder` (`src/providers/embeddings.ts`) exposes the
`Embedder` interface `{ model, embed(texts) }` over the local backend,
returning OpenAI embeddings shape. It serves `/v1/embeddings` once a model is
designated in `settings.embedding_model`; otherwise the route 404s
([api.md](./api.md)).

## Failure modes

| Scenario | Behavior |
| --- | --- |
| No stored key | `misconfigured` → refuses calls (`ProviderMisconfiguredError`) |
| 429 / 5xx / network error | Fallback chain (up to 3 hops), streaming before commit only |
| Local id not ready | `503` via hub gating ([local-backend.md](./local-backend.md)) |
| Unknown model | OpenAI unknown-model 404 envelope ([api.md](./api.md)) |

## Test seams

Adapters receive an injected `fetcher`, the fallback logic is unit-tested with
synthetic streams (`src/providers/fallback.test.ts`), and the registry is
tested against in-memory stores (`src/providers/registry.test.ts`).