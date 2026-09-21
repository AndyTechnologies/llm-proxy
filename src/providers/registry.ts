/**
 * Provider registry (external-providers + gateway-security): builds the
 * external Provider adapters from the `providers` DB rows (source of truth
 * for kinds, base URLs and fallback links) plus the `models` table rows whose
 * source matches the provider kind. Keys are resolved once from the keychain
 * store (scope `provider:<kind>`); a provider without a stored key is marked
 * misconfigured — the DB column is synced and the adapter refuses calls with
 * ProviderMisconfiguredError instead of sending empty credentials.
 *
 * The managed llama-server backend is NOT built here: it lives behind the
 * backend manager and is added to the /v1 model list by the router.
 */
import type { Database } from "bun:sqlite";
import type { HttpFetcher } from "./http-core.js";
import { makeOpenAIAdapter } from "./adapter-openai.js";
import { makeAnthropicAdapter } from "./adapter-anthropic.js";
import { makeOpenRouterAdapter } from "./adapter-openrouter.js";
import type { ExternalProviderAdapter, ProviderKind } from "./adapters.js";

/** Provider kinds we build adapters for; `local` stays with the manager. */
const BUILT_KINDS: ReadonlyArray<ProviderKind> = ["openai", "anthropic", "openrouter"];

const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  local: "",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export interface ProviderRegistry {
  /** Adapters keyed by provider kind (external providers only). */
  adapters: Map<string, ExternalProviderAdapter>;
  get(kind: string): ExternalProviderAdapter | null;
}

export interface ProviderRegistryOptions {
  db: Database;
  /** Secret store: `get(scope)` resolves keychain-backed credentials. */
  store: { get(scope: string): Promise<string | null> };
  /** Injectable fetcher for tests; defaults to the global fetch. */
  fetcher?: HttpFetcher;
  /** Static per-kind headers, already `${ENV}`-interpolated by the caller. */
  headersByKind?: Record<string, Record<string, string>>;
}

/** Build the external provider adapters from the DB and keychain store. */
export async function buildProviderRegistry(
  opts: ProviderRegistryOptions,
): Promise<ProviderRegistry> {
  const { db, store } = opts;
  const rows = db
    .query(
      "SELECT kind, base_url, fallback_id FROM providers ORDER BY kind",
    )
    .all() as Array<{ kind: string; base_url: string | null; fallback_id: string | null }>;

  const adapters = new Map<string, ExternalProviderAdapter>();

  for (const row of rows) {
    const kind = row.kind as ProviderKind;
    if (!BUILT_KINDS.includes(kind)) continue;

    const models = (
      db
        .query("SELECT id FROM models WHERE source = ? ORDER BY id")
        .all(row.kind) as Array<{ id: string }>
    ).map((m) => m.id);

    const key = await store.get(`provider:${row.kind}`);
    const headers = opts.headersByKind?.[row.kind] ?? {};
    const common = {
      keyResolver: async () => key,
      headers,
      models,
      fallbackId: row.fallback_id,
      fetcher: opts.fetcher,
      misconfigured: key === null,
    } as const;

    let adapter: ExternalProviderAdapter;
    switch (kind) {
      case "openai":
        adapter = makeOpenAIAdapter({
          ...common,
          baseUrl: row.base_url ?? DEFAULT_BASE_URLS.openai,
        });
        break;
      case "anthropic":
        adapter = makeAnthropicAdapter({
          ...common,
          baseUrl: row.base_url ?? DEFAULT_BASE_URLS.anthropic,
        });
        break;
      case "openrouter":
        adapter = makeOpenRouterAdapter(common);
        break;
      default:
        continue;
    }

    db.query("UPDATE providers SET misconfigured = ? WHERE kind = ?").run(
      key === null ? 1 : 0,
      row.kind,
    );
    adapters.set(row.kind, adapter);
  }

  return {
    adapters,
    get(kind: string): ExternalProviderAdapter | null {
      return adapters.get(kind) ?? null;
    },
  };
}