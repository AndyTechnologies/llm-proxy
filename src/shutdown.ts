/**
 * Graceful shutdown / drain sequence.
 *
 * Extracted from index.ts so the drain test can import it WITHOUT triggering
 * index.ts's module-level side effects (config load → manager.start() →
 * real llama-server spawn → Bun.serve). Importing index.ts from a test spawned
 * and leaked a real llama-server (orphaned to init), which is why this pure
 * function lives in its own side-effect-free module.
 *
 * The function is PURE: every call executes the full drain sequence. Producing
 * idempotency is the responsibility of the call-site (the signal handlers in
 * index.ts keep a module-level `shuttingDown` guard) — NOT this function — so
 * tests can call it repeatedly with isolated double stubs.
 */
export type ShutdownServer = { stop(force: boolean): Promise<void> | void };
export type ShutdownManager = { stop(): Promise<void> | void };
export type ShutdownLogFn = (
  level: string,
  message: string,
  extra?: Record<string, unknown>,
) => void;
export type ShutdownExitFn = (code?: number) => never;

/**
 * Drain in-flight requests, stop the backend, and exit cleanly.
 *
 * Bounded drain (health-endpoints Req 5): stop accepting new connections and
 * drain in-flight requests gracefully; if a connection outlives the window
 * (3s), force-close it so shutdown always completes with no orphans.
 *
 * @param reason      Why the process is shutting down (logged).
 * @param serverInstance   Bun.serve instance (or test stub).
 * @param managerInstance  Backend manager (or test stub).
 * @param logFn            JSON logger (info/warn → stdout; error → stderr).
 * @param exitFn           process.exit, injectable for tests.
 */
export async function shutdown(
  reason: string,
  serverInstance: ShutdownServer,
  managerInstance: ShutdownManager,
  logFn: ShutdownLogFn,
  exitFn: ShutdownExitFn,
): Promise<void> {
  logFn("info", "shutting down", { reason });

  const forceClose = setTimeout(() => {
    serverInstance.stop(true);
  }, 3000);
  forceClose.unref();

  await serverInstance.stop(false);
  clearTimeout(forceClose);

  await managerInstance.stop();
  logFn("info", "shutdown complete", { reason });
  exitFn(0);
}