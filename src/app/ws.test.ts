/**
 * /ws websocket integration (Task 6.9, websocket-streaming spec).
 *
 * Real Bun server + real WebSocket clients: typed event sequence, exactly one
 * `data: [DONE]`, per-socket scoping, 426 for plain HTTP, and upstream abort
 * on client disconnect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWebServer, type WebServer } from "./server.js";
import { makeWsHub } from "./ws.js";
import type { ChainCompletion, WorkflowRunner, RunResult } from "../orchestrator/runner.js";
import type { EngineEvent } from "../orchestrator/engine.js";
import type { AppLogger } from "./types.js";

const logger: AppLogger = () => {};

function completion(model: string): ChainCompletion {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
    ],
    usage: null,
  };
}

/** Emit a minimal ordered engine trace for one executed workflow. */
function emitTrace(onEvent: ((event: EngineEvent) => void) | undefined): void {
  onEvent?.({ type: "run:start", ts: 1 });
  onEvent?.({ type: "step:start", nodeId: "start", nodeType: "start", ts: 2 });
  onEvent?.({ type: "step:complete", nodeId: "start", status: "ok", ms: 1, ts: 3 });
  onEvent?.({ type: "run:complete", ok: true, error: null, ms: 1, ts: 4 });
}

describe("/ws streaming (6.9)", () => {
  let server: WebServer;
  let port: number;
  let runner: WorkflowRunner;

  beforeAll(async () => {
    runner = {
      ids: () => ["demo", "other"],
      run: async (name, _body, _signal, onEvent) => {
        emitTrace(onEvent);
        return { ok: true, output: completion(`gateway/${name}`) };
      },
    };
    server = await createWebServer({
      config: { host: "127.0.0.1", port: 0, authEnabled: false, appData: "" },
      logger,
      ws: makeWsHub({ runner }),
    });
    port = server.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  function open(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("websocket open timed out"));
      }, 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("websocket connection failed"));
      });
    });
  }

  /** Collect exactly N messages in arrival order. */
  function collect(ws: WebSocket, count: number): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const out: Record<string, unknown>[] = [];
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${out.length}/${count} messages`));
      }, 5000);
      ws.addEventListener("message", (ev) => {
        out.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
        if (out.length === count) {
          clearTimeout(timer);
          resolve(out);
        }
      });
    });
  }

  function send(ws: WebSocket, payload: unknown): void {
    ws.send(JSON.stringify(payload));
  }

  test("plain HTTP /ws answers 426 (no websocket upgrade)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ws`);
    expect(res.status).toBe(426);
  });

  test("bind + run streams the typed event sequence with exactly one [DONE]", async () => {
    const ws = await open();
    try {
      const messages = collect(ws, 7);
      send(ws, { type: "bind", workflow: "demo" });
      send(ws, { type: "run", messages: [{ role: "user", content: "hi" }] });
      const got = await messages;

      expect(got[0]).toEqual({ type: "status", workflow: "demo", state: "bound" });
      expect(got[1]).toEqual({ type: "status", workflow: "demo", state: "running" });
      expect(got[2]?.type).toBe("step_started");
      expect(got[2]).toMatchObject({ workflow: "demo", nodeId: "start" });
      expect(got[3]?.type).toBe("step_completed");
      expect(got[3]).toMatchObject({ workflow: "demo", nodeId: "start" });
      expect(got[4]).toMatchObject({ type: "token", workflow: "demo" });
      expect(String((got[4] as { data?: string }).data)).toContain('"assistant"');
      expect(got[5]).toEqual({ type: "token", workflow: "demo", data: "data: [DONE]\n\n" });
      expect(got[6]).toEqual({ type: "status", workflow: "demo", state: "ok" });

      const doneFrames = got.filter(
        (m) => m.type === "token" && (m as { data?: string }).data === "data: [DONE]\n\n",
      );
      expect(doneFrames.length).toBe(1);
    } finally {
      ws.close();
    }
  });

  test("run before bind → error event, no run", async () => {
    const ws = await open();
    try {
      const messages = collect(ws, 1);
      send(ws, { type: "run", messages: [{ role: "user", content: "hi" }] });
      const got = await messages;
      expect(got[0]?.type).toBe("error");
    } finally {
      ws.close();
    }
  });

  test("bind to an unknown workflow → error event", async () => {
    const ws = await open();
    try {
      const messages = collect(ws, 1);
      send(ws, { type: "bind", workflow: "ghost" });
      const got = await messages;
      expect(got[0]).toMatchObject({ type: "error", workflow: null });
      expect(String((got[0] as { error?: string }).error)).toContain("ghost");
    } finally {
      ws.close();
    }
  });

  test("events are scoped to the socket that bound the workflow", async () => {
    const a = await open();
    const b = await open();
    try {
      const seenByB: unknown[] = [];
      b.addEventListener("message", (ev) => seenByB.push(JSON.parse(String(ev.data))));

      const aMessages = collect(a, 7);
      send(a, { type: "bind", workflow: "demo" });
      send(a, { type: "run", messages: [{ role: "user", content: "hi" }] });
      await aMessages;

      const bMessages = collect(b, 7);
      send(b, { type: "bind", workflow: "other" });
      send(b, { type: "run", messages: [{ role: "user", content: "yo" }] });
      const gotB = await bMessages;
      expect(gotB.every((m) => (m as { workflow?: string }).workflow === "other")).toBe(true);

      // B never received A's trace: its workflow name never appears on A's wire.
      const aRaw: string[] = [];
      a.addEventListener("message", (ev) => aRaw.push(String(ev.data)));
      expect(seenByB.some((m) => (m as { workflow?: string }).workflow === "demo")).toBe(false);
      expect(aRaw.some((raw) => raw.includes("other"))).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });

  test("client disconnect aborts the upstream run", async () => {
    let captureSignal: (s: AbortSignal) => void = () => {};
    const gotSignal = new Promise<AbortSignal>((resolve) => {
      captureSignal = resolve;
    });
    let runStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let pending: Promise<RunResult> | null = null;

    const abortingRunner: WorkflowRunner = {
      ids: () => ["demo"],
      run: async (_name, _body, sig) => {
        captureSignal(sig ?? new AbortController().signal);
        pending = new Promise<RunResult>((resolve) => {
          sig?.addEventListener("abort", () => {
            resolve({ ok: false, status: 502, error: "aborted" });
          });
        });
        runStarted();
        return pending;
      },
    };
    const abortServer = await createWebServer({
      config: { host: "127.0.0.1", port: 0, authEnabled: false, appData: "" },
      logger,
      ws: makeWsHub({ runner: abortingRunner }),
    });
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${abortServer.port}/ws`);
        const timer = setTimeout(() => reject(new Error("open timeout")), 5000);
        s.addEventListener("open", () => {
          clearTimeout(timer);
          resolve(s);
        });
      });
      send(ws, { type: "bind", workflow: "demo" });
      send(ws, { type: "run", messages: [{ role: "user", content: "hi" }] });
      await started;
      ws.close();
      const sig = await gotSignal;
      const result = await pending!;
      expect(result.ok).toBe(false);
      expect(sig.aborted).toBe(true);
    } finally {
      await abortServer.stop();
    }
  });
});