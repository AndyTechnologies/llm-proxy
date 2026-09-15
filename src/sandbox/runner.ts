/**
 * Sandbox runner for `data.code` workflow nodes (data-code-sandbox spec).
 *
 * Executes untrusted user code in an isolated subprocess:
 *   - OS-level isolation when the platform allows it: `unshare -n` on Linux
 *     (no network namespace — only loopback) or `sandbox-exec` with a deny
 *     profile on macOS.
 *   - Policy-level isolation that always applies: static inspection refuses
 *     code that touches network APIs, absolute host filesystem paths, or
 *     `process.env` (secrets). Denials happen BEFORE any process spawns.
 *   - Temp-only workspace: code runs with its cwd and HOME/TMPDIR inside a
 *     freshly created temp directory; the environment is a whitelist, never
 *     the host environment.
 *   - Enforced timeout (SIGTERM → SIGKILL) and a bounded output cap.
 *
 * Design note (D10): on desktops where `unshare` is not permitted (common —
 * EPERM without privileges), the runner probes availability once and falls
 * back to policy-only isolation, which is honest about the active mode via
 * `sandboxIsolation()`.
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Static policy inspection ───────────────────────────────────────────────

export type SandboxViolationKind = "network" | "fs" | "secrets";

export interface SandboxViolation {
  kind: SandboxViolationKind;
  detail: string;
}

interface PatternRule {
  re: RegExp;
  kind: SandboxViolationKind;
  detail: (match: string) => string;
}

const RULES: PatternRule[] = [
  // Network: any socket/fetch surface. Deny-by-default: a data-node has no
  // reason to reach a network.
  { re: /\bfetch\s*\(/g, kind: "network", detail: () => "fetch( — network access is denied in the sandbox" },
  { re: /\bnew\s+WebSocket\s*\(/g, kind: "network", detail: () => "WebSocket — network access is denied in the sandbox" },
  { re: /\bnode:net\b|\bnode:http\b|\bnode:https\b|\bnode:dgram\b|\bnode:tls\b/g, kind: "network", detail: (m) => `${m} — raw network modules are denied in the sandbox` },
  { re: /\b(?:http|https)\.(?:get|request)\s*\(/g, kind: "network", detail: () => "http(s).get/request — network access is denied in the sandbox" },
  { re: /\bimport\s*\(\s*["'](?:node:)?(?:http|https|net|dgram|tls)["']\s*\)/g, kind: "network", detail: () => "dynamic import of a network module is denied in the sandbox" },
  { re: /\bfrom\s*["'](?:node:)?(?:http|https|net|dgram|tls)["']/g, kind: "network", detail: () => "import of a network module is denied in the sandbox" },
  { re: /\bnet\.(connect|createConnection|createServer)\s*\(/g, kind: "network", detail: () => "net.* — socket access is denied in the sandbox" },
  // Host filesystem: absolute host paths and explicit fs I/O outside the
  // temp workspace are denied.
  { re: /["'`](\/(?:etc|home|usr|var|root|opt|srv|mnt)\b[^"'`\s]*)/g, kind: "fs", detail: (m) => `${m} — host filesystem paths are denied in the sandbox` },
  { re: /(?:^|[^.\w])(?:readFile|readFileSync|readdir|readdirSync|openSync|createReadStream|writeFile|writeFileSync|appendFile|appendFileSync|rmSync|unlink|unlinkSync|mkdirSync|cpSync|createWriteStream)\s*\(/g, kind: "fs", detail: () => "filesystem I/O outside the sandbox is denied (tmp-only writable FS)" },
  // Secrets: process.env enumeration would expose host keys.
  { re: /\bprocess\.env\b/g, kind: "secrets", detail: () => "process.env — environment secrets are denied in the sandbox" },
];

/** Scan untrusted code; returns the FIRST violation, or null when clean. */
export function inspectSandboxCode(code: string): SandboxViolation | null {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const match = rule.re.exec(code);
    if (match !== null) {
      return { kind: rule.kind, detail: rule.detail(match[0]) };
    }
  }
  return null;
}

// ── OS isolation command shaping ───────────────────────────────────────────

const MACOS_SANDBOX_PROFILE = [
  "(version 1)",
  "(deny default)",
  "(allow process* sysctl-read)",
  "(allow file-read* file-write* (subpath \"/tmp\") (subpath \"/private/tmp\"))",
  "(deny network*)",
  "(allow signal (target self))",
].join("\n");

/** Platform isolation wrapper (INCLUDING untrusted target args unchanged). */
export function buildSandboxCommand(platform: string, args: string[]): string[] {
  if (platform === "linux") {
    return ["unshare", "-n", "--", ...args];
  }
  if (platform === "darwin") {
    return ["sandbox-exec", "-p", MACOS_SANDBOX_PROFILE, ...args];
  }
  return [...args];
}

