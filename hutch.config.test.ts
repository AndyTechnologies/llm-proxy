import { describe, expect, test } from "bun:test";
import { config, TOOLCHAIN_PRAGMA } from "./hutch.config.js";

describe("hutch.config", () => {
  test("pins the exact Electrobun version (release floor for Bun main)", () => {
    expect(config.electrobun.version).toBe("2.1.0");
  });

  test("stays on the stable channel for signed releases", () => {
    expect(config.channel).toBe("stable");
    expect(config.release.overrides.stable.env).toBe(true);
  });

  test("carries the documented toolchain pragma", () => {
    expect(TOOLCHAIN_PRAGMA).toContain("@hutch cli=");
    expect(TOOLCHAIN_PRAGMA).toContain("cottontail=");
  });
});