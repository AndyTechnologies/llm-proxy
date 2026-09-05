/**
 * Unit tests for the Agents feature pure helpers (agent-config.ts).
 *
 * These tests never touch the real user configs: patch/probe functions run
 * on in-memory objects, and `writeJsonAtomic` is exercised against temp dirs
 * only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  expandHome,
  gatewayModels,
  opencodeConfigKey,
  opencodeProviderStatus,
  patchOpenCode,
  patchPi,
  piProviderStatus,
  writeJsonAtomic,
  DEFAULT_LIMITS,
} from "./agent-config.js";
import type { ModelLimits } from "./agent-config.js";

/** Sample /v1/models payload: 2 gateway models + real backend models. */
const MODELS = {
  data: [
    {
      id: "gateway/orchestrator",
      object: "model",
      created: 1,
      owned_by: "gateway",
      description: "Orchestrator Pipeline",
    },
    { id: "gateway/thinker", object: "model", created: 1, owned_by: "gateway" },
    { id: "llama-3.1-8b.gguf", object: "model", created: 1, owned_by: "llama-server" },
  ],
};

/** Same limits for every model (the common "one backend" case). */
function sameLimits(context: number, output: number): Record<string, ModelLimits> {
  return {
    "gateway/orchestrator": { context, output },
    "gateway/thinker": { context, output },
  };
}

describe("gatewayModels", () => {
  test("keeps only ids prefixed with gateway/", () => {
    const kept = gatewayModels(MODELS);
    expect(kept.map((m) => m.id)).toEqual(["gateway/orchestrator", "gateway/thinker"]);
  });

  test("returns [] when nothing matches", () => {
    expect(gatewayModels({ data: [{ id: "llama-3.1-8b.gguf" }] })).toEqual([]);
  });
});

describe("opencodeConfigKey", () => {
  test("detects legacy providers key", () => {
    expect(opencodeConfigKey({ providers: {} })).toBe("providers");
  });

  test("detects singular provider", () => {
    expect(opencodeConfigKey({ provider: {} })).toBe("provider");
  });

  test("prefers singular provider when both exist", () => {
    expect(opencodeConfigKey({ provider: {}, providers: {} })).toBe("provider");
  });

  test("defaults to provider when neither exists", () => {
    expect(opencodeConfigKey({ other: 1 })).toBe("provider");
    expect(opencodeConfigKey({})).toBe("provider");
  });
});

