import { describe, expect, test } from "bun:test";
import { resolveAppConfig } from "./config.js";

describe("resolveAppConfig", () => {
  test("defaults to loopback bind on the proxy port", () => {
    const cfg = resolveAppConfig({});
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(4317);
    expect(cfg.authEnabled).toBe(false);
  });

  test("honours explicit port and host overrides", () => {
    const cfg = resolveAppConfig({
      WEAVELLM_PORT: "8080",
      WEAVELLM_HOST: "0.0.0.0",
    });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(8080);
  });

  test("rejects a non-numeric port', and falls back", () => {
    const cfg = resolveAppConfig({ WEAVELLM_PORT: "abc" });
    expect(cfg.port).toBe(4317);
  });
});

describe("llamaBin (WEAVELLM_LLAMA_BIN)", () => {
  test("defaults to 'llama' when unset", () => {
    expect(resolveAppConfig({}).llamaBin).toBe("llama");
  });

  test("propagates an explicit binary path verbatim", () => {
    const cfg = resolveAppConfig({ WEAVELLM_LLAMA_BIN: "/opt/llama/bin/llama-server" });
    expect(cfg.llamaBin).toBe("/opt/llama/bin/llama-server");
  });

  test("empty string falls back to 'llama'", () => {
    expect(resolveAppConfig({ WEAVELLM_LLAMA_BIN: "" }).llamaBin).toBe("llama");
  });
});