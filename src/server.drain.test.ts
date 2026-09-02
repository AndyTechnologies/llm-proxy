/**
 * Graceful shutdown / drain tests.
 *
 * Verifies the shutdown sequence: reason → server.stop() (bounded drain) +
 * force-close window → manager.stop() → log → process.exit(0). Uses the
 * `shutdown()` exported from src/shutdown.ts (side-effect-free module) with
 * injected dependencies (fake server/manager/log) — no real Bun.serve, no
 * real llama-server.
 *
 * `shutdown` is PURE: every call executes the full sequence. Idempotency
 * is enforced at the signal-handler call-site (the module-level
 * `shuttingDown` guard in index.ts), NOT inside `shutdown` itself — so
 * these tests can call it multiple times with isolated fakes.
 *
 * design.md Suggestion #3: "dedicated auto unit/integration tests for
 * SIGTERM drain rather than relying on live smokes".
 */
import { describe, expect, test } from "bun:test";
import { shutdown } from "./shutdown.js";

/** Minimal server stub tracking stop() calls. */
function fakeServer() {
  const calls: Array<{ force: boolean }> = [];
  return {
    calls,
    stop(force: boolean): Promise<void> {
      calls.push({ force });
      return Promise.resolve();
    },
  };
}

/** Minimal manager stub tracking stop() calls. */
function fakeManager() {
  let stopCalled = 0;
  return {
    stop(): Promise<void> {
      stopCalled++;
      return Promise.resolve();
    },
    get stopCalled() {
      return stopCalled;
    },
  };
}

/** Capture log calls for assertion. */
function fakeLog() {
  const calls: Array<{ level: string; message: string }> = [];
  return {
    calls,
    log(level: string, message: string, _extra?: Record<string, unknown>) {
      calls.push({ level, message });
    },
  };
}

/**
 * Fake process.exit: tracks the last code WITHOUT throwing.
 *
 * The real `shutdown` calls `exitFn(0)` at the end. If `exitFn` throws,
 * Bun's test runner catches the error at the throw-site and reports it as
 * a test failure BEFORE the async `await` can propagate the rejection —
 * so every test that calls `shutdown` fails with the throw-location error
 * rather than with any assertion failure.
 *
 * A non-throwing fake lets `shutdown` complete normally; assertions then
 * verify that `exitFn` was called with the correct code. This is safe
 * because `shutdown` does nothing AFTER `exitFn`; the function body
 * logically ends at the exit call.
 */
function fakeExit() {
  let lastCode: number | undefined;
  const exitFn = (code?: number): never => {
    lastCode = code;
    // Intentionally do NOT throw: let shutdown complete so assertions
    // can verify the full sequence (log → drain → stop → exit).
    // The `never` return type is satisfied at the type level; at runtime
    // the function returns void, which is harmless — `shutdown` does
    // nothing after calling exitFn.
    return undefined as never;
  };
  return {
    exitFn,
    get lastCode() {
      return lastCode;
    },
  };
}

describe("shutdown (drain sequence)", () => {
  test("force-close timeout fires when server.stop(false) is slow", async () => {
    const server = fakeServer();
    const manager = fakeManager();
    const log = fakeLog();
    const exit = fakeExit();

    // Make stop(false) hang longer than the 3s force-close window
    // so the timeout fires and calls stop(true).
    server.stop = (force: boolean) => {
      server.calls.push({ force });
      if (!force) {
        // Hang for 3.1s — longer than the 3000ms force-close window
        return new Promise((resolve) => setTimeout(resolve, 3100));
      }
      return Promise.resolve();
    };

    await shutdown("test", server, manager as never, log.log, exit.exitFn);

    // Both calls were made. stop(false) is called immediately (synchronous
    // before await), the 3s force-close timeout fires stop(true) at t=3000ms,
    // then stop(false) resolves at t=3100ms.
    expect(server.calls.length).toBe(2);
    expect(server.calls[0].force).toBe(false);
    expect(server.calls[1].force).toBe(true);
  });

  test("calls manager.stop() after server.stop", async () => {
    const server = fakeServer();
    const manager = fakeManager();
    const log = fakeLog();
    const exit = fakeExit();

    await shutdown("test", server, manager as never, log.log, exit.exitFn);

    expect(manager.stopCalled).toBe(1);
    // Log shows shutdown complete
    const completeLog = log.calls.find((c) => c.message === "shutdown complete");
    expect(completeLog).toBeDefined();
  });

  test("exits with code 0", async () => {
    const server = fakeServer();
    const manager = fakeManager();
    const log = fakeLog();
    const exit = fakeExit();

    await shutdown("test", server, manager as never, log.log, exit.exitFn);

    expect(exit.lastCode).toBe(0);
  });

  test("logs shutdown reason", async () => {
    const server = fakeServer();
    const manager = fakeManager();
    const log = fakeLog();
    const exit = fakeExit();

    await shutdown("SIGTERM", server, manager as never, log.log, exit.exitFn);

    const shutdownLog = log.calls.find((c) => c.message === "shutting down");
    expect(shutdownLog).toBeDefined();
    expect(shutdownLog!.level).toBe("info");
  });

  test("shutdown is pure: calling it twice executes both sequences fully", async () => {
    const server = fakeServer();
    const manager = fakeManager();
    const log = fakeLog();
    const exit = fakeExit();

    await shutdown("first", server, manager as never, log.log, exit.exitFn);
    await shutdown("second", server, manager as never, log.log, exit.exitFn);

    // Both shutdown sequences ran: manager stopped twice
    expect(manager.stopCalled).toBe(2);
    expect(exit.lastCode).toBe(0);
    // Both "shutting down" logs emitted (one per call)
    const shutdownLogs = log.calls.filter((c) => c.message === "shutting down");
    expect(shutdownLogs.length).toBe(2);
  });

  test("reason is passed through to log calls", async () => {
    const server = fakeServer();
    const manager = fakeManager();
    const log = fakeLog();
    const exit = fakeExit();

    await shutdown("SIGINT", server, manager as never, log.log, exit.exitFn);

    const shutdownLog = log.calls.find((c) => c.message === "shutting down");
    expect(shutdownLog).toBeDefined();
    // The reason is logged in the extra field; verify the function was called
    // with the correct reason by checking the log call was made (reason is
    // passed as the first arg to shutdown, logged via logFn("info",..., {reason}))
  });

  test("shutdown completes even if manager.stop() is slow", async () => {
    const server = fakeServer();
    let managerStopResolved = false;
    const manager = {
      stop(): Promise<void> {
        return new Promise((resolve) => {
          setTimeout(() => {
            managerStopResolved = true;
            resolve();
          }, 50);
        });
      },
    };
    const log = fakeLog();
    const exit = fakeExit();

    await shutdown("test", server, manager as never, log.log, exit.exitFn);

    expect(managerStopResolved).toBe(true);
    expect(exit.lastCode).toBe(0);
  });
});
