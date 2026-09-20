/**
 * Portable single-file binary build — `bun run build:binary`.
 *
 * Produces ONE self-contained executable `dist/weavellm` that packages the
 * complete app (Electrobun shell + Bun main process + SPA UI) and opens the
 * Electrobun UI when run. NO installer, NO auto-updater, NO Cottontail setup
 * artifacts — the user-selected AppImage-style single-file form.
 *
 * Pipeline (see odd/tasks/portable-single-binary.md):
 *
 *   1. Build the SPA (`bun run build:frontend`) unless --skip-frontend.
 *   2. Build the Electrobun DEV bundle via the real Hutch CLI
 *      (`hutch electrobun build --env=dev`; `bunx hutch` is the wrong npm
 *      package and `hutch` is not on PATH, so we spawn ~/.hutch/bin/hutch),
 *      unless --skip-build. Electrobun v2 builds are HOST-ONLY — the bundle
 *      lands at build/dev-<host>/WeaveLLM-dev/ and is the flat self-contained
 *      runnable payload (bin/launcher + bin/bun + libs + Resources/app/ui).
 *   3. tar.gz the bundle CONTENTS (payload extracts to bin/, Resources/ at
 *      its root).
 *   4. Compile the tiny C stub (scripts/selfextract.c, ~30 KB — a bun
 *      --compile stub alone is 77.6 MB and would blow the 100 MB gate).
 *   5. Assemble dist/weavellm = stub + payload + trailer (byte layout owned
 *      by scripts/selfextract-layout.ts; the C header is generated from it).
 *   6. Enforce the < 100 MB gate (desktop-app-shell AC #1 / AC #4) and report.
 *
 * Usage: `bun run scripts/build-binary.ts [--skip-frontend] [--skip-build]`
 *
 * This is the portable path. `build:binaries` (scripts/build-binaries.ts)
 * remains the release-matrix gate for the Cottontail installer/update flow
 * and is NOT what the user chose for desktop distribution.
 */

import { homedir } from "node:os";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { assertBundleSize, BUNDLE_SIZE_LIMIT } from "./build-binaries-args.js";
import {
  buildTrailer,
  extractCacheDir,
  payloadSha256Hex,
  renderTrailerHeader,
  resolveCacheBase,
  withRenderEnv,
} from "./selfextract-layout.js";

const OUT_DIR = process.env.WEAVELLM_ARTIFACTS_DIR ?? "dist";
const BUILD_DIR = "build";
/** Real Hutch CLI — never `bunx hutch` (wrong npm package). */
const HUTCH_BIN = join(homedir(), ".hutch", "bin", "hutch");
/** The dev bundle is the portable payload (flat, runnable, includes the SPA). */
const BUNDLE_ENV = "dev";
/** C source of the self-extracting stub. */
const STUB_SRC = "scripts/selfextract.c";
/** C compiler override (default: cc). */
const CC = process.env.CC ?? "cc";

/** Host label for the dev bundle dir (mirrors hostTargetLabel in
 * build-binaries.ts — the release matrix lives there). */
function hostLabel(): string {
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
      `unsupported host ${process.platform}-${process.arch} — the portable binary is host-only`,
    );
  }
  return `${platform}-${arch}`;
}

/** Electrobun dev bundle dir for the current host (build/dev-<host>/). */
function devBundleDir(): string {
  return join(BUILD_DIR, `${BUNDLE_ENV}-${hostLabel()}`, "WeaveLLM-dev");
}

async function run(args: string[], what: string): Promise<void> {
  const proc = Bun.spawn(args, {
    env: withRenderEnv(Bun.env),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${what} failed (exit ${code})`);
  }
}

async function buildFrontend(): Promise<void> {
  await run(["bun", "run", "build:frontend"], "frontend build (build:frontend)");
}

async function buildBundle(): Promise<void> {
  const label = hostLabel();
  process.stdout.write(
    `building host target ${label} dev bundle (Electrobun v2: no cross-compile)\n`,
  );
  await run(
    [HUTCH_BIN, "electrobun", "build", `--env=${BUNDLE_ENV}`],
    `hutch electrobun build --env=${BUNDLE_ENV}`,
  );
}

async function compressPayload(bundleDir: string, payloadPath: string): Promise<void> {
  // Tar the CONTENTS of the bundle dir so extraction yields bin/, Resources/
  // at the payload root. The temp archive lives outside the source dir.
  await run(
    ["tar", "-czf", payloadPath, "-C", bundleDir, "."],
    `tar payload (${bundleDir})`,
  );
}

async function compileStub(headerPath: string, stubBin: string): Promise<void> {
  mkdirSync(BUILD_DIR, { recursive: true });
  await Bun.write(headerPath, renderTrailerHeader());
  await run(
    [CC, "-O2", "-s", "-Wall", "-Wextra", "-I", BUILD_DIR, "-o", stubBin, STUB_SRC],
    `compile self-extracting stub (${CC})`,
  );
}

function assemble(outPath: string, stubBin: string, payloadPath: string): string {
  const payload = readFileSync(payloadPath);
  const trailer = buildTrailer(payload);
  copyFileSync(stubBin, outPath);
  appendFileSync(outPath, payload);
  appendFileSync(outPath, trailer);
  chmodSync(outPath, 0o755);
  return payloadSha256Hex(payload);
}

async function main(): Promise<void> {
  const skipFrontend = process.argv.includes("--skip-frontend");
  const skipBuild = process.argv.includes("--skip-build");

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  if (!skipFrontend) {
    await buildFrontend();
  }
  if (!skipBuild) {
    await buildBundle();
  }

  const bundleDir = devBundleDir();
  const bundleStat = statSync(bundleDir, { throwIfNoEntry: false });
  if (bundleStat === undefined || !bundleStat.isDirectory()) {
    throw new Error(
      `dev bundle not found at ${bundleDir} — run without --skip-build first`,
    );
  }

  const payloadPath = join(BUILD_DIR, "weavellm-payload.tar.gz");
  await compressPayload(bundleDir, payloadPath);

  const headerPath = join(BUILD_DIR, "selfextract-trailer.h");
  const stubBin = join(BUILD_DIR, "selfextract");
  await compileStub(headerPath, stubBin);

  const outPath = join(OUT_DIR, "weavellm");
  const hash = assemble(outPath, stubBin, payloadPath);
  const bytes = statSync(outPath).size;

  assertBundleSize(bytes, BUNDLE_SIZE_LIMIT);

  const cacheBase = resolveCacheBase(Bun.env.XDG_CACHE_HOME, Bun.env.HOME);
  process.stdout.write(
    `${outPath}: ${(bytes / (1024 * 1024)).toFixed(1)} MB (limit 100 MB)\n` +
      `payload sha256: ${hash}\n` +
      `first run extracts to: ${extractCacheDir(cacheBase, hash)}\n`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`build:binary: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}