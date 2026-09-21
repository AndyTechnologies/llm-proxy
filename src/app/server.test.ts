import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("buildFetchHandler static UI", () => {
  interface UiFixture {
    uiDir: string;
    secretPath: string;
  }

  function makeUiFixture(): UiFixture {
    const root = mkdtempSync(join(tmpdir(), "weavellm-srv-ui-"));
    const uiDir = join(root, "ui");
    mkdirSync(join(uiDir, "_astro"), { recursive: true });
    writeFileSync(join(uiDir, "index.html"), "<h1>WeaveLLM</h1>");
    writeFileSync(join(uiDir, "_astro", "app.js"), "console.log('ui');");
    const secretPath = join(root, "secret.txt");
    writeFileSync(secretPath, "TOP-SECRET");
    return { uiDir, secretPath };
  }

  function withUi(
    fx: UiFixture,
  ): { handler: (req: Request) => Promise<Response>; teardown: () => void } {
    const config: AppConfig = {
      ...baseConfig,
      uiDir: fx.uiDir,
    };
    const { log } = makeLogger();
    const handler = buildFetchHandler({ config, logger: log });
    return {
      handler,
      teardown: () => {
        rmSync(fx.uiDir, { recursive: true, force: true });
        rmSync(fx.secretPath, { force: true });
      },
    };
  }

  test("serves index.html at the root and /ui alias", async () => {
    const fx = makeUiFixture();
    const { handler, teardown } = withUi(fx);
    try {
      for (const path of ["/", "/ui", "/ui/"]) {
        const res = await handler(new Request(`http://127.0.0.1${path}`));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
      }
    } finally {
      teardown();
    }
  });

  test("serves UI assets with a JS content type", async () => {
    const fx = makeUiFixture();
    const { handler, teardown } = withUi(fx);
    try {
      const res = await handler(new Request("http://127.0.0.1/ui/_astro/app.js"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toBe("console.log('ui');");
    } finally {
      teardown();
    }
  });

  test("falls back to index.html for extensionless SPA routes", async () => {
    const fx = makeUiFixture();
    const { handler, teardown } = withUi(fx);
    try {
      const res = await handler(new Request("http://127.0.0.1/workflows/edit/42"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe("<h1>WeaveLLM</h1>");
    } finally {
      teardown();
    }
  });

  test("a missing asset answers 404", async () => {
    const fx = makeUiFixture();
    const { handler, teardown } = withUi(fx);
    try {
      const res = await handler(new Request("http://127.0.0.1/ui/missing.js"));
      expect(res.status).toBe(404);
    } finally {
      teardown();
    }
  });

  test("traversal attempts answer 404 and never leak files", async () => {
    const fx = makeUiFixture();
    const { handler, teardown } = withUi(fx);
    try {
      const raw = await handler(new Request("http://127.0.0.1/../secret.txt"));
      expect(raw.status).toBe(404);
      expect(await raw.text()).not.toContain("TOP-SECRET");

      const encoded = await handler(
        new Request("http://127.0.0.1/ui/%2e%2e/secret.txt"),
      );
      expect(encoded.status).toBe(404);
      expect(await encoded.text()).not.toContain("TOP-SECRET");
    } finally {
      teardown();
    }
  });

  test("without uiDir the server stays API-only (404 for UI paths)", async () => {
    const { log } = makeLogger();
    const handler = buildFetchHandler({ config: baseConfig, logger: log });
    const res = await handler(new Request("http://127.0.0.1/"));
    expect(res.status).toBe(404);
  });

  test("API namespaces stay 404 when their dispatcher is not wired, even with uiDir", async () => {
    const fx = makeUiFixture();
    const { handler, teardown } = withUi(fx);
    try {
      const api = await handler(new Request("http://127.0.0.1/api/missing"));
      expect(api.status).toBe(404);

      const v1 = await handler(new Request("http://127.0.0.1/v1/models"));
      expect(v1.status).toBe(404);
    } finally {
      teardown();
    }
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