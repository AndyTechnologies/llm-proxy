/**
 * Static `/ui` SPA serving tests (svelte-ui Phase 2 — task 2.1, dashboard-ui
 * delta Req "Compiled SPA serving").
 *
 * The SPA is now a compiled Svelte 5 + Vite bundle: hashed asset
 * subdirectories (`/ui/assets/*`) resolve with correct content types, unknown
 * `/ui/*` paths fall back to `index.html` (client-side route reload), and the
 * per-segment traversal guard is preserved (`. .`, leading dots, backslashes,
 * absolute paths, empty segments → rejected, no fallback). `/api/*` never
 * falls back.
 *
 * The tests exercise the real `createApp` fetch handler mounted on `Bun.serve`,
 * with a temporary `uiDir` containing a compiled-SPA-shaped directory.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";
import { resolveUiAsset, contentTypeFor } from "../server.js";
import type { ServerDeps } from "../server.js";
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

function baseDeps(uiDir: string | undefined): ServerDeps {
  return {
    config: {
      server: { port: 0, host: "127.0.0.1", corsOrigins: [] },
      llama: { requestTimeoutMs: 5000 },
      chains: {},
    } as unknown as ServerDeps["config"],
    providers: new Map(),
    manager: fakeManager(),
    uiDir,
  } as ServerDeps;
}

let servers: ReturnType<typeof Bun.serve>[] = [];
let tempDirs: string[] = [];

/**
 * Create a compiled-SPA-shaped uiDir: index.html at the root plus a hashed
 * asset under `assets/` (Vite's output layout).
 */
async function makeSpaDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-proxy-ui-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<html><body>Dashboard</body></html>");
  await writeFile(join(dir, "assets", "app-abc123.js"), "console.log('app');");
  await writeFile(join(dir, "assets", "styles-abc123.css"), "body { color: #fff; }");
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

describe("static /ui SPA serving (svelte-ui 2.1)", () => {
  it("GET /ui serves index.html as text/html", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Dashboard");
  });

  it("GET /ui/ (trailing slash, empty segment) is rejected per MAJOR-1", async () => {
    // The design's ordering invariant rejects ANY empty segment → null with
    // no fallback, so a trailing-slash /ui/ must NOT serve the SPA.
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/");
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("Dashboard");
  });

  it("hashed asset subdirectory resolves with correct content type", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("console.log('app')");
  });

  it("nested asset under a two-level subdirectory resolves", async () => {
    const uiDir = await makeSpaDir();
    await mkdir(join(uiDir, "assets", "deep"), { recursive: true });
    await writeFile(join(uiDir, "assets", "deep", "x-1.map"), "{}");
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/assets/deep/x-1.map");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("path traversal /ui/../../etc/passwd is rejected with non-200 (no fallback)", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/../../etc/passwd");
    // SPA fallback must NOT kick in for traversal — a non-200 proves the
    // request was rejected, not rewritten to index.html.
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("Dashboard");
  });

  it("unknown /ui/* GET falls back to index.html (client-side route reload)", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/pipelines");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Dashboard");
  });

  it("fallback serves index.html for a deep unknown route under /ui/", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/ui/editor/nested/deep");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Dashboard");
  });

  it("fallback NEVER intercepts /api/* — unknown api request returns non-200", async () => {
    const uiDir = await makeSpaDir();
    const app = createApp(baseDeps(uiDir));
    const s = mount(app);
    const res = await request(s.port!, "/api/ui/definitely-not-a-route");
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("Dashboard");
  });

  it("missing uiDir (build not produced) returns the run build:ui 404", async () => {
    const app = createApp(baseDeps(undefined));
    const s = mount(app);
    const res = await request(s.port!, "/ui");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("build:ui");
  });
});

// ── triangulation: pure resolver + content-type mapping (force real logic) ──
describe("resolveUiAsset + contentTypeFor (svelte-ui 2.1 triangulation)", () => {
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

  it("maps /ui/assets/<hash>.js to the hashed subdirectory file", () => {
    expect(resolveUiAsset("/ui/assets/app-abc123.js", contentTypeFor)).toEqual({
      file: "assets/app-abc123.js",
      contentType: "application/javascript",
    });
  });

  it("maps /ui/assets/styles-abc123.css to text/css", () => {
    expect(resolveUiAsset("/ui/assets/styles-abc123.css", contentTypeFor)?.contentType).toBe(
      "text/css",
    );
  });

  it("rejects ../ traversal (does not escape uiDir)", () => {
    expect(resolveUiAsset("/ui/../secret", contentTypeFor)).toBeNull();
    expect(resolveUiAsset("/ui/../../etc/passwd", contentTypeFor)).toBeNull();
  });

  it("rejects a leading-dot segment (dotfiles)", () => {
    expect(resolveUiAsset("/ui/.env", contentTypeFor)).toBeNull();
    expect(resolveUiAsset("/ui/assets/.hidden.js", contentTypeFor)).toBeNull();
  });

  it("rejects a backslash segment", () => {
    expect(resolveUiAsset("/ui/assets\\app.js", contentTypeFor)).toBeNull();
    expect(resolveUiAsset("/ui/..\\app.js", contentTypeFor)).toBeNull();
  });

  it("rejects an empty segment (double slash)", () => {
    expect(resolveUiAsset("/ui//app.js", contentTypeFor)).toBeNull();
  });

  it("rejects segments that are '.' or '..' at any depth", () => {
    expect(resolveUiAsset("/ui/./app.js", contentTypeFor)).toBeNull();
    expect(resolveUiAsset("/ui/assets/../app.js", contentTypeFor)).toBeNull();
  });

  it("rejects paths outside the /ui prefix", () => {
    expect(resolveUiAsset("/api/ui/pipelines", contentTypeFor)).toBeNull();
    expect(resolveUiAsset("/v1/models", contentTypeFor)).toBeNull();
  });

  it("maps every extension in the MAJOR-2 set to its content type", () => {
    expect(contentTypeFor(".html")).toBe("text/html");
    expect(contentTypeFor(".js")).toBe("application/javascript");
    expect(contentTypeFor(".css")).toBe("text/css");
    expect(contentTypeFor(".json")).toBe("application/json");
    expect(contentTypeFor(".svg")).toBe("image/svg+xml");
    expect(contentTypeFor(".png")).toBe("image/png");
    expect(contentTypeFor(".ico")).toBe("image/x-icon");
    expect(contentTypeFor(".woff")).toBe("font/woff");
    expect(contentTypeFor(".woff2")).toBe("font/woff2");
    expect(contentTypeFor(".map")).toBe("application/json");
    expect(contentTypeFor(".wasm")).toBe("application/wasm");
    expect(contentTypeFor(".unknown")).toBe("application/octet-stream");
  });
});