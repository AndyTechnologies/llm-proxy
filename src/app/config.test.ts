import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppConfig, resolveUiDir, uiDirCandidates } from "./config.js";

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

describe("uiDirCandidates", () => {
  test("orders candidates override, dev build, then bundled app", () => {
    const devBuild = join(process.cwd(), "frontend", "dist");
    const bundledUi = join(import.meta.dir, "..", "ui");
    expect(uiDirCandidates({ WEAVELLM_UI_DIR: "/opt/weavellm/ui" })).toEqual([
      "/opt/weavellm/ui",
      devBuild,
      bundledUi,
    ]);
  });

  test("omits the override when unset or empty", () => {
    const devBuild = join(process.cwd(), "frontend", "dist");
    const bundledUi = join(import.meta.dir, "..", "ui");
    expect(uiDirCandidates({})).toEqual([devBuild, bundledUi]);
    expect(uiDirCandidates({ WEAVELLM_UI_DIR: "" })).toEqual([devBuild, bundledUi]);
  });
});

describe("resolveUiDir", () => {
  test("env override wins even when a real candidate dir exists", () => {
    const uiDir = mkdtempSync(join(tmpdir(), "weavellm-ui-"));
    writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>weavellm</title>");
    try {
      expect(resolveUiDir({ WEAVELLM_UI_DIR: uiDir })).toBe(uiDir);
      expect(resolveAppConfig({ WEAVELLM_UI_DIR: uiDir }).uiDir).toBe(uiDir);
    } finally {
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  test("defaults to the dev build output when nothing else matches", () => {
    expect(resolveUiDir({})).toBe(join(process.cwd(), "frontend", "dist"));
  });
});