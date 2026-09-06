/**
 * `loadGatewayConfig` normalization tests (multi-provider-pipelines, S2).
 *
 * Covers the config-load leg of "Named-provider targeting on llm_call": the
 * post-parse pass at src/config/index.ts injects the chain name from the
 * record key and fills `node.provider` from
 * `chain.provider ?? chain.defaultProvider ?? "llama-server"` for every node
 * that does not carry an explicit provider. The graph-engine leg (node.provider
 * -> map entry, no-provider -> first map entry) is covered by
 * graph-engine.test.ts "external provider resolution (4.2)" — these tests pin
 * the normalization BOTH of those legs rely on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { loadGatewayConfig } from "./index.js";

// Registry of file contents keyed by resolved path, fed by the fake Bun.file().
const mockFileContents: Record<string, string> = {};
// Registry of YAML parse results keyed by input text.
const mockYamlResults: Record<string, unknown> = {};

function fakeFile(exists: boolean, content: string) {
  return {
    exists: async () => exists,
    text: async () => content,
  };
}

function testDeps() {
  return {
    file: (p: string) =>
      fakeFile(mockFileContents[p] !== undefined, mockFileContents[p] ?? ""),
    yamlParse: (text: string) =>
      text in mockYamlResults ? mockYamlResults[text] : {},
  };
}

const originalConfigFile = process.env.CONFIG_FILE;

afterEach(() => {
  if (originalConfigFile === undefined) {
    delete process.env.CONFIG_FILE;
  } else {
    process.env.CONFIG_FILE = originalConfigFile;
  }
});

/** Register a config file + its raw parsed shape, then run loadGatewayConfig. */
async function loadConfig(raw: Record<string, unknown>): Promise<
  Awaited<ReturnType<typeof loadGatewayConfig>>
> {
  const path = "/cwd/chain-normalization.yaml";
  process.env.CONFIG_FILE = path;
  const yaml = `config ${Math.random()}`;
  mockFileContents[path] = yaml;
  mockYamlResults[yaml] = raw;
  return loadGatewayConfig(undefined, testDeps());
}

/** One llm_call node without a `provider` field (the default-provider target). */
function llmNode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "n1", type: "llm_call", model: "m1", ...extra };
}

describe("chain defaultProvider normalization (pipeline-orchestration S2)", () => {
  test("a node without provider resolves the chain defaultProvider (external provider)", async () => {
    const cfg = await loadConfig({
      chains: {
        thinker: {
          defaultProvider: "external-a",
          nodes: [llmNode()],
        },
      },
    });

    expect(cfg.chains["thinker"].name).toBe("thinker");
    expect(cfg.chains["thinker"].nodes[0].provider).toBe("external-a");
  });

  test("chain.provider takes precedence over chain.defaultProvider", async () => {
    const cfg = await loadConfig({
      chains: {
        thinker: {
          provider: "external-b",
          defaultProvider: "external-a",
          nodes: [llmNode()],
        },
      },
    });

    expect(cfg.chains["thinker"].nodes[0].provider).toBe("external-b");
  });

  test("no chain provider defaults keeps the local llama-server path", async () => {
    const cfg = await loadConfig({
      chains: {
        thinker: {
          nodes: [llmNode()],
        },
      },
    });

    expect(cfg.chains["thinker"].nodes[0].provider).toBe("llama-server");
  });

  test("an explicit node provider is never overwritten by the chain default", async () => {
    const cfg = await loadConfig({
      chains: {
        thinker: {
          defaultProvider: "external-b",
          nodes: [llmNode({ provider: "external-a" })],
        },
      },
    });

    expect(cfg.chains["thinker"].nodes[0].provider).toBe("external-a");
  });
});