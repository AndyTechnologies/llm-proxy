/**
 * Sandbox runner tests (data-code-sandbox spec).
 *
 * RED-first: every scenario below asserts behavior of `src/sandbox/runner.ts`
 * — the isolated subprocess runner for `data.code` nodes with no network
 * access, a temp-only writable filesystem, a secrets-free env whitelist, an
 * enforced timeout, and an output cap.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxCommand,
  buildSandboxEnv,
  inspectSandboxCode,
  runSandbox,
  type SpawnedSandboxProc,
} from "./runner.js";

describe("buildSandboxCommand — OS isolation wrapper", () => {
  test("linux wraps the target command in `unshare -n --` (no network namespace)", () => {
    expect(buildSandboxCommand("linux", ["bun", "/tmp/x/code.ts"])).toEqual([
      "unshare",
      "-n",
      "--",
      "bun",
      "/tmp/x/code.ts",
    ]);
  });

  test("macOS wraps the target command in `sandbox-exec` with a deny profile", () => {
    const cmd = buildSandboxCommand("darwin", ["bun", "code.ts"]);
    expect(cmd[0]).toBe("sandbox-exec");
    expect(cmd[1]).toBe("-p");
    // The profile text must deny network access explicitly.
    expect(cmd[2]).toContain("(deny network*)");
    // The untrusted target args follow the profile untouched.
    expect(cmd.slice(3)).toEqual(["bun", "code.ts"]);
  });

  test("unknown platforms pass the target through unchanged (best-effort)", () => {
    expect(buildSandboxCommand("win32", ["bun", "code.ts"])).toEqual(["bun", "code.ts"]);
  });
});

describe("inspectSandboxCode — static policy denial", () => {
  test("network access attempt is denied before spawn", () => {
    const v = inspectSandboxCode(`const r = await fetch("https://example.com");`);
    expect(v).not.toBeNull();
    expect(v?.kind).toBe("network");
  });

  test("WebSocket and raw net/http imports are denied too", () => {
    const ws = inspectSandboxCode(`const s = new WebSocket("ws://x");`);
    expect(ws?.kind).toBe("network");
    const net = inspectSandboxCode(`import net from "node:net"; const c = net.connect(80);`);
    expect(net?.kind).toBe("network");
    const http = inspectSandboxCode(`const h = await import("http"); h.get("http://x");`);
    expect(http?.kind).toBe("network");
  });

  test("host filesystem reads outside the sandbox are denied", () => {
    const v = inspectSandboxCode(`const d = readFileSync("/etc/passwd", "utf8");`);
    expect(v).not.toBeNull();
    expect(v?.kind).toBe("fs");
    expect(v?.detail).toContain("/etc/passwd");
  });

  test("environment secrets are not exposed — process.env access is denied", () => {
    const v = inspectSandboxCode(`console.log(process.env.OPENAI_API_KEY);`);
    expect(v).not.toBeNull();
    expect(v?.kind).toBe("secrets");
  });

  test("benign in-sandbox code passes inspection", () => {
    const v = inspectSandboxCode(`const x = [1,2,3].map(n => n * 2); console.log(x.join(","));`);
    expect(v).toBeNull();
  });

  test("inspection reports one violation with a detail message", () => {
    const v = inspectSandboxCode(`fetch("http://127.0.0.1"); readFileSync("/home/user/x");`);
    expect(v).not.toBeNull();
    expect(typeof v?.detail).toBe("string");
    expect(v!.detail.length).toBeGreaterThan(0);
  });
});

describe("buildSandboxEnv — secrets-free environment whitelist", () => {
  test("only PATH/TMPDIR/HOME and explicit allowlist entries survive", () => {
    const env = buildSandboxEnv("/tmp/sbx", { ALLOWED_FLAG: "1" });
    expect(env.PATH).toBeDefined();
    expect(env.TMPDIR).toBe("/tmp/sbx");
    expect(env.HOME).toBe("/tmp/sbx");
    expect(env.ALLOWED_FLAG).toBe("1");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.WEAVELLM_API_KEY).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
  });
});

/** In-memory fake spawn for deterministic executor-level tests. */
function fakeSpawn(
  onSpawn: (cmd: string[], env: Record<string, string>, cwd: string) => SpawnedSandboxProc,
) {
  return {
    spawn: (cmd: string[], opts: { env: Record<string, string>; cwd: string; input?: string }) =>
      onSpawn(cmd, opts.env, opts.cwd),
    mkdtemp: (prefix: string) => `/tmp/${prefix}${Math.random().toString(36).slice(2)}`,
    writeCode: (dir: string, code: string) => join(dir, "code.ts") + `::${code}`,
    now: () => 10,
  };
}

