/**
 * Dashboard SSE event bus (Slice C — task 3.3, dashboard-api Req "SSE events
 * endpoint").
 *
 * A pub/sub hub that emits dashboard events (execution lifecycle, step
 * progress, pipeline reload, model change) to subscribers, and formats them as
 * SSE frames. The bus keeps a bounded ring buffer of recent events so a newly
 * connected client catches up on what it missed (oldest evicted first).
 *
 * Backpressure: delivery is synchronous. When a subscriber's encoder fails to
 * write (a stalled/slow client whose socket is backpressured throws during
 * delivery), the bus EVICTS that client so a single stalled reader can never
 * stall the whole bus — the remaining well-draining clients keep receiving
 * events. Eviction surfaces through the `onSlow` callback so the owning route
 * can close the connection.
 *
 * Pure/injectable: no global state; both buffer sizes are configurable so
 * tests can exercise bounds cheaply.
 */

/** All dashboard event shapes (typed union). */
export type DashboardEvent =
  | { type: "execution:started"; executionId: string; pipelineId: string }
  | { type: "step:started"; executionId: string; nodeId: string }
  | { type: "step:completed"; executionId: string; nodeId: string }
  | { type: "step:failed"; executionId: string; nodeId: string }
  | { type: "execution:completed"; executionId: string }
  | { type: "execution:failed"; executionId: string }
  | { type: "pipeline:reloaded"; chains: string[] }
  | { type: "models:changed"; candidates: string[] };

/** Options for creating the event bus. */
export interface EventBusOptions {
  /** Max events retained in the replay buffer (default 100). */
  bufferSize?: number;
}

/** Descriptor for subscribing to the bus. */
export interface SubscribeDescriptor {
  /** Called synchronously with each live event. */
  onEvent: (ev: DashboardEvent) => void;
  /** Called when this subscriber was evicted (e.g. close the SSE connection). */
  onSlow?: (evicted: boolean) => void;
}

/** The event bus surface. */
export interface DashboardEventBus {
  /** Subscribe; returns an unsubscribe function. */
  subscribe(desc: SubscribeDescriptor): () => void;
  /** Publish an event to all live subscribers + append to replay buffer. */
  publish(event: DashboardEvent): void;
  /** Format an event as an SSE frame (event:<name>\ndata:<json>\n\n). */
  formatSSE(event: DashboardEvent): string;
  /** The current count of live subscribers. */
  subscriberCount(): number;
  /** Snapshot of the current replay buffer. */
  drainBuffer(): DashboardEvent[];
}

/** Create the dashboard event bus. */
export function createEventBus(options: EventBusOptions = {}): DashboardEventBus {
  const bufferSize = options.bufferSize ?? 100;

  // FIFO replay buffer (newest last, bounded — evict oldest when full).
  let buffer: DashboardEvent[] = [];
  const subscribers = new Set<SubscribeDescriptor>();

  return {
    subscribe(desc) {
      // Replay the global catch-up buffer to the fresh client.
      for (const ev of buffer) {
        desc.onEvent(ev);
      }
      subscribers.add(desc);
      return () => {
        subscribers.delete(desc);
      };
    },

    publish(event) {
      buffer.push(event);
      if (buffer.length > bufferSize) {
        buffer = buffer.slice(buffer.length - bufferSize);
      }

      for (const desc of [...subscribers]) {
        try {
          desc.onEvent(event);
        } catch {
          // Backpressure: this client failed to accept the event (stalled /
          // slow socket). Evict it so the remaining clients keep flowing.
          subscribers.delete(desc);
          try {
            desc.onSlow?.(true);
          } catch {
            // The slow callback itself must never stall the callers.
          }
        }
      }
    },

    formatSSE(event) {
      return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    },

    subscriberCount() {
      return subscribers.size;
    },

    drainBuffer() {
      return [...buffer];
    },
  };
}
