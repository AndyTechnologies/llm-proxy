import { describe, expect, test } from "bun:test";
import { config } from "./electrobun.config.js";

describe("electrobun.config (v2 schema)", () => {
  test("app identity and version match the release", () => {
    expect(config.app.name).toBe("WeaveLLM");
    expect(config.app.identifier).toBe("dev.weavellm.app");
    expect(config.app.version).toBe("0.1.0");
  });

  test("main process runs on Bun with the app entrypoint", () => {
    expect(config.build.mainProcess).toBe("bun");
    expect(config.build.bun.entrypoint).toBe("src/main.ts");
  });

  test("no stale cross-platform matrix fields (Electrobun v2 builds are host-only)", () => {
    expect(config.build).not.toHaveProperty("targets");
    expect(config.build).not.toHaveProperty("mac");
    expect(config.build).not.toHaveProperty("linux");
  });
});