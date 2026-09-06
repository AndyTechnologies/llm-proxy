/**
 * Framework-freedom boundary test (svelte-ui task 1.5, MINOR-A).
 *
 * The pure TS layer under `src/ui-svelte/lib/` must stay framework-free: no
 * `svelte`/`@sveltejs` imports, so `graph-model.ts` and its helpers remain
 * unit-testable with `bun test` (no browser DOM, no component lifecycle) and
 * swappable across renderers. The eslint gate (`no-restricted-imports` in
 * eslint.config.js) enforces this at lint time; this test scans the actual
 * source on disk so a misconfigured/missed lint run cannot silently pass.
 */
import { describe, it, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const LIB_DIR = join(import.meta.dir);

/** Every framework import specifier that lib/ must never use. */
const FORBIDDEN = [/^svelte$/, /^svelte\//, /^@sveltejs\//];

async function libSourceFiles(): Promise<string[]> {
  const entries = await readdir(LIB_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    // The guard file itself is excluded: it carries only specimen strings
    // (never real imports), so it cannot be part of the scanned production
    // surface it protects.
    .filter((e) => e.name !== "purity.test.ts")
    .map((e) => join(LIB_DIR, e.name));
}

describe("lib/ framework-freedom invariant (MINOR-A)", () => {
  it("scans at least the port oracle and the graph-model module", async () => {
    const files = await libSourceFiles();
    expect(files.some((f) => f.endsWith("graph-model.test.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("graph-model.ts"))).toBe(true);
  });

  it("forbids any svelte/@sveltejs import in lib/*.ts source", async () => {
    const files = await libSourceFiles();
    // Real assertions: for every lib source file, take the import lines and
    // assert none matches a forbidden specifier.
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const line of source.split("\n")) {
        const match = line.match(
          /(?:from\s+|import\s*)["']([^"']+)["']/,
        );
        const specifier = match?.[1];
        if (!specifier) continue;
        if (FORBIDDEN.some((re) => re.test(specifier))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("graph-model.ts itself carries no framework specifier anywhere", async () => {
    const source = await readFile(join(LIB_DIR, "graph-model.ts"), "utf8");
    for (const specifier of ["from \"svelte", "from 'svelte", "@sveltejs/"]) {
      expect(source).not.toContain(specifier);
    }
  });
});