function okProc(stdout: string, stderr = "", exitCode = 0): SpawnedSandboxProc {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(stdout));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        if (stderr) c.enqueue(new TextEncoder().encode(stderr));
        c.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    kill: () => {},
    stdin: undefined,
  };
}

describe("runSandbox — executor-level behavior (injected spawn)", () => {
  const benign = `console.log("hi");`;

  test("policy violations abort before any process is spawned", async () => {
    let spawned = 0;
    const sandbox = fakeSpawn(() => {
      spawned += 1;
      return okProc("");
    });
    const res = await runSandbox(`fetch("https://x");`, {}, sandbox);
    expect(res.ok).toBe(false);
    expect(res.violation?.kind).toBe("network");
    expect(spawned).toBe(0);
    expect(res.error).toContain("denied");
  });

  test("spawn env is the whitelist, not the host environment", async () => {
    let seenEnv: Record<string, string> = {};
    const sandbox = fakeSpawn((_cmd, env) => {
      seenEnv = env;
      return okProc("hi");
    });
    await runSandbox(benign, {}, sandbox);
    expect(seenEnv.OPENAI_API_KEY).toBeUndefined();
    expect(seenEnv.HOME).toBeDefined();
    expect(seenEnv.TMPDIR).toBeDefined();
  });

  test("spawn cwd is a fresh temp directory (tmp-only writable FS)", async () => {
    let seenCwd = "";
    const sandbox = fakeSpawn((_cmd, _env, cwd) => {
      seenCwd = cwd;
      return okProc("hi");
    });
    await runSandbox(benign, {}, sandbox);
    expect(seenCwd.startsWith(tmpdir())).toBe(true);
  });

  test("stdout and exit code flow into the result", async () => {
    const sandbox = fakeSpawn(() => okProc('{"ok":true}'));
    const res = await runSandbox(benign, {}, sandbox);
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('{"ok":true}');
  });

  test("non-zero exit is a failed result carrying stderr", async () => {
    const sandbox = fakeSpawn(() => okProc("", "boom", 1));
    const res = await runSandbox(benign, {}, sandbox);
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe("boom");
    expect(res.error).toContain("exit code 1");
  });

  test("timeout kills the process and reports timedOut", async () => {
    const sandbox = fakeSpawn(() => ({
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("slow"));
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      exited: new Promise<number>(() => {}), // never resolves — killed instead
      kill: () => {},
    }));
    const res = await runSandbox(benign, { timeoutMs: 5 }, sandbox);
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
  });

  test("oversized output is truncated at the cap with the flag set", async () => {
    const big = "x".repeat(10_000);
    const sandbox = fakeSpawn(() => okProc(big));
    const res = await runSandbox(benign, { maxOutputBytes: 512 }, sandbox);
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(512);
  });
});

describe("runSandbox — real subprocess integration (bun runtime)", () => {
  test(
    "benign code completes inside the sandbox with output captured",
    async () => {
      const res = await runSandbox(`console.log(JSON.stringify({ n: 40 + 2 }));`);
      expect(res.ok).toBe(true);
      expect(res.stdout).toContain('"n":42');
      expect(res.timedOut).toBe(false);
    },
    { timeout: 10_000 },
  );

  test(
    "code reading an absolute host path is denied by the policy layer",
    async () => {
      const res = await runSandbox(`const fs = await import("node:fs"); fs.readFileSync("/etc/hostname");`);
      expect(res.ok).toBe(false);
      expect(res.violation?.kind).toBe("fs");
    },
    { timeout: 10_000 },
  );

  test(
    "infinite loop is killed at the timeout and reported as timedOut",
    async () => {
      const res = await runSandbox(`while (true) {}`, { timeoutMs: 800 });
      expect(res.timedOut).toBe(true);
      expect(res.ok).toBe(false);
    },
    { timeout: 10_000 },
  );

  test(
    "oversized output from a real process is capped",
    async () => {
      const res = await runSandbox(`console.log("y".repeat(50000));`, { maxOutputBytes: 1024 });
      expect(res.truncated).toBe(true);
      expect(res.stdout.length).toBeLessThanOrEqual(1024);
    },
    { timeout: 10_000 },
  );
});