describe("patchOpenCode", () => {
  test("preserves unrelated keys and rebuilds provider models", () => {
    const config = {
      $schema: "https://opencode.ai/config.json",
      agent: { keep: true },
      mcp: { servers: {} },
      providers: {
        "other-provider": { name: "Other" },
        "llm-proxy": { name: "old" },
      },
      share: "off",
    };
    const patched = patchOpenCode(config, gatewayModels(MODELS), "no-key", "http://localhost:8090/v1", sameLimits(8192, 2048));

    // Unrelated keys preserved by value.
    expect(patched.$schema).toBe(config.$schema);
    expect(patched.agent).toEqual({ keep: true });
    expect(patched.share).toBe("off");
    expect(patched.mcp).toEqual({ servers: {} });
    // Other providers untouched; llm-proxy rebuilt.
    expect((patched.providers as Record<string, unknown>)["other-provider"]).toEqual({ name: "Other" });

    const entry = (patched.providers as Record<string, unknown>)["llm-proxy"] as Record<string, unknown>;
    expect(entry.name).toBe("LLM-Proxy");
    expect(entry.npm).toBe("@ai-sdk/openai-compatible");
    expect(entry.options).toEqual({ apiKey: "no-key", baseURL: "http://localhost:8090/v1" });
    expect(entry.models).toEqual({
      "gateway/orchestrator": { limits: { context: 8192, output: 2048 } },
      "gateway/thinker": { limits: { context: 8192, output: 2048 } },
    });
  });

  test("writes the real backend limits into every opencode model", () => {
    const config = { provider: {} };
    const patched = patchOpenCode(config, gatewayModels(MODELS), "k", "http://localhost:8090/v1", sameLimits(4096, 512));
    const models = (patched.provider as Record<string, unknown>)["llm-proxy"] as {
      models: Record<string, unknown>;
    };
    expect(models.models["gateway/orchestrator"]).toEqual({ limits: { context: 4096, output: 512 } });
    expect(models.models["gateway/thinker"]).toEqual({ limits: { context: 4096, output: 512 } });
  });

  test("does not mutate the input config", () => {
    const config = {
      providers: {
        "llm-proxy": { name: "old", models: { "gateway/stale": {} } },
      },
    };
    patchOpenCode(config, gatewayModels(MODELS), "no-key", "http://localhost:8090/v1", sameLimits(8192, 2048));
    expect(config.providers).toEqual({
      "llm-proxy": { name: "old", models: { "gateway/stale": {} } },
    });
  });

  test("patches the singular provider key when the file uses it", () => {
    const config = { provider: { legacy: {} } };
    const patched = patchOpenCode(config, gatewayModels(MODELS), "k", "http://localhost:8090/v1", sameLimits(8192, 2048));
    expect(Object.keys(patched)).toEqual(["provider"]);
    const entry = (patched.provider as Record<string, unknown>)["llm-proxy"] as Record<string, unknown>;
    expect(Object.keys(entry.models as Record<string, unknown>)).toEqual([
      "gateway/orchestrator",
      "gateway/thinker",
    ]);
  });

  test("creates the provider key when the file has none", () => {
    const patched = patchOpenCode({ foo: "bar" }, gatewayModels(MODELS), "no-key", "http://localhost:8090/v1", sameLimits(8192, 2048));
    expect(patched.foo).toBe("bar");
    expect(patched.provider).toBeDefined();
  });

  test("writes per-model limits, falling back to DEFAULT_LIMITS for unknown ids", () => {
    const config = { provider: {} };
    const patched = patchOpenCode(config, gatewayModels(MODELS), "k", "u", {
      "gateway/orchestrator": { context: 12000, output: 3000 },
    });
    const models = (patched.provider as Record<string, unknown>)["llm-proxy"] as {
      models: Record<string, unknown>;
    };
    expect(models.models["gateway/orchestrator"]).toEqual({
      limits: { context: 12000, output: 3000 },
    });
    expect(models.models["gateway/thinker"]).toEqual({
      limits: { context: DEFAULT_LIMITS.context, output: DEFAULT_LIMITS.output },
    });
  });
});

