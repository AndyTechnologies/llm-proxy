/**
 * E2E smoke test for the `/ui` dashboard (Slice D — task 4.5, RFC acceptance).
 *
 * There is no browser-automation tool in this stack, so the smoke test degrades
 * to the next available layer (per strict-tdd "Choose Test Layer"): a real
 * Bun.serve integration test that mounts `createApp` with `uiDir` pointing at
 * the real `src/ui` and asserts the SPA is served, then structural assertions
 * that the served HTML/JS/CSS carry the required WCAG/editor behaviors.
 *
 * The test drives the ACTUAL static assets from disk (not fixtures), so it is
 * a true end-to-end serving check, not a unit test.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { createApp } from "../server.js";
import type { ServerDeps } from "../server.js";
import type { ParsedChain } from "../orchestrator/parser.js";
import type { LlamaServeManager } from "../backend/manager.js";

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

/** Point uiDir at the real SPA source dir under the repo. */
const UI_DIR = join(import.meta.dir, "..", "ui");

function makeDeps(): ServerDeps {
  return {
    config: {
      server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
      chains: {},
    } as unknown as ServerDeps["config"],
    chains: new Map<string, ParsedChain>(),
    providers: new Map(),
    manager: fakeManager(),
    uiDir: UI_DIR,
  } as ServerDeps;
}

let server: ReturnType<typeof Bun.serve>;
let port: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 1,
    fetch: createApp(makeDeps()),
  });
  port = server.port!;
});

afterAll(() => {
  server.stop(true);
});

async function get(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

describe("dashboard /ui E2E smoke (4.5)", () => {
  it("GET /ui loads index.html with the editor landmarks", async () => {
    const res = await get("/ui");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // ARIA landmark + editor structure the SPA must expose.
    expect(html).toContain("role=\"banner\"");
    expect(html).toContain("id=\"graph-canvas\"");
    expect(html).toContain("<dialog");
    expect(html).toContain("id=\"palette\"");
  });

  it("serves app.js wired for EventSource, keyboard, validate and apply", async () => {
    const res = await get("/ui/app.js");
    const js = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    // Live updates + editor behaviors required by the spec.
    expect(js).toContain("EventSource");
    expect(js).toContain("/api/ui/events");
    expect(js).toContain("addEventListener(\"keydown\"");
    expect(js).toContain("/api/ui/pipelines/");
    expect(js).toContain("/api/ui/apply");
    // Native SVG rendering (no external graph library): the SPA builds SVG via
    // createElementNS, and imports only the local pure graph-model module.
    expect(js).toContain("createElementNS");
    expect(js).toContain("graph-model.js");
    expect(js).not.toMatch(/from\s+["']d3["']|from\s+["'][^"']*xyflow[^"']*["']/);
  });

  it("serves styles.css with visible focus states (WCAG AA)", async () => {
    const res = await get("/ui/styles.css");
    const css = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("aria-current");
  });

  it("path traversal is rejected (dashboard-ui Req)", async () => {
    const res = await get("/ui/../../etc/passwd");
    expect(res.status).not.toBe(200);
  });
});
