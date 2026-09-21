import { describe, expect, test } from "bun:test";
import { createWebServer, buildFetchHandler } from "./server.js";
import { resolveAppConfig } from "./config.js";
import { coldStartOk, measureColdStart, COLD_START_BUDGET_MS } from "./startup.js";

function quietLogger() {
  return (_level: string, _msg: string, _meta?: Record<string, unknown>) => {};
}

describe("runtime harness — real server boot", () => {
  test(
    "server boots on an ephemeral port and answers health within the 2s cold-start budget",
    async () => {
      const t0 = performance.now();
      const config = resolveAppConfig({ WEAVELLM_PORT: "0" });
      const server = await createWebServer({ config, logger: quietLogger() });
      await server.start();
      const bootMs = measureColdStart(t0);

      expect(server.port).toBeGreaterThan(0);
      expect(server.hostname).toBe("127.0.0.1");
      expect(coldStartOk(bootMs, COLD_START_BUDGET_MS)).toBe(true);

      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });

      await server.stop();
    },
    { timeout: 10_000 },
  );

  test("handler rejects unknown routes with 404 over a real socket", async () => {
    const config = resolveAppConfig({ WEAVELLM_PORT: "0" });
    const server = await createWebServer({ config, logger: quietLogger() });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/missing`);
    expect(res.status).toBe(404);
    await server.stop();
  });
});

describe("buildFetchHandler", () => {
  test("is a standalone pure handler usable without a socket", async () => {
    const handler = buildFetchHandler({
      config: resolveAppConfig({}),
      logger: quietLogger(),
    });
    const res = await handler(new Request("http://127.0.0.1/api/health"));
    expect(res.status).toBe(200);
  });
});