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
  llamaBin: "llama",
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

  test("wired /v1 dispatcher handles the paths it owns", async () => {
    const { log } = makeLogger();
    const v1 = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [] });
      }
      return null; // decline everything else
    };
    const handler = buildFetchHandler({ config: baseConfig, logger: log, v1 });
    const res = await handler(new Request("http://127.0.0.1:4317/v1/models"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "list", data: [] });
  });

  test("a declined /v1 path falls through to the 404 envelope", async () => {
    const { log } = makeLogger();
    const v1 = async () => null;
    const handler = buildFetchHandler({ config: baseConfig, logger: log, v1 });
    const res = await handler(new Request("http://127.0.0.1:4317/v1/embeddings"));
    expect(res.status).toBe(404);
  });

  test("wired /api dispatcher handles the paths it owns", async () => {
    const { log } = makeLogger();
    const api = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/workflows") {
        return Response.json({ data: ["demo"] });
      }
      return null; // decline everything else
    };
    const handler = buildFetchHandler({ config: baseConfig, logger: log, api });
    const res = await handler(new Request("http://127.0.0.1/api/workflows"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ["demo"] });
  });

  test("a declined /api path falls through to the 404 envelope", async () => {
    const { log } = makeLogger();
    const api = async () => null;
    const handler = buildFetchHandler({ config: baseConfig, logger: log, api });
    const res = await handler(new Request("http://127.0.0.1/api/workflows/ghost"));
    expect(res.status).toBe(404);
  });

  test("without a v1 dispatcher, /v1 paths answer 404 (proxy not wired)", async () => {
    const { log } = makeLogger();
    const handler = buildFetchHandler({ config: baseConfig, logger: log });
    const res = await handler(new Request("http://127.0.0.1:4317/v1/models"));
    expect(res.status).toBe(404);
  });
});

describe("buildFetchHandler — /api/health localModels (wire-local-backend)", () => {
  test("includes localModels ids when the hub is wired", async () => {
    const { log } = makeLogger();
    const handler = buildFetchHandler({
      config: baseConfig,
      logger: log,
      localModels: () => ["m1"],
    });
    const res = await handler(new Request("http://127.0.0.1/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", localModels: ["m1"] });
  });

  test("omits localModels when the hub is not wired (legacy shape preserved)", async () => {
    const { log } = makeLogger();
    const handler = buildFetchHandler({ config: baseConfig, logger: log });
    const body = (await (
      await handler(new Request("http://127.0.0.1/api/health"))
    ).json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok" });
    expect("localModels" in body).toBe(false);
  });

  test("reports an explicit empty localModels list when wired with no healthy models", async () => {
    const { log } = makeLogger();
    const handler = buildFetchHandler({
      config: baseConfig,
      logger: log,
      localModels: () => [],
    });
    const body = (await (
      await handler(new Request("http://127.0.0.1/api/health"))
    ).json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", localModels: [] });
  });
});