export type SandboxIsolationMode = "unshare" | "sandbox-exec" | "policy-only";

/** Probe whether the OS isolation tool actually works on this host (cached). */
export function probeSandboxIsolation(platform: string): SandboxIsolationMode {
  if (platform === "linux") {
    return spawnSucceeds(["unshare", "-n", "true"]) ? "unshare" : "policy-only";
  }
  if (platform === "darwin") {
    return spawnSucceeds(["sandbox-exec", "-p", MACOS_SANDBOX_PROFILE, "true"])
      ? "sandbox-exec"
      : "policy-only";
  }
  return "policy-only";
}

function spawnSucceeds(cmd: string[]): boolean {
  try {
    const res = Bun.spawnSync(cmd);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

const isolationCache = new Map<string, SandboxIsolationMode>();

/** Cached effective isolation mode for a platform (module-level probe). */
export function sandboxIsolation(platform: string = process.platform): SandboxIsolationMode {
  const cached = isolationCache.get(platform);
  if (cached !== undefined) return cached;
  const mode = probeSandboxIsolation(platform);
  isolationCache.set(platform, mode);
  return mode;
}

// ── Environment whitelist ──────────────────────────────────────────────────

/**
 * Build the sandbox environment: a fixed whitelist (PATH + sandbox-scoped
 * TMPDIR/HOME) plus explicit allowlist entries. NEVER the host environment —
 * secrets (API keys etc.) cannot leak.
 */
export function buildSandboxEnv(
  tmp: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tmp,
    HOME: tmp,
    ...extra,
  };
}

// ── Subprocess surface ─────────────────────────────────────────────────────

export interface SpawnedSandboxProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
  stdin?: WritableStream<Uint8Array> | null;
}

export interface SandboxDeps {
  /** Lower-level spawn with an explicit sandbox env/cwd (INJECTED for tests). */
  spawn: (
    cmd: string[],
    opts: { env: Record<string, string>; cwd: string; input?: string },
  ) => SpawnedSandboxProc;
  /** Create a fresh temp directory for the workspace. */
  mkdtemp: (prefix: string) => string;
  /** Write the code file into the workspace; returns the script path. */
  writeCode: (dir: string, code: string) => string;
  /** Resolve a runtime name to an absolute binary (the child env PATH is a whitelist). */
  resolveRuntime?: (runtime: string) => string;
  now?: () => number;
  platform?: string;
}

/** Absolute path for well-known runtimes; anything else is tried as-is. */
export function resolveRuntimeBinary(runtime: string): string {
  if (runtime === "bun") {
    // Under Bun, process.execPath points at the running bun binary — absolute
    // paths survive the whitelisted child env PATH.
    return process.execPath.length > 0 ? process.execPath : runtime;
  }
  return runtime;
}

/** Real default deps: Bun.spawn + node fs/os (bun-native runtime). */
function defaultSandboxDeps(): SandboxDeps {
  return {
    spawn: (cmd, opts) => {
      const proc = Bun.spawn({
        cmd,
        cwd: opts.cwd,
        env: opts.env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: opts.input !== undefined ? "pipe" : "ignore",
      }) as unknown as SpawnedSandboxProc;
      if (opts.input !== undefined && proc.stdin) {
        const writer = proc.stdin.getWriter();
        void writer.write(new TextEncoder().encode(opts.input)).then(() => writer.close());
        void writer.closed.catch(() => {});
      }
      return proc;
    },
    mkdtemp: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    writeCode: (dir, code) => {
      const script = join(dir, "code.ts");
      writeFileSync(script, code, "utf8");
      return script;
    },
    now: Date.now,
    platform: process.platform,
  };
}

// ── Result + runner ────────────────────────────────────────────────────────

export interface SandboxOptions {
  /** Runtime binary that executes the code file (default "bun"). */
  runtime?: string;
  /** Hard kill after this many ms (default 10s). */
  timeoutMs?: number;
  /** stdout cap in bytes; excess is dropped and `truncated` is set. */
  maxOutputBytes?: number;
  /** Optional stdin payload for the sandboxed process. */
  input?: string;
  /** Explicit env allowlist entries (never host secrets). */
  env?: Record<string, string>;
}

export interface SandboxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** stdout hit the cap → truncated with a warning. */
  truncated: boolean;
  /** process was killed at the timeout. */
  timedOut: boolean;
  /** static-policy violation, when one stopped execution before spawn. */
  violation: SandboxViolation | null;
  /** human-readable failure detail (denial / timeout / exit code). */
  error: string | null;
  ms: number;
}

interface PendingResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  violation: SandboxViolation | null;
  error: string | null;
}

