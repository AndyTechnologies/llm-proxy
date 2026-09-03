/**
 * Config atomic write tests (strict TDD — Slice A, config-load Req "Atomic
 * config write" + "Zod schema validation preserved").
 *
 * Covers:
 *   - writes to a temp file in the SAME directory, then renames over the target
 *     (atomic — never a partial mixture),
 *   - the persisted YAML is re-serialized from the validated config (round-trip
 *     re-serialization),
 *   - the config is re-validated via zod BEFORE any write,
 *   - a failed write (before the rename) leaves the prior config intact.
 */
import { describe, expect, test } from "bun:test";
import type { GatewayConfig } from "./schema.js";
import { persistConfig, type PersistDeps } from "./write.js";

function validConfig(): GatewayConfig {
  return {
    server: { host: "127.0.0.1", port: 8090, corsOrigins: "*", jsonLimit: "10mb" },
    llama: {
      binary: "llama",
      host: "127.0.0.1",
      port: 0,
      autoStart: true,
      startupTimeoutMs: 30000,
      stopTimeoutMs: 5000,
      requestTimeoutMs: 300000,
      healthPollIntervalMs: 1000,
      portParseTimeoutMs: 5000,
      backoffCapMs: 30000,
      maxRestartAttempts: 5,
      modelsDir: "~/Models",
      autoload: true,
      router: {},
      models: {},
    },
    chains: {},
  };
}

/** Records the writes/renames performed, plus prior-content tracking. */
function recordingDeps(over: Partial<PersistDeps> = {}): {
  deps: PersistDeps;
  writes: Array<{ path: string; data: string }>;
  renames: Array<{ from: string; to: string }>;
} {
  const writes: Array<{ path: string; data: string }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  const deps: PersistDeps = {
    write: async (p: string, data: string) => {
      writes.push({ path: p, data });
      return data.length;
    },
    rename: (from: string, to: string) => {
      renames.push({ from, to });
    },
    stringify: (cfg: GatewayConfig) => `server:\n  port: ${cfg.server.port}\n`,
    tmpPath: (target: string, n: number) => `${target}.tmp-${n}`,
    ...over,
  };
  return { deps, writes, renames };
}

describe("persistConfig — atomic write", () => {
  test("writes a temp file in the same directory then renames over the target", async () => {
    const { deps, writes, renames } = recordingDeps();
    const target = "/cfg/llm-proxy.config.yaml";

    await persistConfig(validConfig(), target, deps);

    expect(writes).toHaveLength(1);
    // Temp file is named in the target's directory (not elsewhere).
    expect(writes[0].path).toContain("/cfg/");
    expect(writes[0].path).toContain(".tmp-");
    // Rename moves the temp over the target.
    expect(renames).toHaveLength(1);
    expect(renames[0].from).toBe(writes[0].path);
    expect(renames[0].to).toBe(target);
  });

  test("re-serializes the validated config to YAML (round-trip)", async () => {
    const { deps, writes } = recordingDeps();
    await persistConfig(validConfig(), "/cfg/config.yaml", deps);
    expect(writes[0].data).toContain("server:");
    expect(writes[0].data).toContain("port: 8090");
  });
});

describe("persistConfig — failed write leaves the prior config intact", () => {
  test("a write that aborts before the rename never renames and throws", async () => {
    const { deps, renames } = recordingDeps({
      write: async () => {
        throw new Error("disk error");
      },
    });
    const target = "/cfg/llm-proxy.config.yaml";

    await expect(persistConfig(validConfig(), target, deps)).rejects.toThrow(
      "disk error",
    );
    // The rename (the atomic swap) must NOT have happened.
    expect(renames).toHaveLength(0);
  });
});

describe("persistConfig — re-validation before persist", () => {
  test("an invalid config fails zod validation and writes nothing", async () => {
    const { deps, writes } = recordingDeps();
    const broken = {
      server: { host: "127.0.0.1", port: -5, corsOrigins: "*", jsonLimit: "10mb" },
      llama: {},
      chains: {},
    } as unknown as GatewayConfig;

    await expect(
      persistConfig(broken, "/cfg/config.yaml", deps),
    ).rejects.toThrow(/port/i);
    expect(writes).toHaveLength(0);
  });
});
