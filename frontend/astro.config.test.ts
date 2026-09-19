import { describe, expect, test } from "bun:test";
import astroConfig from "./astro.config.ts";

describe("frontend Astro config", () => {
  test("uses native static output — no adapter-static (removed in Astro 7)", () => {
    expect(astroConfig.output).toBe("static");
  });

  test("wires the Svelte 5 integration for islands", () => {
    expect(astroConfig.integrations.length).toBeGreaterThan(0);
  });

  test("proxies /api, /v1 and /ws to the backend in dev", () => {
    const proxy = astroConfig.vite?.server?.proxy;
    expect(proxy?.["/api"]).toBe("http://127.0.0.1:4317");
    expect(proxy?.["/v1"]).toBe("http://127.0.0.1:4317");
    expect(proxy?.["/ws"]).toEqual({
      target: "ws://127.0.0.1:4317",
      ws: true,
    });
  });
});