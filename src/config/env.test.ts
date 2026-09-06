/**
 * .env autoload and precedence tests.
 *
 * Covers the config-load spec requirement ".env precedence":
 *   - "Env file values loaded" — Bun native .env autoload at boot sets
 *     process.env from .env files. This is a Bun runtime behavior; the
 *     config system reads from process.env and never clobbers it.
 *   - "Process environment wins" — pre-existing process.env values take
 *     precedence over .env file values. With dotenv removed, the config
 *     loader only reads process.env, never writes to it.
 *
 * Strategy: set process.env values before config load and verify they
 * survive (precedence). Use a valid config that passes zod to exercise
 * the full loadGatewayConfig path.
 *
 * For the autoload scenario: Bun natively loads `.env` from CWD at process
 * startup. We verify this via a subprocess that writes a marker `.env`
 * file and confirms the variable appears in its `process.env`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
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
  // Clean up any test env vars
  delete process.env.BEARER_TOKEN;
  delete process.env.TEST_PORT;
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_OPS_KEY;
});

describe(".env precedence (config-load spec Req: .env precedence)", () => {
  test("process.env values survive config load (process env wins)", async () => {
    // Simulate a pre-existing env value (as if set by shell or CI).
    process.env.CONFIG_FILE = "/cwd/env-precedence.yaml";
    process.env.TEST_PORT = "9999";

    const yaml = "server:\n  port: 8080\n";
    mockFileContents["/cwd/env-precedence.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 8080 } };

    await loadGatewayConfig(undefined, testDeps());

    // The config loader reads process.env.CONFIG_FILE but never mutates
    // process.env. Pre-existing values must survive the load.
    expect(process.env.TEST_PORT).toBe("9999");
  });

  test("CONFIG_FILE env var is honored by loadGatewayConfig", async () => {
    process.env.CONFIG_FILE = "/cwd/custom-env.yaml";
    const yaml = "server:\n  port: 7777\n";
    mockFileContents["/cwd/custom-env.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 7777 } };

    const cfg = await loadGatewayConfig(undefined, testDeps());
    expect(cfg.server.port).toBe(7777);
  });

  test("env file values are loaded: Bun autoloads .env into process.env at boot", async () => {
    // Bun natively loads `.env` from CWD at process startup. We verify this
    // by spawning a subprocess that:
    //   1. Creates a temporary directory with a `.env` marker file.
    //   2. Runs `bun -e` from that directory.
    //   3. Checks that the marker variable appears in process.env.
    //
    // This tests the REAL Bun autoload behavior (not a mock), confirming
    // the spec requirement "Env file values loaded" is met by Bun itself.
    const dir = await mkdtemp(join(tmpdir(), "envtest-"));
    const markerVar = "LLM_PROXY_TEST_ENV_LOADED";
    const markerVal = "from-dotenv";

    try {
      await writeFile(join(dir, `.env`), `${markerVar}=${markerVal}\n`);

      const result =
        await $`bun -e "process.exit(process.env.${markerVar} === '${markerVal}' ? 0 : 1)"`.cwd(
          dir,
        );

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("process env wins: explicitly set value is not overwritten by config load", async () => {
    // Simulate the spec scenario: BEARER_TOKEN is already exported in the
    // shell. The config loader must NOT clobber it.
    process.env.BEARER_TOKEN = "shell-exported-token";
    process.env.CONFIG_FILE = "/cwd/bearer.yaml";

    const yaml = "server:\n  port: 8080\n";
    mockFileContents["/cwd/bearer.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 8080 } };

    await loadGatewayConfig(undefined, testDeps());

    // Process env wins: the shell-exported value is untouched
    expect(process.env.BEARER_TOKEN).toBe("shell-exported-token");
  });

  test("config load does not mutate unrelated process.env keys", async () => {
    process.env.BEARER_TOKEN = "original-value";
    process.env.CONFIG_FILE = "/cwd/no-mutate.yaml";

    const yaml = "server:\n  port: 8080\n";
    mockFileContents["/cwd/no-mutate.yaml"] = yaml;
    mockYamlResults[yaml] = { server: { port: 8080 } };

    const before = { ...process.env };
    await loadGatewayConfig(undefined, testDeps());

    // The loader only reads process.env; no keys should be added/removed/changed
    expect(process.env.BEARER_TOKEN as string | undefined).toBe(before.BEARER_TOKEN as string | undefined);
    expect(process.env.TEST_PORT as string | undefined).toBe(before.TEST_PORT as string | undefined);
  });
});

describe("${ENV} interpolation in provider secrets (task 1.4)", () => {
  const groqYaml = (apiKey: string, headers: Record<string, string>) =>
    `providers:\n  groq:\n    baseURL: https://api.groq.com/openai/v1\n    apiKey: "${apiKey}"\n    headers:\n${Object.entries(headers)
      .map(([k, v]) => `      ${k}: "${v}"`)
      .join("\n")}\n    models:\n      - llama-3.3-70b\n`;

  test("apiKey ${VAR} resolves from process.env", async () => {
    process.env.CONFIG_FILE = "/cwd/interp-api-key.yaml";
    process.env.GROQ_API_KEY = "resolved-secret";
    const yaml = groqYaml("${GROQ_API_KEY}", {});
    mockFileContents["/cwd/interp-api-key.yaml"] = yaml;
    mockYamlResults[yaml] = {
      providers: {
        groq: {
          baseURL: "https://api.groq.com/openai/v1",
          apiKey: "${GROQ_API_KEY}",
          models: ["llama-3.3-70b"],
        },
      },
    };

    const cfg = await loadGatewayConfig(undefined, testDeps());
    expect(cfg.providers.groq.apiKey).toBe("resolved-secret");
  });

  test("headers values resolve ${VAR} from process.env", async () => {
    process.env.CONFIG_FILE = "/cwd/interp-headers.yaml";
    process.env.GROQ_OPS_KEY = "ops-token";
    const yaml = groqYaml("static", { "X-Operations": "${GROQ_OPS_KEY}" });
    mockFileContents["/cwd/interp-headers.yaml"] = yaml;
    mockYamlResults[yaml] = {
      providers: {
        groq: {
          baseURL: "https://api.groq.com/openai/v1",
          apiKey: "static",
          headers: { "X-Operations": "${GROQ_OPS_KEY}" },
          models: ["llama-3.3-70b"],
        },
      },
    };

    const cfg = await loadGatewayConfig(undefined, testDeps());
    expect(cfg.providers.groq.headers?.["X-Operations"]).toBe("ops-token");
  });

  test("unset ${VAR} fails naming the variable verbatim", async () => {
    process.env.CONFIG_FILE = "/cwd/interp-unset.yaml";
    delete process.env.GROQ_API_KEY;
    const yaml = groqYaml("${GROQ_API_KEY}", {});
    mockFileContents["/cwd/interp-unset.yaml"] = yaml;
    mockYamlResults[yaml] = {
      providers: {
        groq: {
          baseURL: "https://api.groq.com/openai/v1",
          apiKey: "${GROQ_API_KEY}",
          models: ["llama-3.3-70b"],
        },
      },
    };

    await expect(loadGatewayConfig(undefined, testDeps())).rejects.toThrow(
      "env var GROQ_API_KEY is not set",
    );
  });

  test("non-secret provider fields left untouched when no ${VAR} present", async () => {
    process.env.CONFIG_FILE = "/cwd/interp-plain.yaml";
    const yaml = groqYaml("static-key", {});
    mockFileContents["/cwd/interp-plain.yaml"] = yaml;
    mockYamlResults[yaml] = {
      providers: {
        groq: {
          baseURL: "https://api.groq.com/openai/v1",
          apiKey: "static-key",
          models: ["llama-3.3-70b"],
        },
      },
    };

    const cfg = await loadGatewayConfig(undefined, testDeps());
    expect(cfg.providers.groq.apiKey).toBe("static-key");
  });
});
