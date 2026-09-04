/**
 * Config loader tests (strict TDD).
 *
 * Covers the config-load capability: Bun-native YAML/JSON parsing via
 * `Bun.file(path).text()` + `Bun.YAML.parse`, non-object rejection,
 * missing-file failure, CONFIG_FILE env honoring, zod validation, and the
 * .env precedence contract (process env wins once dotenv loading is removed).
 *
 * Mocking strategy: per ADR-3, the loader's file/YAML primitives are injected
 * via LoaderDeps (default real Bun). Runtime fact (verified 2026-09-01):
 * `mock.module("bun")` cannot intercept the builtin bun module in Bun 1.4.0,
 * so these unit tests inject fakes instead — no filesystem, no bun-module mock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { loadRawConfig, type LoaderDeps } from "./load.js";
import { loadGatewayConfig, DEFAULT_CONFIG_FILE } from "./index.js";

/** Registry of file contents keyed by resolved path, fed by the fake Bun.file(). */
const mockFileContents: Record<string, string> = {};
/** Registry of YAML parse results keyed by input text. */
const mockYamlResults: Record<string, unknown> = {};

function fakeFile(exists: boolean, content: string) {
  return {
    exists: async () => exists,
    text: async () => content,
  };
}

function testDeps(): LoaderDeps {
  return {
    file: (p: string) =>
      fakeFile(mockFileContents[p] !== undefined, mockFileContents[p] ?? ""),
    yamlParse: (text) =>
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

describe("loadRawConfig", () => {
  test(".yaml file parses to an object", async () => {
    const yaml = "server:\n  port: 8090\n";
    mockFileContents["/cwd/conf.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 8090 } };

    const raw = await loadRawConfig("/cwd/conf.yaml", testDeps());
    expect(raw).toEqual({ server: { port: 8090 } });
  });

  test(".yml file parses to an object", async () => {
    const yaml = "server:\n  port: 9000\n";
    mockFileContents["/cwd/conf.yml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 9000 } };

    const raw = await loadRawConfig("/cwd/conf.yml", testDeps());
    expect(raw).toEqual({ server: { port: 9000 } });
  });

  test(".json file parses to an object", async () => {
    const json = '{"server":{"port":7000}}';
    mockFileContents["/cwd/conf.json"] = json;

    const raw = await loadRawConfig("/cwd/conf.json", testDeps());
    expect(raw).toEqual({ server: { port: 7000 } });
  });

  test("non-object YAML is rejected with the fixed error string", async () => {
    const yaml = "just a scalar\n";
    mockFileContents["/cwd/scalar.yaml"] = yaml;
    mockYamlResults[yaml] = "just a scalar";

    await expect(loadRawConfig("/cwd/scalar.yaml", testDeps())).rejects.toThrow(
      "Config file is not an object",
    );
  });

  test("null YAML is rejected with the fixed error string", async () => {
    const yaml = "null\n";
    mockFileContents["/cwd/null.yaml"] = yaml;
    mockYamlResults[yaml] = null;

    await expect(loadRawConfig("/cwd/null.yaml", testDeps())).rejects.toThrow(
      "Config file is not an object",
    );
  });

  test("missing file fails with the fixed error string", async () => {
    // No content registered for this path → fake file.exists() returns false.
    await expect(loadRawConfig("/cwd/missing.yaml", testDeps())).rejects.toThrow(
      "Config file not found",
    );
  });

  test("unsupported extension fails with an actionable error", async () => {
    mockFileContents["/cwd/conf.toml"] = "whatever";

    await expect(loadRawConfig("/cwd/conf.toml", testDeps())).rejects.toThrow(
      "Unsupported config extension",
    );
  });
});

describe("loadGatewayConfig", () => {
  test("honors CONFIG_FILE env var", async () => {
    const yaml = "server:\n  port: 8090\n";
    process.env.CONFIG_FILE = "/cwd/custom.yaml";
    mockFileContents["/cwd/custom.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 8090 } };

    const cfg = await loadGatewayConfig(undefined, testDeps());
    expect(cfg.server.port).toBe(8090);
  });

  test("defaults to DEFAULT_CONFIG_FILE when CONFIG_FILE is unset", async () => {
    delete process.env.CONFIG_FILE;
    const resolvedDefault = path.resolve(process.cwd(), DEFAULT_CONFIG_FILE);
    const yaml = "server:\n  port: 8091\n";
    mockFileContents[resolvedDefault] = yaml;
    mockYamlResults[yaml] = { server: { port: 8091 } };

    const cfg = await loadGatewayConfig(undefined, testDeps());
    expect(cfg.server.port).toBe(8091);
  });

  test("explicit configPath overrides CONFIG_FILE", async () => {
    process.env.CONFIG_FILE = "/cwd/ignored.yaml";
    const yaml = "server:\n  port: 8080\n";
    mockFileContents["/cwd/explicit.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 8080 } };

    const cfg = await loadGatewayConfig("/cwd/explicit.yaml", testDeps());
    expect(cfg.server.port).toBe(8080);
  });

  test("invalid config fails zod validation with issue messages", async () => {
    const yaml = "server:\n  port: -1\n";
    mockFileContents["/cwd/bad.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: -1 } };

    await expect(loadGatewayConfig("/cwd/bad.yaml", testDeps())).rejects.toThrow(
      /port/i,
    );
  });

  test("valid config yields a typed GatewayConfig with default providers normalized", async () => {
    const yaml = [
      "chains:",
      "  demo:",
      "    provider: llama-server",
      "    nodes:",
      "      - id: start",
      "        type: start",
      "      - id: s1",
      "        type: llm_call",
      "        model: SomeModel",
      "      - id: end",
      "        type: end",
      "    edges:",
      "      - from: start",
      "        to: s1",
      "      - from: s1",
      "        to: end",
      "",
    ].join("\n");
    mockFileContents["/cwd/ok.yaml"] = yaml;
    mockYamlResults[yaml] = {
      chains: {
        demo: {
          provider: "llama-server",
          nodes: [
            { id: "start", type: "start" },
            { id: "s1", type: "llm_call", model: "SomeModel" },
            { id: "end", type: "end" },
          ],
          edges: [
            { from: "start", to: "s1" },
            { from: "s1", to: "end" },
          ],
        },
      },
    };

    const cfg = await loadGatewayConfig("/cwd/ok.yaml", testDeps());
    expect(cfg.chains["demo"].name).toBe("demo");
    // default provider is injected onto graph nodes lacking one.
    expect(cfg.chains["demo"].nodes[1].provider).toBe("llama-server");
  });

  test("removing dotenv: an already-exported process env value is not overwritten", async () => {
    // Documents the .env-precedence contract: with dotenv removed, the loader
    // must NOT clobber an already-exported env var. It reads
    // process.env.CONFIG_FILE and the file, never mutates process.env.
    process.env.CONFIG_FILE = "/cwd/env.yaml";
    const yaml = "server:\n  port: 8070\n";
    mockFileContents["/cwd/env.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 8070 } };

    await loadGatewayConfig(undefined, testDeps());
    expect(process.env.CONFIG_FILE).toBe("/cwd/env.yaml");
  });
});