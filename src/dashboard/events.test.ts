import { describe, it, expect } from "bun:test";
import { createEventBus } from "./events.js";
import type { DashboardEvent } from "./events.js";

describe("dashboard event bus", () => {
  it("publishes events to subscribers", () => {
    const bus = createEventBus({ bufferSize: 16 });
    let received: DashboardEvent[] = [];
    const unsubscribe = bus.subscribe({
      onEvent: (ev) => received.push(ev),
    });

    bus.publish({ type: "execution:started", executionId: "e1", pipelineId: "p" });
    bus.publish({ type: "execution:completed", executionId: "e1" });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("execution:started");
    expect(received[1].type).toBe("execution:completed");
    unsubscribe();
  });

  it("unsubscribed listeners stop receiving events", () => {
    const bus = createEventBus({ bufferSize: 16 });
    let received: DashboardEvent[] = [];
    const unsubscribe = bus.subscribe({
      onEvent: (ev) => received.push(ev),
    });

    bus.publish({ type: "execution:started", executionId: "e1", pipelineId: "p" });
    unsubscribe();
    bus.publish({ type: "execution:completed", executionId: "e1" });

    expect(received).toHaveLength(1);
  });

  it("replays buffered events to a new subscriber", () => {
    const bus = createEventBus({ bufferSize: 3 });
    bus.publish({ type: "execution:started", executionId: "e1", pipelineId: "p" });
    bus.publish({ type: "step:completed", executionId: "e1", nodeId: "n1" });
    bus.publish({ type: "execution:completed", executionId: "e1" });

    let received: DashboardEvent[] = [];
    bus.subscribe({ onEvent: (ev) => received.push(ev) });

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe("execution:started");
  });

  it("bounded buffer evicts oldest events (FIFO)", () => {
    const bus = createEventBus({ bufferSize: 2 });
    bus.publish({ type: "execution:started", executionId: "e1", pipelineId: "p" });
    bus.publish({ type: "step:completed", executionId: "e1", nodeId: "n1" });
    bus.publish({ type: "execution:completed", executionId: "e1" });

    let received: DashboardEvent[] = [];
    bus.subscribe({ onEvent: (ev) => received.push(ev) });

    // The oldest "execution:started" should be evicted from the buffer.
    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("step:completed");
    expect(received[1].type).toBe("execution:completed");
  });

  it("slow client is evicted and remaining clients keep receiving events", () => {
    const bus = createEventBus({ bufferSize: 16 });
    let fast: DashboardEvent[] = [];
    let slowEvicted = false;

    // Slow/stalled client — its delegate throws (write failure / not draining),
    // so the bus must evict it and continue serving others.
    bus.subscribe({
      onEvent: () => {
        throw new Error("socket write backpressure — client stalled");
      },
      onSlow: () => {
        slowEvicted = true;
      },
    });

    bus.subscribe({ onEvent: (ev) => fast.push(ev) });

    // Publish enough to trigger eviction of the slow subscriber.
    for (let i = 0; i < 5; i++) {
      bus.publish({ type: "execution:started", executionId: `e${i}`, pipelineId: "p" });
    }

    // The slow subscriber is evicted (subscriberCount drops), onSlow fires.
    expect(slowEvicted).toBe(true);
    expect(bus.subscriberCount()).toBe(1);

    // The fast subscriber still receives live events.
    expect(fast.length).toBeGreaterThan(0);
    expect(fast[0].type).toBe("execution:started");
  });

  it("buffer overflow evicts oldest events, keeps delivering to live clients", () => {
    const bus = createEventBus({ bufferSize: 3 });
    let received: DashboardEvent[] = [];
    bus.subscribe({ onEvent: (ev) => received.push(ev) });

    // Publish 6 events; the per-subscriber replay buffer only keeps 3.
    for (let i = 0; i < 6; i++) {
      bus.publish({ type: "step:completed", executionId: "e1", nodeId: `n${i}` });
    }

    // Live subscriber delivered all 6.
    expect(received).toHaveLength(6);
    // Replay buffer only keeps the newest 3.
    const buffered = bus.drainBuffer() as { type: string; nodeId: string }[];
    expect(buffered).toHaveLength(3);
    expect(buffered[0].nodeId).toBe("n3");
  });

  it("emits typed SSE payload with declared event format", () => {
    const bus = createEventBus({ bufferSize: 16 });
    let lastSSE = "";
    bus.subscribe({
      onEvent: (ev) => {
        lastSSE = bus.formatSSE(ev);
      },
    });
    const ev: DashboardEvent = {
      type: "execution:started",
      executionId: "e1",
      pipelineId: "p",
    };
    bus.publish(ev);

    expect(lastSSE).toBe(
      `event: execution:started\ndata: ${JSON.stringify(ev)}\n\n`,
    );
  });
});