/** Read stdout/stderr concurrently, bounded by the output cap. */
async function readCapped(
  proc: SpawnedSandboxProc,
  cap: number,
): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    key: "stdout" | "stderr",
  ): Promise<{ text: string; capped: boolean }> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    let capped = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > cap) {
          capped = true;
          // Keep only the first `cap` bytes; then stop reading this stream.
          const room = cap - (bytes - value.byteLength);
          if (room > 0) chunks.push(decoder.decode(value.slice(0, room), { stream: true }));
          await reader.cancel();
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream teardown mid-read → keep what we have
    }
    const text = chunks.join("");
    void key;
    return { text, capped };
  };

  const [out, err] = await Promise.all([readStream(proc.stdout, "stdout"), readStream(proc.stderr, "stderr")]);
  return { stdout: out.text, stderr: err.text, truncated: out.capped };
}

/** Race a proc's `exited` against a grace deadline; null when it outlives it. */
async function raceExited(proc: SpawnedSandboxProc, graceMs: number): Promise<number | null> {
  let settled = false;
  return await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, graceMs);
    proc.exited
      .then((code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(code);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
  });
}

/**
 * Run untrusted code in the sandbox. Returns a SandboxResult — never throws.
 *
 * Order: static policy inspection (deny before spawn) → fresh temp workspace
 * → OS isolation wrapper when the platform provides it → bounded read →
 * timeout kill.
 */
export async function runSandbox(
  code: string,
  opts: SandboxOptions = {},
  deps: SandboxDeps = defaultSandboxDeps(),
): Promise<SandboxResult> {
  const t0 = deps.now ? deps.now() : Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;
  const platform = deps.platform ?? process.platform;

  const finish = (p: PendingResult): SandboxResult => ({
    ...p,
    ms: (deps.now ? deps.now() : Date.now()) - t0,
  });

  const violation = inspectSandboxCode(code);
  if (violation !== null) {
    return finish({
      ok: false,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      violation,
      error: `sandbox denied: ${violation.kind} — ${violation.detail}`,
    });
  }

  const dir = deps.mkdtemp("weavellm-sandbox-");
  const scriptPath = deps.writeCode(dir, code);
  const runtime = opts.runtime ?? "bun";
  const runtimeBin = deps.resolveRuntime ? deps.resolveRuntime(runtime) : resolveRuntimeBinary(runtime);
  const isolated = sandboxIsolation(platform);
  const baseCmd = [runtimeBin, scriptPath];
  const cmd = isolated !== "policy-only" ? buildSandboxCommand(platform, baseCmd) : baseCmd;

  let proc: SpawnedSandboxProc;
  let spawnError: string | null = null;
  try {
    proc = deps.spawn(cmd, {
      env: buildSandboxEnv(dir, opts.env),
      cwd: dir,
      input: opts.input,
    });
  } catch (err) {
    return finish({
      ok: false,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      violation: null,
      error: `sandbox spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const readPromise = readCapped(proc, maxOutputBytes);
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 500);
  }, timeoutMs);

  // Bound the ENTIRE wait: reads + exit. A child that ignores the kill
  // (or an injected fake whose streams never close) must not hang the runner.
  const work = (async (): Promise<{
    stdout: string;
    stderr: string;
    truncated: boolean;
    exitCode: number | null;
  }> => {
    const { stdout, stderr, truncated } = await readPromise;
    const graceMs = timedOut ? 1_000 : 0;
    const exitCode = graceMs > 0 ? await raceExited(proc, graceMs) : await proc.exited.catch(() => null);
    return { stdout, stderr, truncated, exitCode };
  })();

  const deadlineMs = timeoutMs + 1_500;
  let deadlineId: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<{ deadlineHit: true }>((resolve) => {
    deadlineId = setTimeout(() => resolve({ deadlineHit: true }), deadlineMs);
  });

  const outcome = await Promise.race([work, deadline]);
  if (deadlineId !== null) clearTimeout(deadlineId);

  if ("deadlineHit" in outcome) {
    return finish({
      ok: false,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: true,
      violation: null,
      error: `sandbox timed out after ${timeoutMs} ms; process killed`,
    });
  }

  const { stdout, stderr, truncated, exitCode } = outcome;
  clearTimeout(killer);

  if (timedOut) {
    return finish({
      ok: false,
      stdout,
      stderr,
      truncated,
      timedOut: true,
      violation: null,
      error: `sandbox timed out after ${timeoutMs} ms; process killed`,
    });
  }

  if (exitCode !== 0) {
    spawnError = `sandbox process failed: exit code ${String(exitCode === null ? "killed" : exitCode)}`;
  }

  return finish({
    ok: spawnError === null,
    stdout,
    stderr,
    truncated,
    timedOut: false,
    violation: null,
    error: spawnError,
  });
}