/**
 * Health fetch handler tests (S2.3 — preserve GET /health aggregate).
 *
 * Verifies the legacy /health response stays byte-shape compatible after the
 * Bun.serve migration: status ok, chains array, defaultChain, backend
 * { state, pid, models }.
 */
import { describe, expect, test } from "bun:test";
import type { GatewayConfig } from "../config/schema.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";
import { createHealthHandler } from "./health.js";

function baseConfig(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    server: { host: "127.0.0.1", port: 8090, corsOrigins: "*", jsonLimit: "10mb" },
    llama: {
      binary: "llama",
      host: "127.0.0.1",
      port: 0,
      autoStart: true,
      startupTimeoutMs: 30000,
      stopTimeoutMs: 5000,
      requestTimeoutMs: 300000,
      healthPollIntervalMs: 1000,
      portParseTimeoutMs: 5000,
      backoffCapMs: 30000,
      maxRestartAttempts: 5,
      modelsDir: "~/Models",
      autoload: true,
      router: {} as never,
      models: {},
    },
    defaultChain: "orchestrator",
    chains: {},
    ...over,
  };
}

/** Minimal manager double exposing just `.status()`. */
function fakeManager(status: Partial<ReturnType<LlamaServeManager["status"]>>): LlamaServeManager {
  const full = {
    state: "running",
    pid: 12345,
    models: ["SmolLM3-3B", "Llama3.2-3B-Instruct"],
    baseUrl: "http://127.0.0.1:8080",
    ...status,
  };
  return { status: () => full } as unknown as LlamaServeManager;
}

function req(path = "/health"): Request {
  return new Request(`http://localhost${path}`);
}

describe("GET /health aggregate (legacy preserved)", () => {
  test("reports status ok, chains, defaultChain, backend state/pid/models", async () => {
    const chains = new Map<string, ParsedChain>();
    const config = baseConfig({ chains: { demo: {} as never } });
    const manager = fakeManager({
      state: "running",
      pid: 9001,
      models: ["M1", "M2"],
    });
    const handler = createHealthHandler({ config, chains, manager });

    const res = handler(req());
    const body = (await res.json()) as {
      status: string;
      chains: string[];
      defaultChain: string | null;
      backend: { state: string; pid: number | null; models: string[] };
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.chains).toContain("demo");
    expect(body.defaultChain).toBe("orchestrator");
    expect(body.backend.state).toBe("running");
    expect(body.backend.pid).toBe(9001);
    expect(body.backend.models).toEqual(["M1", "M2"]);
  });

  test("reflects a stopped backend (state stopped, pid null)", async () => {
    const manager = fakeManager({ state: "stopped", pid: null, models: [] });
    const handler = createHealthHandler({
      config: baseConfig(),
      chains: new Map(),
      manager,
    });

    const body = (await handler(req()).json()) as {
      backend: { state: string; pid: number | null; models: string[] };
    };
    expect(body.backend.state).toBe("stopped");
    expect(body.backend.pid).toBeNull();
    expect(body.backend.models).toEqual([]);
  });
});

describe("GET /health/live (S3.1 liveness — always 200 while process is up)", () => {
  test("returns 200 regardless of backend state", async () => {
    const handler = createHealthHandler({
      config: baseConfig(),
      chains: new Map(),
      manager: fakeManager({ state: "starting" }),
    });

    const res = handler(req("/health/live"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("alive");
  });

  test("returns 200 even when the backend is stopped", async () => {
    const handler = createHealthHandler({
      config: baseConfig(),
      chains: new Map(),
      manager: fakeManager({ state: "error" }),
    });

    const res = handler(req("/health/live"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "alive" });
  });
});

describe("GET /health/ready (S3.1 readiness — gated on backend running)", () => {
  test("returns 200 when backend state is running", async () => {
    const handler = createHealthHandler({
      config: baseConfig(),
      chains: new Map(),
      manager: fakeManager({ state: "running" }),
    });

    const res = handler(req("/health/ready"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; backend: { state: string } };
    expect(body.status).toBe("ready");
    expect(body.backend.state).toBe("running");
  });

  test("returns 503 with the backend state when starting", async () => {
    const handler = createHealthHandler({
      config: baseConfig(),
      chains: new Map(),
      manager: fakeManager({ state: "starting" }),
    });

    const res = handler(req("/health/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; backend: { state: string } };
    expect(body.status).toBe("unavailable");
    expect(body.backend.state).toBe("starting");
  });

  test("returns 503 with the backend state when stopped", async () => {
    const handler = createHealthHandler({
      config: baseConfig(),
      chains: new Map(),
      manager: fakeManager({ state: "stopped" }),
    });

    const res = handler(req("/health/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { backend: { state: string } };
    expect(body.backend.state).toBe("stopped");
  });

  test("returns 503 with the backend state when error", async () => {
    const handler = createHealthHandler({
      config: baseConfig(),
      chains: new Map(),
      manager: fakeManager({ state: "error" }),
    });

    const res = handler(req("/health/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { backend: { state: string } };
    expect(body.backend.state).toBe("error");
  });
});

describe("GET /health dispatch preserves legacy aggregate", () => {
  test("legacy /health still returns the aggregate shape, not a live/ready payload", async () => {
    const chains = new Map<string, ParsedChain>();
    const config = baseConfig({ chains: { demo: {} as never } });
    const manager = fakeManager({ state: "running", pid: 42, models: ["A"] });
    const handler = createHealthHandler({ config, chains, manager });

    const res = handler(req("/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      chains: string[];
      backend: { pid: number | null; models: string[] };
    };
    // Aggregate payload: has chains array + backend { pid, models }.
    expect(body.chains).toContain("demo");
    expect(body.backend.pid).toBe(42);
    expect(body.backend.models).toEqual(["A"]);
  });
});
