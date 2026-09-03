#!/usr/bin/env bun
/**
 * Cross-compile helper for the release CI job (and `bun run build:binaries`).
 *
 * Builds the gateway source into native executables for every Bun 1.4 target
 * using `bun build --compile --target=bun-<os>-<arch>`. Bun appends `.exe`
 * automatically for the Windows targets, so the outfile names here don't carry
 * a manual extension.
 *
 * Not part of the production build — it lives under `scripts/` so `dist/`
 * packaging and the `src/` typecheck stay independent. Calls the OVEN `bun`
 * CLI through child_process so the six compiles each run in a clean process.
 */
import { spawnSync } from "node:child_process";

/** Bun 1.4 cross-compile targets: `--target=bun-<os>-<arch>`. */
const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
] as const;

const OUT_DIR = "dist";
const ENTRY = "src/index.ts";

for (const target of TARGETS) {
  const name = `llm-proxy-${target}`;
  const outfile = `${OUT_DIR}/${name}`;
  console.log(`[build] ${target} -> ${outfile} (.exe auto-appended for windows)`);

  const result = spawnSync(
    "bun",
    ["build", ENTRY, "--compile", "--target", target, "--outfile", outfile],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.error(`[build] FAILED ${target} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

console.log(`[build] all binaries written to ${OUT_DIR}/`);
