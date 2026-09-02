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

function req(): Request {
  return new Request("http://localhost/health");
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
