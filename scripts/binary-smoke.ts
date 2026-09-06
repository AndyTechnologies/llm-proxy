#!/usr/bin/env bun
/**
 * Task 4.3 (MAJOR-3) — binary smoke: the compiled gateway serves the
 * embedded SPA from an unrelated cwd.
 *
 * The binary (built by `bun run build:binary`, which embeds `dist/ui` via
 * `--asset`, task 4.1) must, when spawned from a throwaway directory OUTSIDE
 * the repository:
 *
 *   1. serve `/ui` (embedded index.html, read-only path resolves)
 *   2. serve `/ui/assets/*` (hashed entry chunks, correct content type)
 *   3. fall back to index.html for unknown GETs under /ui/, while malicious
 *      segments (leading dot, empty) return 404 WITHOUT fallback
 *   4. prefer a `dist/ui` copy in the cwd over the embedded assets
 *   5. let `UI_DIR` override both the disk copy and the embedded assets
 *
 * Shared helpers (`createSmokeWorkspace`, `spawnSmokeGateway`,
 * `collectSmokeEvidence`, `assertSmokeEvidence`) are imported by
 * `scripts/binary-smoke.test.ts`, which drives the same real spawns+probes.
 *
 * CLI usage (cwd-independent — all paths absolute):
 *   bun scripts/binary-smoke.ts            # smoke the prebuilt dist/llm-proxy
 *   bun scripts/binary-smoke.ts --build    # ALSO build the binary from this cwd
 */
import { spawn, spawnSync, type Subprocess } from "bun";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAppJs } from "./measure-bundle.js";

const LISTENING_URL_RE =
  /"message":"OpenAI-compatible API listening","url":"([^"]+)"/;

/** Wait up to timeoutMs for the gateway to report its listening URL. */
const LISTEN_TIMEOUT_MS = 20_000;

// ── Workspace ──────────────────────────────────────────────────────────────

/**
 * Reserve a free TCP port by binding Bun.serve on port 0, reading the
 * assigned port, and closing it again. The gateway config requires a positive
 * `server.port` (schema), so the smoke can't use port 0 itself.
 */
export function pickFreePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = probe.port;
  probe.stop();
  if (port === undefined) {
    throw new Error("[smoke] could not reserve a free port");
  }
  return port;
}

/** A throwaway gateway runtime directory: config + models + a fake GGUF. */
export interface SmokeWorkspace {
  dir: string;
  configPath: string;
  modelsDir: string;
}

/**
 * Create a minimal, schema-valid gateway workspace under `rootDir`.
 * autoStart:false + an absolute existing binary (/bin/true) keep the boot
 * fast and hermetic — no llama-server is spawned; the /ui handler is what
 * this smoke exercises. `server.port` is a freshly reserved free port (the
 * actual bound URL still comes from the boot log).
 */
export function createSmokeWorkspace(rootDir: string): SmokeWorkspace {
  mkdirSync(rootDir, { recursive: true });
  const modelsDir = path.join(rootDir, "models");
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(path.join(modelsDir, "smoke.gguf"), "");
  const configPath = path.join(rootDir, "llm-proxy.config.yaml");
  const config = [
    "server:",
    '  host: "127.0.0.1"',
    `  port: ${pickFreePort()}`,
    "llama:",
    '  binary: "/bin/true"',
    "  autoStart: false",
    `  modelsDir: "${modelsDir}"`,
    "  models:",
    "    smoke:",
    '      file: "smoke.gguf"',
    "      ctx: 1024",
    "      temp: 0.1",
    "",
  ].join("\n");
  writeFileSync(configPath, config);
  return { dir: rootDir, configPath, modelsDir };
}

// ── Spawn ──────────────────────────────────────────────────────────────────

/** A spawned gateway: the subprocess handle plus its discovered base URL. */
export interface RunningGateway {
  proc: Subprocess<"ignore", "pipe", "inherit">;
  baseUrl: string;
}

/** Extra environment variables merged over process.env for the spawn. */
export interface SpawnEnv {
  CONFIG_FILE: string;
  UI_DIR?: string;
}

/**
 * Spawn the compiled binary with cwd = the workspace dir (unrelated to the
 * repo) and wait for the "listening" JSON line to learn the actual port
 * (`server.port: 0` → Bun assigns a free port; the baseUrl comes from the
 * boot log).
 */
