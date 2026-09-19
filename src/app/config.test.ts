import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveAppConfig } from "./config.js";

describe("resolveAppConfig", () => {
  test("defaults to loopback bind on the proxy port", () => {
    const cfg = resolveAppConfig({});
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(4317);
    expect(cfg.authEnabled).toBe(false);
  });

  test("defaults uiDir to the built frontend output", () => {
    const cfg = resolveAppConfig({});
    expect(cfg.uiDir).toBe(join(process.cwd(), "frontend", "dist"));
  });

  test("honours the WEAVELLM_UI_DIR override", () => {
    const cfg = resolveAppConfig({ WEAVELLM_UI_DIR: "/opt/weavellm/ui" });
    expect(cfg.uiDir).toBe("/opt/weavellm/ui");
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