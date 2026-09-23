/**
 * bun:test suite for the workflow-run socket client (ws.ts). A controllable
 * FakeWebSocket stands in for the browser global — every drive helper fires
 * handlers synchronously, so event order is deterministic under bun:test.
 */

import { describe, expect, test } from "bun:test";
import { getWsOrigin } from "./api/config.js";
import { connectWorkflowSocket } from "./ws.js";
import type { WorkflowChatMessage, WorkflowSocket, WorkflowWsEvent } from "./ws.js";

/** Minimal browser-WebSocket-shaped stand-in with test drive helpers. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  url: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.onclose?.({ code: 1000, reason: "closed" });
  }

  // ── test drive helpers ────────────────────────────────────────────────

  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }

  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "connection dropped" });
  }
}

function fakeCtor(): typeof WebSocket {
  return FakeWebSocket as unknown as typeof WebSocket;
}

const BIND = (workflow: string): string => JSON.stringify({ type: "bind", workflow });
const RUN = (messages: WorkflowChatMessage[]): string =>
  JSON.stringify({ type: "run", messages });

const USER: WorkflowChatMessage[] = [{ role: "user", content: "hi" }];

function connect(
  workflow = "demo",
): { socket: WorkflowSocket; fake: FakeWebSocket; events: WorkflowWsEvent[]; closes: number[] } {
  const events: WorkflowWsEvent[] = [];
  const closes: number[] = [];
  const socket = connectWorkflowSocket({
    workflow,
    ws: fakeCtor(),
    onEvent: (event) => events.push(event),
    onClose: () => {
      closes.push(1);
    },
  });
  const fake = FakeWebSocket.instances.at(-1) as FakeWebSocket;
  return { socket, fake, events, closes };
}

async function openAndBind(
  workflow = "demo",
): Promise<{
  socket: WorkflowSocket;
  fake: FakeWebSocket;
  events: WorkflowWsEvent[];
  closes: number[];
}> {
  const state = connect(workflow);
  state.fake.open();
  expect(state.fake.sent).toEqual([BIND(workflow)]);
  state.fake.receive(JSON.stringify({ type: "status", workflow, state: "bound" }));
  expect(await state.socket.ready).toBe(true);
  return state;
}

describe("connectWorkflowSocket", () => {
  test("default URL is the ws origin plus /ws", () => {
    connect("demo");
    const fake = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    expect(fake.url).toBe(`${getWsOrigin()}/ws`);
  });

  test("binds on open and forwards events verbatim", async () => {
    const { fake, events } = await openAndBind("demo");
    const started = JSON.stringify({
      type: "step_started",
      workflow: "demo",
      nodeId: "llm-1",
      nodeType: "llm_call",
    });
    fake.receive(started);
    expect(events).toHaveLength(2); // bound + step_started
    expect(events[0]).toEqual({ type: "status", workflow: "demo", state: "bound" });
    expect(events[1]).toEqual({
      type: "step_started",
      workflow: "demo",
      nodeId: "llm-1",
      nodeType: "llm_call",
    });
  });

  test("a run sent after binding goes out with the run envelope", async () => {
    const { socket, fake } = await openAndBind("demo");
    socket.sendRun(USER);
    expect(fake.sent.at(-1)).toBe(RUN(USER));
  });

  test("a run sent before binding is queued and flushed on bound", async () => {
    const { socket, fake, events } = connect("demo");
    socket.sendRun(USER);
    expect(fake.sent).toEqual([]); // nothing sent before bound
    fake.open();
    expect(fake.sent).toEqual([BIND("demo")]); // still only the bind
    expect(events).toEqual([]);
    fake.receive(JSON.stringify({ type: "status", workflow: "demo", state: "bound" }));
    expect(await socket.ready).toBe(true);
    expect(fake.sent).toContain(RUN(USER)); // flushed after bound
  });

  test("a queued run surfaces an error when the bind fails", async () => {
    const { socket, events } = connect("demo");
    socket.sendRun(USER);
    socket.ready.then(() => undefined); // keep the promise observed
    // Bind-phase protocol error → ready false + the queued run is reported.
    const fake = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    fake.open();
    fake.receive(
      JSON.stringify({ type: "error", workflow: null, error: 'unknown workflow "ghost"' }),
    );
    expect(await socket.ready).toBe(false);
    expect(events.some((e) => e.type === "error" && e.error.includes("run requested before"))).toBe(
      true,
    );
    // The server's bind error is forwarded too.
    expect(events.some((e) => e.type === "error" && e.error.includes("unknown workflow"))).toBe(
      true,
    );
  });

  test("an unknown server message surfaces as a local error event", async () => {
    const { fake, events } = await openAndBind("demo");
    fake.receive(JSON.stringify({ type: "telemetry", workflow: "demo", watts: 12 }));
    const err = events.at(-1);
    expect(err?.type).toBe("error");
    expect((err as { error: string }).error).toBe("received an unrecognized message from the server");
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  test("a non-JSON server frame surfaces as a local error event", async () => {
    const { fake, events } = await openAndBind("demo");
    fake.receive("this is not json {");
    const err = events.at(-1);
    expect(err?.type).toBe("error");
    expect((err as { error: string }).error).toBe("received a message that is not valid JSON");
  });

  test("an unexpected close during a run emits an honest error (no reconnect)", async () => {
    const { socket, fake, events, closes } = await openAndBind("demo");
    socket.sendRun(USER);
    fake.receive(JSON.stringify({ type: "status", workflow: "demo", state: "running" }));
    fake.serverClose();
    const err = events.at(-1);
    expect(err?.type).toBe("error");
    expect((err as { error: string }).error).toBe("connection closed during run");
    expect(closes).toHaveLength(1);
    // No further frames were sent — no silent reconnect.
    expect(fake.sent.at(-1)).toBe(RUN(USER));
  });

  test("a caller-initiated close does not emit a mid-run error", async () => {
    const { socket, fake, events, closes } = await openAndBind("demo");
    socket.sendRun(USER);
    fake.receive(JSON.stringify({ type: "status", workflow: "demo", state: "running" }));
    socket.close();
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(closes).toHaveLength(1);
  });

  test("a socket that never opens resolves ready false", async () => {
    const { socket, fake } = connect("demo");
    socket.ready.then(() => undefined);
    fake.serverClose();
    expect(await socket.ready).toBe(false);
  });

  test("a full ok run forwards running → token → ok unchanged", async () => {
    const { socket, fake, events } = await openAndBind("demo");
    socket.sendRun(USER);
    fake.receive(JSON.stringify({ type: "status", workflow: "demo", state: "running" }));
    fake.receive(
      JSON.stringify({
        type: "token",
        workflow: "demo",
        data: 'data: {"choices":[{"message":{"content":"Hello!"}}]}\n\n',
      }),
    );
    fake.receive(JSON.stringify({ type: "token", workflow: "demo", data: "data: [DONE]\n\n" }));
    fake.receive(JSON.stringify({ type: "status", workflow: "demo", state: "ok" }));
    expect(events.map((e) => e.type)).toEqual([
      "status", // bound
      "status", // running
      "token",
      "token",
      "status", // ok
    ]);
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.some((e) => e.type === "token" && e.data.includes("[DONE]"))).toBe(true);
  });

  test("a run-phase error (bound) is forwarded without resolving ready", async () => {
    const { socket, fake, events } = await openAndBind("demo");
    socket.sendRun(USER);
    fake.receive(JSON.stringify({ type: "status", workflow: "demo", state: "running" }));
    fake.receive(
      JSON.stringify({ type: "error", workflow: "demo", nodeId: "llm-1", error: "boom" }),
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      workflow: "demo",
      nodeId: "llm-1",
      error: "boom",
    });
    expect(await socket.ready).toBe(true); // already settled at bind
  });
});