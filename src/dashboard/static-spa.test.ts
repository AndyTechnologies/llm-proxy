/**
 * Static `/ui` SPA serving tests (Slice D — task 4.4, dashboard-ui Req
 * "Static SPA serving").
 *
 * Verifies the SPA is served as static assets with correct content types and
 * that a path-traversal request is rejected with a non-200 response.
 *
 * The tests exercise the real `createApp` fetch handler mounted on `Bun.serve`,
 * with a temporary `uiDir` containing the SPA files. They reference the
 * `uiDir` dependency and static serving logic added in task 4.4.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";
import { resolveUiAsset, contentTypeFor } from "../server.js";
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

function baseDeps(uiDir: string): ServerDeps {
  return {
    config: {
      server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
      chains: {},
    } as unknown as ServerDeps["config"],
    chains: new Map<string, ParsedChain>(),
    providers: new Map(),
    manager: fakeManager(),
    // The static SPA directory (Slice D — added to ServerDeps in task 4.4).
    uiDir,
  } as ServerDeps;
}

let servers: ReturnType<typeof Bun.serve>[] = [];
let tempDirs: string[] = [];

async function makeSpaDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-proxy-ui-"));
  await writeFile(join(dir, "index.html"), "<html><body>Dashboard</body></html>");
  await writeFile(join(dir, "app.js"), "console.log('app');");
  await writeFile(join(dir, "styles.css"), "body { color: #fff; }");
  tempDirs.push(dir);
  return dir;
}

function mount(app: (req: Request, server: ReturnType<typeof Bun.serve>) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, idleTimeout: 1, fetch: app });
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  delete process.env.BEARER_TOKEN;
  for (const dir of tempDirs) rm(dir, { recursive: true, force: true }).catch(() => {});
  tempDirs = [];
});

async function request(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

describe("static /ui SPA serving (4.4)", () => {
  it("GET /ui serves index.html as text/html", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Dashboard");
  });

  it("GET /ui/app.js serves application/javascript", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("GET /ui/styles.css serves text/css", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("path traversal /ui/../../etc/passwd is rejected with non-200", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/../../etc/passwd");
    expect(res.status).not.toBe(200);
  });

  it("unknown asset under /ui returns non-200", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/nope.png");
    expect(res.status).not.toBe(200);
  });
});

// ── triangulation: pure resolver + content-type mapping (force real logic) ──
describe("resolveUiAsset + contentTypeFor (4.4 triangulation)", () => {
  it("maps /ui to index.html with text/html", () => {
    expect(resolveUiAsset("/ui", contentTypeFor)).toEqual({
      file: "index.html",
      contentType: "text/html",
    });
  });

  it("maps /ui/app.js to application/javascript", () => {
    expect(resolveUiAsset("/ui/app.js", contentTypeFor)?.contentType).toBe(
      "application/javascript",
    );
  });

  it("maps /ui/styles.css to text/css", () => {
    expect(resolveUiAsset("/ui/styles.css", contentTypeFor)?.contentType).toBe(
      "text/css",
    );
  });

  it("rejects ../ traversal (does not escape uiDir)", () => {
    expect(resolveUiAsset("/ui/../secret", contentTypeFor)).toBeNull();
  });

  it("rejects absolute/nested paths (no subdirectories served)", () => {
    expect(resolveUiAsset("/ui/sub/app.js", contentTypeFor)).toBeNull();
    expect(resolveUiAsset("/ui/../../etc/passwd", contentTypeFor)).toBeNull();
  });

  it("maps a range of extensions to correct MIME types", () => {
    expect(contentTypeFor(".json")).toBe("application/json");
    expect(contentTypeFor(".svg")).toBe("image/svg+xml");
    expect(contentTypeFor(".ico")).toBe("image/x-icon");
    expect(contentTypeFor(".unknown")).toBe("application/octet-stream");
  });
});