export async function spawnSmokeGateway(
  binary: string,
  workspace: SmokeWorkspace,
  uiDir?: string,
): Promise<RunningGateway> {
  const env: SpawnEnv = { CONFIG_FILE: workspace.configPath };
  if (uiDir) env.UI_DIR = uiDir;

  const proc = spawn({
    cmd: [binary],
    cwd: workspace.dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + LISTEN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(LISTENING_URL_RE);
      if (m) return { proc, baseUrl: m[1]! };
    }
  } finally {
    reader.releaseLock();
  }
  try {
    proc.kill();
  } catch {
    // already gone
  }
  throw new Error(
    `[smoke] binary "${binary}" did not report a listening URL within ` +
      `${LISTEN_TIMEOUT_MS}ms. Output so far:\n${buf}`,
  );
}

// ── Probes ─────────────────────────────────────────────────────────────────

/** A single HTTP probe result against the spawned gateway. */
export interface ProbeResult {
  status: number;
  contentType: string;
  body: string;
}

/** GET `pathname` (literal) against the gateway and capture status/type/body. */
export async function probe(
  baseUrl: string,
  pathname: string,
): Promise<ProbeResult> {
  const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: await res.text(),
  };
}

// ── Evidence ───────────────────────────────────────────────────────────────

/** Collected probe results for the five delivery behaviors. */
export interface SmokeEvidence {
  indexStatus: number;
  indexContentType: string;
  assetStatus: number;
  assetContentType: string;
  fallbackStatus: number;
  fallbackContentType: string;
  /** Malicious segment (leading-dot file, e.g. `/ui/.hidden`): 404, JSON. */
  traversalStatus: number;
  traversalContentType: string;
  /** Body served from the cwd's `dist/ui/index.html` copy. */
  diskIndexBody: string;
  /** Body served from the UI_DIR override's index.html. */
  overrideIndexBody: string;
  overrideAssetStatus: number;
}

/**
 * Run the full binary smoke against a REAL compiled binary and REAL HTTP
 * probes. Three gateway instances are spawned from three distinct
 * unreleated-cwd subdirectories under `workspaceRoot`:
 *
 *   embedded/  — bare workspace, no dist/ui: proves the EMBEDDED assets
 *   disk/      — workspace with a dist/ui copy + marker: disk fallback wins
 *   override/  — workspace with a dist/ui copy + UI_DIR marker: override wins
 *
 * Override/UI-DIR pathname probes: `/ui/assets/<entry>` (hashed app JS),
 * `/ui/some-unknown-route` (SPA fallback) and `/ui/.hidden` (leading-dot
 * segment → resolveUiAsset null → 404 without fallback).
 */
export async function collectSmokeEvidence(
  binary: string,
  workspaceRoot: string,
  uiDir: string,
): Promise<SmokeEvidence> {
  const assetsDir = path.join(uiDir, "assets");
  if (!existsSync(assetsDir)) {
    throw new Error(
      `[smoke] ${assetsDir} missing — run "bun run build:ui" first`,
    );
  }
  const entry = findAppJs(readdirSync(assetsDir));
  if (!entry) {
    throw new Error(`[smoke] no index-*.js entry under ${assetsDir}`);
  }

  // 1. Embedded serving (bare workspace — no dist/ui on disk anywhere).
  const wsEmbed = createSmokeWorkspace(path.join(workspaceRoot, "embedded"));
  const s1 = await spawnSmokeGateway(binary, wsEmbed);
  let index: ProbeResult;
  let asset: ProbeResult;
  let fallback: ProbeResult;
  let traversal: ProbeResult;
  try {
    index = await probe(s1.baseUrl, "/ui");
    asset = await probe(s1.baseUrl, `/ui/assets/${entry}`);
    fallback = await probe(s1.baseUrl, "/ui/some-unknown-route");
    traversal = await probe(s1.baseUrl, "/ui/.hidden");
  } finally {
    try {
      s1.proc.kill();
    } catch {
      // already gone
    }
  }

  // 2. Disk fallback: copy the compiled SPA into the cwd, marker index.html.
  const wsDisk = createSmokeWorkspace(path.join(workspaceRoot, "disk"));
  cpSync(uiDir, path.join(wsDisk.dir, "dist", "ui"), { recursive: true });
  writeFileSync(path.join(wsDisk.dir, "dist", "ui", "index.html"), "DISK-FALLBACK");
  const s2 = await spawnSmokeGateway(binary, wsDisk);
  let diskIndex: ProbeResult;
  try {
    diskIndex = await probe(s2.baseUrl, "/ui");
  } finally {
    try {
      s2.proc.kill();
    } catch {
      // already gone
    }
  }

  // 3. UI_DIR override: override dir with its own index + asset; the cwd
  //    STILL has the disk copy — the override must win over both.
  const overrideDir = path.join(workspaceRoot, "override-ui");
  mkdirSync(path.join(overrideDir, "assets"), { recursive: true });
  writeFileSync(path.join(overrideDir, "index.html"), "OVERRIDE-INDEX");
  writeFileSync(path.join(overrideDir, "assets", "override.js"), "OVERRIDE-JS");
  const wsOverride = createSmokeWorkspace(path.join(workspaceRoot, "override"));
  cpSync(uiDir, path.join(wsOverride.dir, "dist", "ui"), { recursive: true });
  const s3 = await spawnSmokeGateway(binary, wsOverride, overrideDir);
  let overrideIndex: ProbeResult;
  let overrideAsset: ProbeResult;
  try {
    overrideIndex = await probe(s3.baseUrl, "/ui");
    overrideAsset = await probe(s3.baseUrl, "/ui/assets/override.js");
  } finally {
    try {
      s3.proc.kill();
    } catch {
      // already gone
    }
  }

  return {
    indexStatus: index.status,
    indexContentType: index.contentType,
    assetStatus: asset.status,
    assetContentType: asset.contentType,
    fallbackStatus: fallback.status,
    fallbackContentType: fallback.contentType,
    traversalStatus: traversal.status,
    traversalContentType: traversal.contentType,
    diskIndexBody: diskIndex.body,
    overrideIndexBody: overrideIndex.body,
    overrideAssetStatus: overrideAsset.status,
  };
}

