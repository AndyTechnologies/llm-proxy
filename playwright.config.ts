/**
 * Playwright E2E configuration for the llm-proxy dashboard.
 *
 * Boots the harness via `bun run e2e-server` (see e2e/e2e-server.ts) — a real
 * `createApp` with FAKE manager/providers, serving the real `/ui` SPA. No real
 * llama-server backend is spawned, so these tests run fully offline/deterministic.
 *
 * - webServer.command: `bun run e2e-server` → Bun CLI runs the harness directly.
 * - baseURL: fixed http://127.0.0.1:8099 (matches e2e-server's default port).
 * - Browser: Brave locally (via executablePath), stock Chromium on CI (GitHub
 *   runners have no Brave; the e2e job installs Chromium itself).
 * - On CI (fullyParallel=false, reuseExistingServer=false) Playwright owns the
 *   server lifecycle; locally it reuses an already-running harness when present.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Fast, readable reporter for both local and CI.
  reporter: "list",
  outputDir: "test-results",
  // Browser engine selection:
  //   - Local dev: run against Brave (Chromium-based) via its native executable.
  //     Brave has NO official Playwright channel, so we point `executablePath`
  //     at the system install. Playwright gives no compatibility guarantee for
  //     a fork like Brave, but the dashboard SPA is plain vanilla JS/DOM, so it
  //     drives correctly. Override the path with PLAYWRIGHT_BRAVE_PATH if your
  //     Brave lives elsewhere.
  //   - CI: Brave is not available on GitHub runners, so the E2E job installs
  //     stock Chromium (`bunx playwright install --with-deps chromium`) and runs
  //     against that default.
  use: {
    baseURL: "http://127.0.0.1:8099",
    trace: "on-first-retry",
    ...(!process.env.CI
      ? {
          launchOptions: {
            executablePath:
              process.env.PLAYWRIGHT_BRAVE_PATH || "/usr/bin/brave",
          },
        }
      : {}),
  },
  webServer: {
    command: "bun run e2e-server",
    url: "http://127.0.0.1:8099/ui",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  // Fully parallel tests desync shared dashboard state (single in-memory
  // tracker/SSE bus); keep them serial in CI for determinism.
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
});
