/**
 * Desktop launcher — `bun run start` target.
 *
 * The deployed binary is an Electrobun bundle (webview window + Bun main
 * process). Its faithful local equivalent is: build the compiled frontend
 * (done by the `start` npm script chain) into the host desktop bundle, then
 * run it via the real Hutch CLI.
 *
 * `hutch` is not on PATH and `bunx hutch` resolves the WRONG npm package, so
 * this spawns the real CLI directly from ~/.hutch/bin.
 *
 * Electrobun v2 builds are host-only (no cross-compile) and `--env=dev`
 * produces a runnable bundle with diagnostics. `--env=stable` is the
 * optimized release channel; flip it here (build AND run together) once it is
 * verified on a signed host.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const HUTCH_BIN = join(homedir(), ".hutch", "bin", "hutch");
const ENV = "dev";

/**
 * WebKitGTK on Xwayland + NVIDIA cannot create GBM/GLX buffers for the
 * webview (GLXBadWindow, "Failed to create GBM buffer"), which renders the
 * window black even though the UI loads fine. Disable the DMABUF renderer by
 * default so `bun run start` works out of the box; an explicit env override
 * still wins.
 */
function desktopEnv(): Record<string, string> {
  return {
    ...Bun.env,
    WEBKIT_DISABLE_DMABUF_RENDERER: Bun.env.WEBKIT_DISABLE_DMABUF_RENDERER ?? "1",
  };
}

async function runHutch(args: string[]): Promise<number> {
  const proc = Bun.spawn([HUTCH_BIN, ...args], {
    env: desktopEnv(),
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function main(): Promise<void> {
  const buildCode = await runHutch(["electrobun", "build", `--env=${ENV}`]);
  if (buildCode !== 0) {
    throw new Error(`hutch electrobun build --env=${ENV} failed (exit ${buildCode})`);
  }
  const runCode = await runHutch(["electrobun", "run", `--env=${ENV}`]);
  if (runCode !== 0) {
    throw new Error(`hutch electrobun run --env=${ENV} failed (exit ${runCode})`);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}