/**
 * Shared assertion gate (CLI + CI): throws on the first failing behavior.
 * The bun:test suite asserts the same evidence fields directly.
 */
export function assertSmokeEvidence(evidence: SmokeEvidence): void {
  const checks: Array<[string, boolean]> = [
    ["embedded /ui serves index.html", evidence.indexStatus === 200 && evidence.indexContentType.includes("text/html")],
    ["embedded /ui/assets/* serves the hashed app JS", evidence.assetStatus === 200 && evidence.assetContentType.includes("application/javascript")],
    ["unknown /ui/* GET falls back to index.html", evidence.fallbackStatus === 200 && evidence.fallbackContentType.includes("text/html")],
    ["malicious /ui segment returns 404 JSON (no fallback)", evidence.traversalStatus === 404 && evidence.traversalContentType.includes("application/json")],
    ["disk fallback wins over embedded assets", evidence.diskIndexBody === "DISK-FALLBACK"],
    ["UI_DIR override wins over disk copy and embedded assets", evidence.overrideIndexBody === "OVERRIDE-INDEX" && evidence.overrideAssetStatus === 200],
  ];
  for (const [label, ok] of checks) {
    if (!ok) throw new Error(`[smoke] FAIL: ${label}`);
  }
}

// ── CLI entry (only when executed directly) ────────────────────────────────
async function main(): Promise<void> {
  const repoRoot = path.join(import.meta.dir, "..");
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "llm-proxy-smoke-"));
  let binary = path.join(repoRoot, "dist", "llm-proxy");
  try {
    if (process.argv.includes("--build")) {
      // Build from the CURRENT (possibly unrelated) cwd: absolute paths only.
      const uiDir = path.join(repoRoot, "dist", "ui");
      if (!existsSync(path.join(uiDir, "index.html"))) {
        console.error('[smoke] dist/ui missing — run "bun run build:ui" first');
        process.exit(1);
      }
      binary = path.join(workspaceRoot, "llm-proxy");
      const build = spawnSync([
        "bun",
        "build",
        path.join(repoRoot, "src", "index.ts"),
        "--compile",
        "--outfile",
        binary,
        "--asset",
        uiDir,
      ]);
      if (!build.success) {
        console.error(`[smoke] binary build failed (exit ${build.exitCode})`);
        process.exit(build.exitCode ?? 1);
      }
      console.log(`[smoke] built ${binary}`);
    } else if (!existsSync(binary)) {
      console.error(
        '[smoke] dist/llm-proxy missing — run "bun run build:binary" or pass --build',
      );
      process.exit(1);
    }

    const evidence = await collectSmokeEvidence(
      binary,
      workspaceRoot,
      path.join(repoRoot, "dist", "ui"),
    );
    assertSmokeEvidence(evidence);
    console.log(
      "[smoke] PASS — embedded /ui, /ui/assets/*, SPA fallback + 404 guard, " +
        "disk fallback and UI_DIR override all verified",
    );
    console.log(
      `  /ui → ${evidence.indexStatus} ${evidence.indexContentType}`,
    );
    console.log(
      `  /ui/assets/* → ${evidence.assetStatus} ${evidence.assetContentType}`,
    );
    console.log(
      `  unknown /ui/* → ${evidence.fallbackStatus} (fallback)` +
        ` | malicious segment → ${evidence.traversalStatus} (no fallback)`,
    );
    console.log(`  disk fallback → ${evidence.diskIndexBody}`);
    console.log(
      `  UI_DIR override → ${evidence.overrideIndexBody} (+ asset ${evidence.overrideAssetStatus})`,
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  void main();
}