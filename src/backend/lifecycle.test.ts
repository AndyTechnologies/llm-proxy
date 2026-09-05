/**
 * F2 model lifecycle — pure decision logic + controller tests.
 *
 * The /proc helpers are exercised against a REAL child process at the end
 * (linux-only smoke): spawn `sleep`, read its children/cmdline, and unload it.
 */
import { describe, expect, test } from "bun:test";
import {
  createModelLifecycle,
  decideUnloads,
  modelIdFromCmdline,
  parseVramLine,
  resolveModelId,
  vramLimitMiB,
  buildRegisteredIndex,
  readChildrenPids,
  readProcCmdline,
  MIN_VRAM_LIMIT_MIB,
  type LifecycleDeps,
  type WorkerInfo,
} from "./lifecycle.js";
import type { LifecycleConfig } from "../config/schema.js";

const TTL_DEFAULT: LifecycleConfig = {
  ttl: 600,
  vram: { mode: "dynamic", freeGb: 1, capGb: 5 },
};

const worker = (modelId: string, pid: number, sizeMiB = 100): WorkerInfo => ({
  modelId,
  pid,
  sizeMiB,
});

// ── parseVramLine ────────────────────────────────────────────────────────────

describe("parseVramLine", () => {
  test("parses the real nvidia-smi csv,noheader shape", () => {
    expect(parseVramLine("6144 MiB, 165 MiB")).toEqual({
      totalMiB: 6144,
      usedMiB: 165,
    });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseVramLine("  6144 MiB,  165 MiB  ")).toEqual({
      totalMiB: 6144,
      usedMiB: 165,
    });
  });

  test("returns null on garbage / empty / wrong units", () => {
    expect(parseVramLine("")).toBeNull();
    expect(parseVramLine("nvidia-smi: failed to query")).toBeNull();
    expect(parseVramLine("6144 MiB, 165 MB")).toBeNull();
    expect(parseVramLine("6144 KiB, 165 MiB")).toBeNull();
  });
});

// ── vramLimitMiB ─────────────────────────────────────────────────────────────

describe("vramLimitMiB", () => {
  test("dynamic: VRAM total minus the free margin", () => {
    expect(
      vramLimitMiB({ mode: "dynamic", freeGb: 1, capGb: 5 }, 6144),
    ).toBe(5120);
  });

  test("margin: identical formula (total − free)", () => {
    expect(vramLimitMiB({ mode: "margin", freeGb: 2, capGb: 5 }, 6144)).toBe(
      4096,
    );
  });

  test("cap: fixed ceiling independent of the GPU", () => {
    expect(vramLimitMiB({ mode: "cap", freeGb: 1, capGb: 5 }, 8192)).toBe(5120);
    expect(vramLimitMiB({ mode: "cap", freeGb: 1, capGb: 5 }, 4096)).toBe(5120);
  });

  test("clamps absurd reservations to a sane floor", () => {
    // freeGb > VRAM would compute a negative ceiling → floor.
    expect(vramLimitMiB({ mode: "dynamic", freeGb: 20, capGb: 5 }, 6144)).toBe(
      MIN_VRAM_LIMIT_MIB,
    );
    expect(vramLimitMiB({ mode: "cap", freeGb: 1, capGb: 0.1 }, 6144)).toBe(
      MIN_VRAM_LIMIT_MIB,
    );
  });
});

// ── modelIdFromCmdline ───────────────────────────────────────────────────────

const REGISTERED = new Map([
  ["smollm3-3b-q4_k_m.gguf", "smol"],
  ["granite-8b-q4_k_m.gguf", "granite"],
]);

