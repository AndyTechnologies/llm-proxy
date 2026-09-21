/**
 * WeaveLLM release build: host target via Electrobun/Hutch + < 100 MB gate.
 *
 * Usage: `bun run scripts/build-binaries.ts [--skip-build] [--artifacts <dir>]`
 *
 * Electrobun v2 builds are HOST-ONLY — there is no cross-compile. This script
 * builds the bundle for the current host platform only via the real Hutch CLI
 * (`hutch electrobun build --env=stable`; `bunx hutch` is the wrong npm
 * package and `hutch` is not on PATH, so we spawn ~/.hutch/bin/hutch). The
 * full release matrix (darwin-arm64 / darwin-x64 / linux-x64 — see
 * build-binaries-args.ts) requires building on each target platform. After
 * the build, every artifact under the output dir is measured and fails if any
 * bundle exceeds the 100 MB gate (desktop-app-shell / AC #1).
 *
 * This channel emits Cottontail INSTALLER/UPDATE artifacts (e.g.
 * linux-x64-WeaveLLM-Setup.tar.gz, stable-linux-x64-update.json). It is the
 * release-matrix/size-gate script and is NOT the portable distribution path:
 * the user-selected desktop artifact is ONE self-contained executable built
 * by `bun run build:binary` (scripts/build-binary.ts). Keep both paths
 * distinct.
 */

import { homedir } from "node:os";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertBundleSize,
  BUNDLE_SIZE_LIMIT,
  targetLabel,
  targetTriples,
} from "./build-binaries-args.js";

const ARTIFACTS_DIR = process.env.WEAVELLM_ARTIFACTS_DIR ?? "dist";

/** Real Hutch CLI — never `bunx hutch` (wrong npm package). */
const HUTCH_BIN = join(homedir(), ".hutch", "bin", "hutch");

/** Release channel for the bundle: stable = optimized release build. */
const RELEASE_ENV = "stable";

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

/**
 * Label of the host target in the release matrix (e.g. linux-x64).
 * Host-only builds: fails when this machine is not one of the three
 * supported release targets.
 */
export function hostTargetLabel(): string {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : null;
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (platform === null || arch === null) {
    throw new Error(
      `unsupported host ${process.platform}-${process.arch} — ` +
        "the release matrix (darwin-arm64, darwin-x64, linux-x64) must be built on each target platform",
    );
  }
  const label = targetLabel({ platform, arch });
  const known = targetTriples().some((t) => t.platform === platform && t.arch === arch);
  if (!known) {
    throw new Error(`host ${label} is not in the supported release matrix`);
  }
  return label;
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  if (!skipBuild) {
    // hutch electrobun build is host-only: no --target flag.
    const host = hostTargetLabel();
    process.stdout.write(
      `building host target ${host} (Electrobun v2: no cross-compile)\n`,
    );
    const proc = Bun.spawn([HUTCH_BIN, "electrobun", "build", `--env=${RELEASE_ENV}`], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`hutch electrobun build --env=${RELEASE_ENV} failed (exit ${code})`);
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