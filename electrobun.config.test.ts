import { describe, expect, test } from "bun:test";
import { config } from "./electrobun.config.js";

describe("electrobun.config", () => {
  test("main process runs on Bun with the app entrypoint", () => {
    expect(config.build.mainProcess).toBe("bun");
    expect(config.build.entrypoint).toBe("src/main.ts");
  });

  test("targets exactly the three supported platforms", () => {
    expect(config.build.targets).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
    ]);
  });

  test("Linux packaging uses Flatpak with native webview", () => {
    expect(config.build.linux.flatpak.id).toMatch(/^[a-z0-9.-]+$/);
    expect(config.build.linux.defaultRenderer).toBe("native");
    expect(config.build.linux.bundleCEF).toBe(false);
  });

  test("macOS signing stays opt-in with DMG creation on", () => {
    expect(config.build.mac.codesign).toBe(false);
    expect(config.build.mac.notarize).toBe(false);
    expect(config.build.mac.createDmg).toBe(true);
  });
});