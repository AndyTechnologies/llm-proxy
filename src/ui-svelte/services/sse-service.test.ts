/**
 * RED→GREEN tests for the SSE service (svelte-ui task 3.2).
 *
 * Covers the full eight-event contract (incl. `execution:failed`), automatic
 * reconnect after a drop, and teardown unsubscription. EventSource is
 * injected as a factory so tests run with a deterministic fake — no network,
 * no real EventSource (jsdom does not implement it).
 */
import { describe, it, expect } from "bun:test";
import { createSseService } from "./sse-service.js";
import type { SSEClientLike, SSEServiceDeps } from "./sse-service.js";
import { SSE_STATE, type SSEEventName, type SSEState } from "../stores/types.js";

/** Minimal controllable EventSource double. */
class FakeSource implements SSEClientLike {
  url: string;
  listeners = new Map<string, Array<(ev: { data?: string }) => void>>();
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (ev: { data?: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (ev: { data?: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((l) => l !== listener));
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  /** Test helper: fire a named event with JSON data. */
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  /** Test helper: simulate an error (drop). */
  fail(): void {
    if (this.onerror) this.onerror({ type: "error" });
  }
}

const EIGHT_EVENTS: SSEEventName[] = [
  "execution:started",
  "step:started",
  "step:completed",
  "step:failed",
  "execution:completed",
  "execution:failed",
  "pipeline:reloaded",
  "models:changed",
];

function harness() {
  const sources: FakeSource[] = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const states: SSEState[] = [];
  let sourceIndex = 0;

  const deps: SSEServiceDeps = {
    url: "/api/ui/events",
    sourceFactory: ((url: string) => {
      const src = new FakeSource(url);
      sources.push(src);
      return src;
    }) as SSEServiceDeps["sourceFactory"],
    reconnectDelayMs: 5,
    onEvent: (type: SSEEventName, data: unknown) => {
      events.push({ type, data });
    },
    onStateChange: (state: SSEState) => {
      states.push(state);
    },
  };
  void sourceIndex;

  const service = createSseService(deps);
  return { sources, events, states, service };
}

describe("sse service (eight-event contract)", () => {
  it("connects to the events URL on start", () => {
    const { sources, service } = harness();
    service.start();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe("/api/ui/events");
    service.stop();
  });

  it("registers a listener for every one of the eight event types", () => {
    const { sources, service } = harness();
    service.start();
    const src = sources[0]!;
    for (const type of EIGHT_EVENTS) {
      expect(src.listeners.has(type)).toBe(true);
    }
    service.stop();
  });

  it("parses payloads and forwards each event type to onEvent", () => {
    const { sources, events, service } = harness();
    service.start();
    const src = sources[0]!;
    src.emit("execution:started", { type: "execution:started", executionId: "e1", pipelineId: "p1" });
    src.emit("step:started", { type: "step:started", executionId: "e1", nodeId: "n2" });
    src.emit("step:completed", { type: "step:completed", executionId: "e1", nodeId: "n2" });
    src.emit("step:failed", { type: "step:failed", executionId: "e1", nodeId: "n3" });
    src.emit("execution:completed", { type: "execution:completed", executionId: "e1" });
    src.emit("execution:failed", { type: "execution:failed", executionId: "e1" });
    src.emit("pipeline:reloaded", { type: "pipeline:reloaded", chains: ["p1"] });
    src.emit("models:changed", { type: "models:changed", candidates: ["m1"] });

    expect(events.map((e) => e.type)).toEqual(EIGHT_EVENTS);
    expect(events[0]!.data).toEqual({ type: "execution:started", executionId: "e1", pipelineId: "p1" });
    expect(events[7]!.data).toEqual({ type: "models:changed", candidates: ["m1"] });
    service.stop();
  });

  it("drops a malformed frame without crashing", () => {
    const { sources, events, service } = harness();
    service.start();
    const src = sources[0]!;
    // A raw non-JSON frame on a named channel must be ignored safely.
    for (const listener of src.listeners.get("execution:failed") ?? []) {
      listener({ data: "{not json" });
    }
    expect(events).toHaveLength(0);
    service.stop();
  });

  it("reconnects automatically after an error (drop)", async () => {
    const { sources, service } = harness();
    service.start();
    expect(sources).toHaveLength(1);
    sources[0]!.fail();
    await new Promise((r) => setTimeout(r, 20));
    expect(sources.length).toBeGreaterThanOrEqual(2);
    // The second source keeps handling events.
    sources[1]!.emit("execution:failed", { type: "execution:failed", executionId: "e9" });
    const state = service.getState();
    const accepted: SSEState[] = [SSE_STATE.CONNECTING, SSE_STATE.CONNECTED];
    expect(accepted.includes(state)).toBe(true);
    service.stop();
  });

  it("stop() closes the source and halts reconnection", async () => {
    const { sources, service } = harness();
    service.start();
    expect(sources[0]!.closed).toBe(false);
    service.stop();
    expect(sources[0]!.closed).toBe(true);

    // An error after stop must NOT schedule another source.
    const sourcesAtStop = sources.length;
    sources[0]!.fail();
    await new Promise((r) => setTimeout(r, 20));
    expect(sources.length).toBe(sourcesAtStop);
  });

  it("reports state transitions (connecting → connected → stopped)", () => {
    const { sources, states, service } = harness();
    service.start();
    // Fake does not fire onopen automatically; simulate it.
    sources[0]!.onopen?.({});
    expect(states.includes(SSE_STATE.CONNECTING)).toBe(true);
    expect(states.includes(SSE_STATE.CONNECTED)).toBe(true);
    service.stop();
    expect(service.getState()).toBe(SSE_STATE.DISCONNECTED);
  });

  it("resubscribes to every event after a reconnect", async () => {
    const { sources, service } = harness();
    service.start();
    sources[0]!.fail();
    await new Promise((r) => setTimeout(r, 20));
    const second = sources[1]!;
    for (const type of EIGHT_EVENTS) {
      expect(second.listeners.has(type)).toBe(true);
    }
    second.emit("models:changed", { type: "models:changed", candidates: ["m2"] });
    service.stop();
  });

  it("start() is idempotent while a source is open", () => {
    const { sources, service } = harness();
    service.start();
    service.start();
    expect(sources).toHaveLength(1);
    service.stop();
  });
});