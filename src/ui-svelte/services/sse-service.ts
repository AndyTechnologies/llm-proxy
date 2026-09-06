/**
 * SSE service for live dashboard updates (svelte-ui task 3.2).
 *
 * Subscribes to all eight dashboard events (`execution:started`,
 * `step:started`, `step:completed`, `step:failed`, `execution:completed`,
 * `execution:failed`, `pipeline:reloaded`, `models:changed`), reconnects
 * automatically after a drop, and tears down cleanly (`stop()` closes the
 * source so no reconnect is ever scheduled afterwards — no leak across view
 * unmounts/tests).
 *
 * EventSource is injected as a factory so tests run on a deterministic fake.
 */
import { writable, get } from "svelte/store";
import { SSE_STATE, type SSEEventName, type SSEState } from "../stores/types.js";

/** The EventSource surface the service needs (a structural supertype — the
 * real one satisfies it, so fakes stay tiny). */
export interface SSEClientLike {
  addEventListener(type: string, listener: (ev: { data?: string }) => void): void;
  removeEventListener?(type: string, listener: (ev: { data?: string }) => void): void;
  close(): void;
  onopen?: ((ev: unknown) => void) | null;
  onerror?: ((ev: unknown) => void) | null;
}

export interface SSEServiceDeps {
  /** Events endpoint; defaults to `/api/ui/events`. */
  url?: string;
  /** Inject an EventSource constructor/factory (tests use a fake). */
  sourceFactory?: (url: string) => SSEClientLike;
  /** Delay before reconnecting after a drop. */
  reconnectDelayMs?: number;
  /** Called for every parsed dashboard event. */
  onEvent(type: SSEEventName, data: unknown): void;
  /** Optional state observer (e.g. trace/status UI). */
  onStateChange?(state: SSEState): void;
}

export interface SseService {
  start(): void;
  stop(): void;
  getState(): SSEState;
  subscribe(run: (state: SSEState) => void): () => void;
}

const EVENT_TYPES: SSEEventName[] = [
  "execution:started",
  "step:started",
  "step:completed",
  "step:failed",
  "execution:completed",
  "execution:failed",
  "pipeline:reloaded",
  "models:changed",
];

/** Constructor shape of the platform EventSource (client runtime). Typed
 * locally because the ambient global is only `new () => EventSource` when the
 * root tsconfig (lib ES2022, no DOM) is used for typecheck. */
type EventSourceCtor = new (url: string) => SSEClientLike;
const DEFAULT_SOURCE_FACTORY = (u: string): SSEClientLike =>
  new (EventSource as unknown as EventSourceCtor)(u);

export function createSseService(deps: SSEServiceDeps): SseService {
  const url = deps.url ?? "/api/ui/events";
  const sourceFactory = deps.sourceFactory ?? DEFAULT_SOURCE_FACTORY;
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1500;

  const state = writable<SSEState>(SSE_STATE.DISCONNECTED);
  let source: SSEClientLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function setState(next: SSEState): void {
    state.set(next);
    deps.onStateChange?.(next);
  }

  function scheduleReconnect(): void {
    if (stopping || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, reconnectDelayMs);
  }

  function onEventFrame(type: SSEEventName): (ev: { data?: string }) => void {
    return (ev) => {
      if (stopping) return;
      try {
        const data = JSON.parse(ev.data ?? "null") as unknown;
        deps.onEvent(type, data);
      } catch {
        // Malformed frame — ignore rather than crash the dashboard.
      }
    };
  }

  function attach(sourceToAttach: SSEClientLike): void {
    for (const type of EVENT_TYPES) {
      sourceToAttach.addEventListener(type, onEventFrame(type));
    }
    sourceToAttach.onopen = () => {
      if (!stopping) setState(SSE_STATE.CONNECTED);
    };
    sourceToAttach.onerror = () => {
      setState(SSE_STATE.ERROR);
      sourceToAttach.close();
      source = null;
      scheduleReconnect();
    };
  }

  function open(): void {
    if (stopping || source !== null) return;
    setState(SSE_STATE.CONNECTING);
    const next = sourceFactory(url);
    source = next;
    attach(next);
  }

  return {
    start() {
      stopping = false;
      open();
    },
    stop() {
      stopping = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      source?.close();
      source = null;
      setState(SSE_STATE.DISCONNECTED);
    },
    getState: () => get(state),
    subscribe: state.subscribe,
  };
}