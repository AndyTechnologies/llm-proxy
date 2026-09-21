/**
 * Electrobun v2 build configuration — WeaveLLM desktop shell.
 *
 * Verified v2 API (electrobun.dev docs, migrating-to-v2):
 * - `build.mainProcess: "bun"` + `build.bun.entrypoint` — Bun main process.
 * - No `targets` / `mac` / `linux` section: Electrobun v2 builds are HOST-ONLY
 *   (no cross-compile) — build the release matrix on each target platform.
 * - The webview opens in the main process via `new BrowserWindow({ url })`
 *   from `electrobun/main`; the window loads this app's own server
 *   (http://127.0.0.1:<port>/), no bundled views.
 * - Real CLI (never `bunx hutch`, which is the wrong npm package):
 *     ~/.hutch/bin/hutch electrobun build --env=<dev|canary|stable>
 *     ~/.hutch/bin/hutch electrobun run --env=<env>
 */

import type { ElectrobunConfig } from "electrobun";

const config = {
  app: {
    name: "WeaveLLM",
    identifier: "dev.weavellm.app",
    version: "0.1.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main.ts",
    },
    // Ship the compiled SPA inside the bundle so the desktop binary is
    // self-contained (no repo path / no process.cwd() dependency).
    copy: {
      "frontend/dist": "ui",
    },
  },
} satisfies ElectrobunConfig;

export default config;
export { config };