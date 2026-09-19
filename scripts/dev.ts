/**
 * WeaveLLM dev launcher: runs the backend (`bun run --watch src/main.ts`)
 * and the Astro dev server in parallel, sharing the terminal. Ctrl+C kills
 * both; the runner exits with the exit code of whichever child dies first.
 */

import type { Subprocess } from "bun";

const BACKEND_CMD = ["bun", "run", "--watch", "src/main.ts"];
const FRONTEND_CMD = ["bun", "run", "dev:frontend"];
const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;

function spawnChild(label: string, cmd: string[]): Subprocess {
  const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
  process.stdout.write(`[dev] ${label}: ${cmd.join(" ")}\n`);
  return proc;
}

async function main(): Promise<void> {
  const children: Subprocess[] = [
    spawnChild("backend", BACKEND_CMD),
    spawnChild("frontend", FRONTEND_CMD),
  ];

  // Forward termination signals to both children; once a child dies the
  // race below ends and the runner exits with that child's exit code.
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      for (const child of children) child.kill(signal);
    });
  }

  const first = await Promise.race(children.map((child) => child.exited));
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exit(first ?? 0);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`dev: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}