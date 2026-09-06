/**
 * Task 4.1 tests — `build:binary` embeds the compiled UI as an asset.
 *
 * The binary build command must carry `--asset dist/ui` so `dist/ui` is
 * embedded into the compiled executable (Bun embed assets, preserving the
 * relative path). The legacy `build` and `start` scripts must stay intact.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

function loadPackageScripts(): Record<string, string> {
  const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

describe("package.json scripts (task 4.1)", () => {
  test("build:binary embeds dist/ui via --asset", () => {
    const scripts = loadPackageScripts();
    const buildBinary = scripts["build:binary"];
    expect(buildBinary).toBeDefined();
    expect(buildBinary).toContain("--asset");
    expect(buildBinary).toContain("dist/ui");
  });

  test("legacy build script is intact", () => {
    const scripts = loadPackageScripts();
    expect(scripts["build"]).toBe("bun build src/index.ts --target=bun --outdir dist");
  });

  test("start script is intact", () => {
    const scripts = loadPackageScripts();
    expect(scripts["start"]).toBe("bun run src/index.ts");
  });

  test("build:ui still builds the Svelte app", () => {
    const scripts = loadPackageScripts();
    expect(scripts["build:ui"]).toContain("vite build");
  });
});