describe("modelIdFromCmdline", () => {
  test("prefers --alias when present (router section alias)", () => {
    const args = ["/opt/llama/bin/llama-server", "--alias", "smol", "-m", "/h/Models/smol.gguf"];
    expect(modelIdFromCmdline(args, REGISTERED)).toEqual({
      modelId: "smol",
      file: "",
    });
  });

  test("maps a registered gguf path to the config id", () => {
    const args = ["/opt/llama/bin/llama-server", "-m", "/home/andy/Models/SmolLM3-3B-Q4_K_M.gguf"];
    expect(modelIdFromCmdline(args, REGISTERED)).toEqual({
      modelId: "smol",
      file: "SmolLM3-3B-Q4_K_M.gguf",
    });
  });

  test("falls back to the basename for unregistered files (matches the detected id)", () => {
    const args = ["/opt/llama/bin/llama-server", "-m", "/home/andy/Models/grok-1-14b.gguf"];
    expect(modelIdFromCmdline(args, REGISTERED)).toEqual({
      modelId: "grok-1-14b.gguf",
      file: "grok-1-14b.gguf",
    });
  });

  test("file matching is case-insensitive", () => {
    const args = ["llama-server", "/h/Models/SMOLLM3-3B-Q4_K_M.GGUF"];
    expect(modelIdFromCmdline(args, REGISTERED)).toEqual({
      modelId: "smol",
      file: "SMOLLM3-3B-Q4_K_M.GGUF",
    });
  });

  test("null when no model marker is present", () => {
    expect(modelIdFromCmdline(["llama-server", "--port", "8080"], REGISTERED)).toBeNull();
    expect(modelIdFromCmdline([], REGISTERED)).toBeNull();
  });
});

// ── buildRegisteredIndex / resolveModelId ────────────────────────────────────

describe("resolveModelId", () => {
  const index = buildRegisteredIndex({
    smol: { file: "SmolLM3-3B-Q4_K_M.gguf" },
    granite: { file: "granite-8b.gguf" },
  });

  test("exact config id passes through", () => {
    expect(resolveModelId("smol", index)).toBe("smol");
  });

  test("file basename (case-insensitive) resolves to the section id", () => {
    expect(resolveModelId("smollm3-3b-q4_k_m.gguf", index)).toBe("smol");
  });

  test("unknown model falls through raw (tracked as-is)", () => {
    expect(resolveModelId("something-else", index)).toBe("something-else");
  });
});

// ── decideUnloads ────────────────────────────────────────────────────────────

describe("decideUnloads", () => {
  const NOW = 1_000_000;

  test("TTL pass: unloads only workers idle past the TTL", () => {
    const actions = decideUnloads({
      workers: [
        worker("a", 11, 100),
        worker("b", 22, 100),
        worker("c", 33, 100),
      ],
      lastUsed: new Map([
        ["a", NOW - 700_000], // idle 700s > 600s ttl
        ["b", NOW - 100], // recent
        ["c", NOW - 300_000], // idle 300s < 600s
      ]),
      inFlight: new Set(),
      now: NOW,
      ttlMs: 600_000,
      skipRecentMs: 10_000,
      vram: null,
    });
    expect(actions).toEqual([{ modelId: "a", pid: 11, reason: "ttl" }]);
  });

  test("never unloads provider-tracked in-flight models", () => {
    const actions = decideUnloads({
      workers: [worker("a", 11, 100), worker("b", 22, 100)],
      lastUsed: new Map([
        ["a", NOW - 700_000],
        ["b", NOW - 700_000],
      ]),
      inFlight: new Set(["a"]),
      now: NOW,
      ttlMs: 600_000,
      skipRecentMs: 10_000,
      vram: null,
    });
    expect(actions).toEqual([{ modelId: "b", pid: 22, reason: "ttl" }]);
  });

  test("skips models with no tracked activity only briefly (recent traffic)", () => {
    const actions = decideUnloads({
      workers: [worker("x", 1, 100)],
      lastUsed: new Map(),
      now: NOW,
      ttlMs: 600_000,
      skipRecentMs: 10_000,
      inFlight: new Set(),
      vram: null,
    });
    // lastUsed missing → treated as just-used (never TTL-unloaded cold).
    expect(actions).toEqual([]);
  });

  test("ttlMs=0 disables the TTL pass", () => {
    const actions = decideUnloads({
      workers: [worker("a", 11, 100)],
      lastUsed: new Map([["a", NOW - 1_000_000]]),
      inFlight: new Set(),
      now: NOW,
      ttlMs: 0,
      skipRecentMs: 10_000,
      vram: null,
    });
    expect(actions).toEqual([]);
  });

  test("VRAM pass: LRU unload while over the ceiling, crediting file sizes", () => {
    const actions = decideUnloads({
      workers: [
        worker("a", 11, 2048),
        worker("b", 22, 2048),
        worker("c", 33, 2048),
      ],
      lastUsed: new Map([
        ["a", NOW - 600_000], // oldest → unload first
        ["b", NOW - 300_000],
        ["c", NOW - 100],
      ]),
      inFlight: new Set(),
      now: NOW,
      ttlMs: 600_000,
      skipRecentMs: 10_000,
      vram: { limitMiB: 4096, usedMiB: 6144 },
    });
    // 6144 → unload a (2048) → 4096 ≤ limit: stop. c is too recent to unload.
    expect(actions).toEqual([{ modelId: "a", pid: 11, reason: "vram" }]);
  });

  test("VRAM pass unloads more when one credit does not reach the limit", () => {
    const actions = decideUnloads({
      workers: [
        worker("a", 11, 2048),
        worker("b", 22, 2048),
      ],
      lastUsed: new Map([
        ["a", NOW - 600_000],
        ["b", NOW - 300_000],
      ]),
      inFlight: new Set(),
      now: NOW,
      ttlMs: 600_000,
      skipRecentMs: 10_000,
      vram: { limitMiB: 2048, usedMiB: 6144 },
    });
    // 6144 → a (4096) → b (2048) → at limit: stop.
    expect(actions).toEqual([
      { modelId: "a", pid: 11, reason: "vram" },
      { modelId: "b", pid: 22, reason: "vram" },
    ]);
  });

  test("VRAM pass skips in-flight and already-chosen (TTL) workers", () => {
    const actions = decideUnloads({
      workers: [
        worker("a", 11, 2048), // TTL-chosen first
        worker("b", 22, 2048), // in-flight
        worker("c", 33, 2048), // VRAM candidate
      ],
      lastUsed: new Map([
        ["a", NOW - 700_000],
        ["b", NOW - 700_000],
        ["c", NOW - 500_000],
      ]),
      inFlight: new Set(["b"]),
      now: NOW,
      ttlMs: 600_000,
      skipRecentMs: 10_000,
      vram: { limitMiB: 1024, usedMiB: 6144 },
    });
    expect(actions).toEqual([
      { modelId: "a", pid: 11, reason: "ttl" },
      { modelId: "c", pid: 33, reason: "vram" },
    ]);
  });

  test("no VRAM pass when over-limit is false or sample absent", () => {
    expect(
      decideUnloads({
        workers: [worker("a", 11, 2048)],
        lastUsed: new Map([["a", NOW - 500_000]]),
        inFlight: new Set(),
        now: NOW,
        ttlMs: 600_000,
        skipRecentMs: 10_000,
        vram: { limitMiB: 4096, usedMiB: 2048 },
      }),
    ).toEqual([]);
  });
});

