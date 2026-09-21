import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import { SecretStore, type KeychainBackend } from "../secrets/keychain.js";
import { ProviderMisconfiguredError } from "./adapters.js";
import { buildProviderRegistry, type ProviderRegistry } from "./registry.js";

function memoryBackend(): KeychainBackend {
  const map = new Map<string, string>();
  return {
    async get() {
      return map.get("weavellm-master") ?? null;
    },
    async set(value: string) {
      map.set("weavellm-master", value);
    },
  };
}

async function makeRegistry(
  seed: (db: Database) => void,
  opts: { keys?: Record<string, string>; fetcher?: (url: string, init?: RequestInit) => Promise<Response> } = {},
): Promise<{ db: Database; registry: ProviderRegistry; store: SecretStore }> {
  const db = new Database(":memory:");
  applySchema(db);
  seed(db);
  const store = new SecretStore(db, memoryBackend());
  for (const [scope, value] of Object.entries(opts.keys ?? {})) {
    await store.set(scope, value);
  }
  const registry = await buildProviderRegistry({
    db,
    store,
    fetcher: opts.fetcher,
  });
  return { db, registry, store };
}

function seedProviders(
  db: Database,
  rows: Array<[kind: string, baseUrl: string | null, fallbackId: string | null]>,
): void {
  for (const [kind, baseUrl, fallbackId] of rows) {
    db.query(
      "INSERT INTO providers (kind, base_url, fallback_id) VALUES (?, ?, ?)",
    ).run(kind, baseUrl, fallbackId);
  }
}

function seedModels(db: Database, rows: Array<[id: string, source: string]>): void {
  for (const [id, source] of rows) {
    db.query(
      "INSERT INTO models (id, source, name, url, state) VALUES (?, ?, ?, ?, 'ready')",
    ).run(id, source, id, "");
  }
}

describe("buildProviderRegistry — adapters from providers rows", () => {
  test("builds one adapter per external provider with its sourced models", async () => {
    const { registry } = await makeRegistry((db) => {
      seedProviders(db, [
        ["openai", null, null],
        ["anthropic", "https://custom.example/v1", null],
        ["openrouter", null, null],
      ]);
      seedModels(db, [
        ["gpt-4o", "openai"],
        ["gpt-4o-mini", "openai"],
        ["claude-sonnet-4-5", "anthropic"],
        ["deepseek/deepseek-chat", "openrouter"],
        ["local-model", "local"],
      ]);
    });

    const openai = registry.get("openai");
    expect(openai?.kind).toBe("openai");
    expect(openai?.models).toEqual(["gpt-4o", "gpt-4o-mini"]);

    const anthropic = registry.get("anthropic");
    expect(anthropic?.kind).toBe("anthropic");
    expect(anthropic?.models).toEqual(["claude-sonnet-4-5"]);
    expect(anthropic?.fallbackId).toBeNull();

    expect(registry.get("openrouter")?.models).toEqual(["deepseek/deepseek-chat"]);
    // local-source models are not assigned to an external provider
    expect(registry.get("local")).toBeNull();
  });

  test("custom base_url overrides the provider default and fallback_id is wired", async () => {
    const seenUrls: string[] = [];
    const { registry } = await makeRegistry((db) => {
      seedProviders(db, [["openai", "https://gate.local/v1", "anthropic"]]);
      seedModels(db, [["gpt-4o", "openai"]]);
    }, {
      keys: { "provider:openai": "sk-test-1" },
      fetcher: (url) => {
        seenUrls.push(url);
        return Promise.resolve(Response.json({}, { status: 200 }));
      },
    });

    const openai = registry.get("openai");
    expect(openai).not.toBeNull();
    expect(openai?.fallbackId).toBe("anthropic");
    await openai?.chat({ model: "gpt-4o", messages: [] });
    expect(seenUrls[0]).toBe("https://gate.local/v1/chat/completions");
  });

  test("missing key marks the provider misconfigured and calls refuse", async () => {
    const { db, registry } = await makeRegistry((db) => {
      seedProviders(db, [["openai", null, null]]);
      seedModels(db, [["gpt-4o", "openai"]]);
    }, {
      fetcher: () => {
        throw new Error("upstream must not be called");
      },
    });

    const openai = registry.get("openai");
    expect(openai?.misconfigured).toBe(true);
    await expect(
      openai?.chat({ model: "gpt-4o", messages: [] }),
    ).rejects.toThrow(ProviderMisconfiguredError);

    const row = db
      .query("SELECT misconfigured FROM providers WHERE kind = 'openai'")
      .get() as { misconfigured: number };
    expect(row.misconfigured).toBe(1);
  });

  test("stored key resolves into the Authorization bearer header", async () => {
    const seen: { auth: string | null } = { auth: null };
    const { registry } = await makeRegistry((db) => {
      seedProviders(db, [["openai", null, null]]);
      seedModels(db, [["gpt-4o", "openai"]]);
    }, {
      keys: { "provider:openai": "sk-abc-42" },
      fetcher: (_url, init) => {
        seen.auth = new Headers(init?.headers).get("authorization");
        return Promise.resolve(Response.json({}, { status: 200 }));
      },
    });

    const openai = registry.get("openai");
    expect(openai?.misconfigured).toBe(false);
    await openai?.chat({ model: "gpt-4o", messages: [] });
    expect(seen.auth).toBe("Bearer sk-abc-42");
  });

  test("unknown provider kinds are ignored", async () => {
    const { registry } = await makeRegistry((db) => {
      seedProviders(db, [
        ["local", null, null],
        ["nonsense", null, null],
      ]);
    });
    expect(registry.get("local")).toBeNull();
    expect(registry.get("nonsense")).toBeNull();
  });
});