describe("patchPi", () => {
  test("preserves unrelated keys and rebuilds the models array", () => {
    const config = {
      providers: {
        "llm-proxy": { apiKey: "stale" },
        "other-provider": { api: "x" },
      },
      settings: { theme: "dark" },
    };
    const patched = patchPi(config, gatewayModels(MODELS), "sk-local", "http://localhost:8090/v1", sameLimits(8192, 2048));

    expect(patched.settings).toEqual({ theme: "dark" });
    const providers = patched.providers as Record<string, unknown>;
    expect(providers["other-provider"]).toEqual({ api: "x" });

    const entry = providers["llm-proxy"] as Record<string, unknown>;
    expect(entry.baseUrl).toBe("http://localhost:8090/v1");
    expect(entry.api).toBe("openai-completions");
    expect(entry.apiKey).toBe("sk-local");
    expect(entry.models).toEqual([
      {
        id: "orchestrator",
        name: "Orchestrator Pipeline",
        reasoning: true,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 2048,
      },
      {
        id: "thinker",
        name: "gateway/thinker", // no description → falls back to the full id
        reasoning: true,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 2048,
      },
    ]);
  });

  test("writes the real backend limits into every pi model", () => {
    const config = { providers: {} };
    const patched = patchPi(config, gatewayModels(MODELS), "sk-local", "http://localhost:8090/v1", sameLimits(4096, 512));
    const models = (patched.providers as Record<string, unknown>)["llm-proxy"] as {
      models: Array<Record<string, unknown>>;
    };
    expect(models.models[0]).toMatchObject({ id: "orchestrator", contextWindow: 4096, maxTokens: 512 });
  });

  test("writes per-model limits into each pi model", () => {
    const config = { providers: {} };
    const patched = patchPi(config, gatewayModels(MODELS), "sk-local", "u", {
      "gateway/orchestrator": { context: 16384, output: 4096 },
    });
    const models = (patched.providers as Record<string, unknown>)["llm-proxy"] as {
      models: Array<Record<string, unknown>>;
    };
    expect(models.models[0]).toMatchObject({ id: "orchestrator", contextWindow: 16384, maxTokens: 4096 });
    expect(models.models[1]).toMatchObject({
      id: "thinker",
      contextWindow: DEFAULT_LIMITS.context,
      maxTokens: DEFAULT_LIMITS.output,
    });
  });

  test("does not mutate the input config", () => {
    const config = { providers: { "llm-proxy": { apiKey: "old" } }, top: true };
    patchPi(config, gatewayModels(MODELS), "sk-local", "http://localhost:8090/v1", sameLimits(8192, 2048));
    expect(config).toEqual({ providers: { "llm-proxy": { apiKey: "old" } }, top: true });
  });
});

describe("provider status probes", () => {
  test("opencodeProviderStatus counts configured gateway models", () => {
    const config = {
      providers: { "llm-proxy": { models: { "gateway/a": {}, "gateway/b": {} } } },
    };
    expect(opencodeProviderStatus(config)).toEqual({ providerPresent: true, modelCount: 2 });
  });

  test("opencodeProviderStatus reports absent / empty states", () => {
    expect(opencodeProviderStatus({})).toEqual({ providerPresent: false, modelCount: 0 });
    expect(opencodeProviderStatus({ providers: {} })).toEqual({ providerPresent: false, modelCount: 0 });
    expect(opencodeProviderStatus({ providers: { "llm-proxy": { name: "x" } } })).toEqual({
      providerPresent: true,
      modelCount: 0,
    });
  });

  test("piProviderStatus counts the models array", () => {
    const config = {
      providers: { "llm-proxy": { models: [{ id: "a" }, { id: "b" }, { id: "c" }] } },
    };
    expect(piProviderStatus(config)).toEqual({ providerPresent: true, modelCount: 3 });
  });

  test("piProviderStatus reports absent / empty states", () => {
    expect(piProviderStatus({})).toEqual({ providerPresent: false, modelCount: 0 });
    expect(piProviderStatus({ providers: {} })).toEqual({ providerPresent: false, modelCount: 0 });
  });
});

describe("expandHome", () => {
  test("expands a leading ~/", () => {
    expect(expandHome("~/x/y.json")).toBe(path.join(homedir(), "x/y.json"));
  });

  test("expands a bare ~", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  test("leaves absolute and relative paths untouched", () => {
    expect(expandHome("/etc/hosts")).toBe("/etc/hosts");
    expect(expandHome("./config.json")).toBe("./config.json");
  });
});

describe("writeJsonAtomic", () => {
  test("writes the file and backs up the previous content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agents-test-"));
    try {
      const filePath = path.join(dir, "opencode.json");
      await writeFile(filePath, JSON.stringify({ v: 1 }));

      const { backupPath } = writeJsonAtomic(filePath, { v: 2 });

      expect(backupPath).toBe(`${filePath}.bak`);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ v: 2 });
      expect(JSON.parse(await readFile(backupPath, "utf8"))).toEqual({ v: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes without a backup when the file does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agents-test-"));
    try {
      const filePath = path.join(dir, "nested", "models.json");
      const { backupPath } = writeJsonAtomic(filePath, { providers: {} });

      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ providers: {} });
      await expect(access(backupPath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});