/**
 * JSON logger tests (S3.1 — structured JSON logs, health-endpoints Req 4).
 *
 * Verifies the pure `logJson` emitter produces a single-line JSON object that
 * ALWAYS carries `level` and `message`, plus any extra fields, and never
 * emits a bare string without a level.
 */
import { describe, expect, test } from "bun:test";
import { logJson } from "./logger.js";

describe("logJson", () => {
  test("emits a single-line JSON object with level and message", () => {
    const line = logJson("info", "config loaded: 6 chains");
    const parsed = JSON.parse(line) as { level: string; message: string };
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("config loaded: 6 chains");
  });

  test("carries extra fields through", () => {
    const line = logJson("error", "backend failed to start", {
      pid: 1234,
      reason: "posix_spawn ENOENT",
    });
    const parsed = JSON.parse(line) as {
      level: string;
      message: string;
      pid: number;
      reason: string;
    };
    expect(parsed.level).toBe("error");
    expect(parsed.message).toBe("backend failed to start");
    expect(parsed.pid).toBe(1234);
    expect(parsed.reason).toBe("posix_spawn ENOENT");
  });

  test("supports the warn/fatal levels used at shutdown and fatal paths", () => {
    expect(JSON.parse(logJson("warn", "restarting")).level).toBe("warn");
    expect(JSON.parse(logJson("fatal", "uncaught")).level).toBe("fatal");
  });
});
