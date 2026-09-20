/**
 * WeaveLLM release build: 3 targets via Electrobun/Hutch + < 100 MB gate.
 *
 * Usage: `bun run scripts/build-binaries.ts [--skip-build] [--artifacts <dir>]`
 *
 * Default: shells out to `hutch build` for each supported target (the Electrobun
 * toolchain), then measures every artifact under the output dir and fails if
 * any bundle exceeds the 100 MB gate (desktop-app-shell / AC #1).
 *
 * This channel emits Cottontail INSTALLER/UPDATE artifacts (e.g.
 * linux-x64-WeaveLLM-Setup.tar.gz, stable-linux-x64-update.json). It is the
 * release-matrix/size-gate script and is NOT the portable distribution path:
 * the user-selected desktop artifact is ONE self-contained executable built
 * by `bun run build:binary` (scripts/build-binary.ts). Keep both paths
 * distinct.
 */

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertBundleSize,
  BUNDLE_SIZE_LIMIT,
  targetLabel,
  targetTriples,
  type TargetTriple,
} from "./build-binaries-args.js";

const ARTIFACTS_DIR = process.env.WEAVELLM_ARTIFACTS_DIR ?? "dist";

function isBundleFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".app") ||
    lower.endsWith(".dmg") ||
    lower.endsWith(".flatpak") ||
    lower.endsWith(".deb") ||
    lower.endsWith(".zip") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz")
  );
}

/** Walk a directory recursively and collect bundle artifact sizes. */
export function collectArtifacts(dir: string): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (current: string): void => {
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(current, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDir) {
        walk(full);
      } else if (isBundleFile(entry.name)) {
        out.push({ path: full, bytes: statSync(full).size });
      }
    }
  };
  walk(dir);
  return out;
}

/** Measure every artifact and enforce the gate; throws on the first failure. */
export function enforceSizeGate(dir: string): Array<{ path: string; bytes: number }> {
  const artifacts = collectArtifacts(dir);
  for (const a of artifacts) {
    assertBundleSize(a.bytes, BUNDLE_SIZE_LIMIT);
  }
  return artifacts;
}

async function buildTarget(triple: TargetTriple): Promise<void> {
  const label = targetLabel(triple);
  const proc = Bun.spawn(["bunx", "hutch", "build", "--target", label], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`hutch build failed for ${label} (exit ${code})`);
  }
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  if (!skipBuild) {
    for (const triple of targetTriples()) {
      process.stdout.write(`building ${targetLabel(triple)}\n`);
      await buildTarget(triple);
    }
  }

  const artifacts = enforceSizeGate(ARTIFACTS_DIR);
  if (artifacts.length === 0) {
    process.stdout.write(
      "no bundle artifacts found under " + ARTIFACTS_DIR + " — gate not enforced\n",
    );
    return;
  }
  for (const a of artifacts) {
    process.stdout.write(
      `${a.path}: ${(a.bytes / (1024 * 1024)).toFixed(1)} MB (limit 100 MB)\n`,
    );
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`build: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}