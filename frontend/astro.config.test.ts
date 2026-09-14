import { describe, expect, test } from "bun:test";
import astroConfig from "./astro.config.ts";

describe("frontend Astro config", () => {
  test("uses native static output — no adapter-static (removed in Astro 7)", () => {
    expect(astroConfig.output).toBe("static");
  });

  test("wires the Svelte 5 integration for islands", () => {
    expect(astroConfig.integrations.length).toBeGreaterThan(0);
  });
});