// ── Controller (fakes) ───────────────────────────────────────────────────────

interface FakeEnv {
  clock: { now: number };
  spawnWorker: (modelId: string, sizeMiB?: number) => WorkerInfo;
  /** Pids of every worker the controller asked to kill. */
  killCalls: number[];
}

/** Controller test env: a mutable clock + a fake worker pool over killWorker. */
function makeLifecycle(over: Partial<LifecycleDeps> = {}) {
  const workers: WorkerInfo[] = [];
  const killCalls: number[] = [];
  const clock = { now: NOW };
  let pid = 9000;
  const env: FakeEnv = {
    clock,
    spawnWorker: (modelId: string, sizeMiB = 100) => {
      const w = worker(modelId, ++pid, sizeMiB);
      workers.push(w);
      return w;
    },
    killCalls,
  };
  const lc = createModelLifecycle({
    getConfig: () => TTL_DEFAULT,
    listWorkers: () => workers,
    killWorker: async (p) => {
      const idx = workers.findIndex((w) => w.pid === p);
      if (idx === -1) return false;
      workers.splice(idx, 1);
      killCalls.push(p);
      return true;
    },
    now: () => clock.now,
    ...over,
  });
  return { lc, env, workers };
}

const NOW = 2_000_000;

describe("createModelLifecycle (controller)", () => {
  test("an idle worker past the TTL is unloaded by the tick (reason ttl)", async () => {
    const { lc, env, workers } = makeLifecycle();
    const a = env.spawnWorker("a");
    const b = env.spawnWorker("b");
    lc.noteActivity("a"); // used at NOW

    env.clock.now += 601_000; // 601s later…
    lc.noteActivity("b"); // …b is fresh, a is idle past the 600s TTL
    await lc.tick();

    expect(env.killCalls).toEqual([a.pid]);
    expect(lc.status().recentUnloads[0]).toMatchObject({
      modelId: "a",
      pid: a.pid,
      reason: "ttl",
      ok: true,
    });
    expect(lc.status().loaded).toEqual(["b"]);
    expect(workers).toEqual([b]);
  });

  test("noteActivity keeps a worker off the TTL unload", async () => {
    const { lc, env } = makeLifecycle();
    env.spawnWorker("a");
    lc.noteActivity("a");
    await lc.tick();
    expect(env.killCalls.length).toBe(0);
  });

  test("beginRequest/endRequest bracket an in-flight window", async () => {
    const { lc, env } = makeLifecycle();
    env.spawnWorker("a");
    lc.beginRequest("a");

    env.clock.now += 601_000;
    await lc.tick(); // in-flight → untouched despite idle
    expect(env.killCalls.length).toBe(0);

    lc.endRequest("a"); // stamps activity at now → recent grace
    await lc.tick();
    expect(env.killCalls.length).toBe(0);
    expect(lc.status().lastUsed["a"]).toBeTruthy();
  });

  test("unload(modelId, manual) kills the matching worker and logs", async () => {
    const { lc, env, workers } = makeLifecycle();
    const a = env.spawnWorker("a");
    env.spawnWorker("b"); // untouched
    expect(await lc.unload("a", "manual")).toBe(true);
    expect(workers.map((w) => w.modelId)).toEqual(["b"]);
    const log = lc.status().recentUnloads[0];
    expect(log).toMatchObject({ modelId: "a", pid: a.pid, reason: "manual", ok: true });
  });

  test("unload(unknown) is a no-op false", async () => {
    const { lc } = makeLifecycle();
    expect(await lc.unload("nope", "manual")).toBe(false);
  });

  test("unloadAll returns the number of workers killed", async () => {
    const { lc, env } = makeLifecycle();
    env.spawnWorker("a");
    env.spawnWorker("b");
    expect(await lc.unloadAll("manual-all")).toBe(2);
    expect(lc.status().loaded).toEqual([]);
  });

  test("unload prefers the router API (unloadModelId) over the kill fallback", async () => {
    const apiCalls: Array<[string, number]> = [];
    const { lc, env } = makeLifecycle({
      unloadModelId: async (modelId, pid) => {
        apiCalls.push([modelId, pid]);
        return true;
      },
    });
    const a = env.spawnWorker("a");
    expect(await lc.unload("a", "manual")).toBe(true);
    expect(apiCalls).toEqual([["a", a.pid]]);
    expect(env.killCalls).toEqual([]);
  });

  test("unload falls back to killWorker when the router API fails", async () => {
    const { lc, env } = makeLifecycle({
      unloadModelId: async () => false,
    });
    const a = env.spawnWorker("a");
    expect(await lc.unload("a", "manual")).toBe(true);
    expect(env.killCalls).toEqual([a.pid]);
  });

  test("status exposes loaded, lastUsed, vram, and the unload log", async () => {
    const { lc, env } = makeLifecycle();
    const a = env.spawnWorker("a");
    lc.noteActivity("a");
    const st = lc.status();
    expect(st.loaded).toEqual(["a"]);
    expect(st.lastUsed["a"]).toBeTruthy();
    expect(st.vramPolicyActive).toBe(false);
    await lc.unload("a", "manual");
    const st2 = lc.status();
    expect(st2.recentUnloads.length).toBe(1);
    expect(st2.recentUnloads[0]).toMatchObject({
      modelId: "a",
      pid: a.pid,
      reason: "manual",
      ok: true,
    });
  });
});

// ── /proc smoke (real child process) ─────────────────────────────────────────

describe("procfs helpers (real child)", () => {
  test("reads children pids and cmdline of a spawned child", async () => {
    const child = Bun.spawn({
      cmd: ["sleep", "30"],
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const pid = child.pid;
      expect(pid).toBeGreaterThan(0);
      const children = readChildrenPids(process.pid);
      expect(children).toContain(pid);
      const cmdline = readProcCmdline(pid);
      expect(cmdline).toContain("sleep");
      expect(cmdline).toContain("30");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("readChildrenPids tolerates a dead pid", () => {
    expect(readChildrenPids(2 ** 22)).toEqual([]);
    expect(readProcCmdline(2 ** 22)).toBeNull();
  });
});