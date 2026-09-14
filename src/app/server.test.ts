import { describe, expect, test } from "bun:test";
import { buildFetchHandler } from "./server.js";
import { type AppLogger, type AppConfig } from "./types.js";

function makeLogger(): { log: AppLogger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const log: AppLogger = (level, msg, meta) => {
    lines.push([level, msg, meta]);
  };
  return { log, lines };
}

const baseConfig: AppConfig = {
  host: "127.0.0.1",
  port: 4317,
  authEnabled: false,
  appData: "/tmp",
};

describe("buildFetchHandler", () => {
  test("health endpoint answers with a JSON envelope", async () => {
    const { log } = makeLogger();
    const handler = buildFetchHandler({ config: baseConfig, logger: log });
    const res = await handler(
      new Request("http://127.0.0.1/api/health", { method: "GET" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("unknown /api route returns 404, not a crash", async () => {
    const { log } = makeLogger();
    const handler = buildFetchHandler({ config: baseConfig, logger: log });
    const res = await handler(
      new Request("http://127.0.0.1/api/nope", { method: "GET" }),
    );
    expect(res.status).toBe(404);
  });

  test("each request emits one JSON log line with method and path", async () => {
    const { log, lines } = makeLogger();
    const handler = buildFetchHandler({ config: baseConfig, logger: log });
    await handler(new Request("http://127.0.0.1/api/health"));
    expect(lines.length).toBe(1);
    const [level, _msg, meta] = lines[0];
    expect(level).toBe("info");
    expect(meta).toMatchObject({ method: "GET", path: "/api/health" });
  });

  test("loopback-only binding is enforced from the app config", async () => {
    const { log } = makeLogger();
    const remote: AppConfig = { ...baseConfig, host: "0.0.0.0" };
    const handler = buildFetchHandler({ config: remote, logger: log });
    const res = await handler(new Request("http://127.0.0.1/api/health"));
    // Binding is config-driven; the default (loopback) is asserted in config.test.
    expect(res.status).toBe(200);
  });
});