import { describe, it, expect, afterEach } from "bun:test";
import { createApp } from "../server.js";
import type { ServerDeps } from "../server.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";
import { createDashboardRouter } from "./router.js";
import { createExecutionTracker } from "./execution-tracker.js";
import { createEventBus } from "./events.js";
import { createMetricsCollector } from "./metrics.js";
import { createApplyService } from "./service.js";

function fakeManager(): LlamaServeManager {
  return {
    status: () => ({
      state: "running",
      pid: 1,
      models: ["m1.gguf"],
      baseUrl: "http://127.0.0.1:8080",
    }),
    start: async () => {},
    stop: async () => {},
  } as unknown as LlamaServeManager;
}

function baseDeps(): ServerDeps {
  return {
    config: {
      server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
      chains: {},
    } as unknown as ServerDeps["config"],
    chains: new Map<string, ParsedChain>(),
    providers: new Map(),
    manager: fakeManager(),
  } as ServerDeps;
}

/**
 * Minimal dashboard deps wired the same way src/index.ts will wire them, so
 * the server tests exercise the real /api/ui dispatch path.
 */
function dashboardDeps(): NonNullable<ServerDeps["dashboard"]> {
  const tracker = createExecutionTracker();
  const bus = createEventBus();
  const metrics = createMetricsCollector();
  const apply = createApplyService({
    configPath: "/tmp/x.yaml",
    persist: async () => "yaml",
    reload: () => {},
    getCurrentChains: () => ["c1"],
  });
  const handler = createDashboardRouter({
    chainNames: ["c1"],
    chainDescriptions: new Map([["c1", "desc"]]),
    nodeCounts: new Map([["c1", 3]]),
    lastExecution: new Map(),
    registeredModels: ["m1.gguf"],
    detectedModels: [],
    modelsDir: "/models",
    autoRefresh: true,
    tracker,
    bus,
    metrics,
    validateGraph: () => ({ ok: true, errors: [] }),
    applyService: apply,
    runRetry: async () => ({ ok: true, retryExecutionId: "exec-1" }),
    getNodeType: () => undefined,
  });
  return { handler };
}

let servers: ReturnType<typeof Bun.serve>[] = [];

function mount(app: (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, idleTimeout: 1, fetch: app });
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  delete process.env.BEARER_TOKEN;
});

async function request(port: number, path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, opts);
}

describe("server dispatch: /api/ui and /ui auth split (3.6)", () => {
  it("with no token, /api/ui/pipelines is open", async () => {
    delete process.env.BEARER_TOKEN;
    const app = createApp({ ...baseDeps(), dashboard: dashboardDeps() });
    const s = mount(app);
    const res = await request(s.port!, "/api/ui/pipelines");
    expect(res.status).toBe(200);
  });

  it("with token set, unauthenticated /api/ui/events returns 401", async () => {
    process.env.BEARER_TOKEN = "sekret";
    // Re-import auth under the new env is not needed: auth reads env at call
    // time, so the guard reflects the value set before the request.
    const app = createApp({ ...baseDeps(), dashboard: dashboardDeps() });
    const s = mount(app);
    const res = await request(s.port!, "/api/ui/events");
    expect(res.status).toBe(401);
  });

  it("with token set, authenticated /api/ui/pipelines proceeds", async () => {
    process.env.BEARER_TOKEN = "sekret";
    const app = createApp({ ...baseDeps(), dashboard: dashboardDeps() });
    const s = mount(app);
    const res = await request(s.port!, "/api/ui/pipelines", {
      headers: { Authorization: "Bearer sekret" },
    });
    expect(res.status).toBe(200);
  });

  it("with token set, /ui static route stays open (no auth)", async () => {
    process.env.BEARER_TOKEN = "sekret";
    const app = createApp({ ...baseDeps(), dashboard: dashboardDeps() });
    const s = mount(app);
    // /ui is served before the auth guard — open even with a token set.
    const res = await request(s.port!, "/ui");
    expect(res.status).not.toBe(401);
  });

  it("without dashboard deps, /api/ui/* returns 404 (backward compatible)", async () => {
    delete process.env.BEARER_TOKEN;
    const app = createApp(baseDeps());
    const s = mount(app);
    const res = await request(s.port!, "/api/ui/pipelines");
    expect(res.status).toBe(404);
  });
});
