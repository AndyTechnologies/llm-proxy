import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticUi } from "./static-ui.js";

interface UiFixture {
  uiDir: string;
  secretPath: string;
}

/** index.html + _astro/app.js + assets/theme.css, plus a sibling secret file. */
function makeFixture(): UiFixture {
  const root = mkdtempSync(join(tmpdir(), "weavellm-ui-"));
  const uiDir = join(root, "ui");
  mkdirSync(join(uiDir, "_astro"), { recursive: true });
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<h1>WeaveLLM</h1>");
  writeFileSync(join(uiDir, "_astro", "app.js"), "console.log('ui');");
  writeFileSync(join(uiDir, "assets", "theme.css"), "body{}");
  const secretPath = join(root, "secret.txt");
  writeFileSync(secretPath, "TOP-SECRET");
  return { uiDir, secretPath };
}

function teardown(fixture: UiFixture): void {
  rmSync(fixture.uiDir, { recursive: true, force: true });
  rmSync(fixture.secretPath, { force: true });
}

describe("serveStaticUi", () => {
  test("serves index.html for the root path with text/html", async () => {
    const fx = makeFixture();
    try {
      const res = await serveStaticUi(fx.uiDir, "/", "GET");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-type")).toContain("text/html");
      expect(await res!.text()).toBe("<h1>WeaveLLM</h1>");
    } finally {
      teardown(fx);
    }
  });

  test("serves index.html for the /ui alias paths", async () => {
    const fx = makeFixture();
    try {
      for (const path of ["/ui", "/ui/"]) {
        const res = await serveStaticUi(fx.uiDir, path, "GET");
        expect(res).not.toBeNull();
        expect(res!.status).toBe(200);
        expect(res!.headers.get("content-type")).toContain("text/html");
      }
    } finally {
      teardown(fx);
    }
  });

  test("serves existing assets with an inferred MIME type", async () => {
    const fx = makeFixture();
    try {
      const js = await serveStaticUi(fx.uiDir, "/ui/_astro/app.js", "GET");
      expect(js).not.toBeNull();
      expect(js!.status).toBe(200);
      expect(js!.headers.get("content-type")).toContain("javascript");
      expect(await js!.text()).toBe("console.log('ui');");

      const css = await serveStaticUi(fx.uiDir, "/assets/theme.css", "GET");
      expect(css).not.toBeNull();
      expect(css!.status).toBe(200);
      expect(css!.headers.get("content-type")).toContain("text/css");
    } finally {
      teardown(fx);
    }
  });

  test("falls back to index.html for extensionless SPA routes", async () => {
    const fx = makeFixture();
    try {
      const res = await serveStaticUi(fx.uiDir, "/workflows/edit/42", "GET");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-type")).toContain("text/html");
      expect(await res!.text()).toBe("<h1>WeaveLLM</h1>");
    } finally {
      teardown(fx);
    }
  });

  test("returns null for missing assets (paths with an extension)", async () => {
    const fx = makeFixture();
    try {
      expect(await serveStaticUi(fx.uiDir, "/ui/missing.js", "GET")).toBeNull();
      expect(await serveStaticUi(fx.uiDir, "/fonts/rare.woff2", "GET")).toBeNull();
    } finally {
      teardown(fx);
    }
  });

  test("rejects traversal that escapes the ui dir", async () => {
    const fx = makeFixture();
    try {
      const encoded = await serveStaticUi(fx.uiDir, "/ui/%2e%2e/secret.txt", "GET");
      expect(encoded).toBeNull();

      // Percent-encoded slash variant decodes to a parent traversal.
      const slashEncoded = await serveStaticUi(fx.uiDir, "/ui/%2e%2e%2fsecret.txt", "GET");
      expect(slashEncoded).toBeNull();

      // Encoded null bytes are never trusted.
      const nullByte = await serveStaticUi(fx.uiDir, "/ui/%00/secret.txt", "GET");
      expect(nullByte).toBeNull();

      // Malformed percent-encoding cannot crash the resolver.
      const malformed = await serveStaticUi(fx.uiDir, "/ui/%zz", "GET");
      expect(malformed).toBeNull();
    } finally {
      teardown(fx);
    }
  });

  test("never leaks files outside the ui dir", async () => {
    const fx = makeFixture();
    try {
      const res = await serveStaticUi(fx.uiDir, "/ui/%2e%2e/secret.txt", "GET");
      expect(res).toBeNull();
    } finally {
      teardown(fx);
    }
  });

  test("only GET and HEAD are served", async () => {
    const fx = makeFixture();
    try {
      expect(await serveStaticUi(fx.uiDir, "/", "POST")).toBeNull();
      expect(await serveStaticUi(fx.uiDir, "/", "PUT")).toBeNull();
      const head = await serveStaticUi(fx.uiDir, "/", "HEAD");
      expect(head).not.toBeNull();
      expect(head!.status).toBe(200);
    } finally {
      teardown(fx);
    }
  });
});