/**
 * Trace service for the debug/verbose panel (svelte-ui task 3.2).
 *
 * **Presentation-only**: it records local events (SSE arrived, store refresh,
 * fetch round-trips, editor ops, errors) into a bounded ring buffer for the
 * verbose debug view. It never invents fields that are not already present in
 * REST/SSE payloads, and keeps the last `cap` entries (oldest evicted).
 */
import { writable, get } from "svelte/store";
import type { TraceEntry } from "../stores/types.js";

export interface TraceService {
  log(kind: TraceEntry["kind"], message: string, detail?: unknown): void;
  subscribe(run: (entries: TraceEntry[]) => void): () => void;
  getEntries(): TraceEntry[];
  clear(): void;
}

export interface TraceDeps {
  /** Ring buffer size (default 500). */
  cap?: number;
}

const DEFAULT_CAP = 500;

export function createTraceService(deps: TraceDeps = {}): TraceService {
  const cap = deps.cap ?? DEFAULT_CAP;
  const entries: TraceEntry[] = [];
  const store = writable<TraceEntry[]>(entries);

  return {
    log(kind, message, detail) {
      entries.push({ ts: Date.now(), kind, message, detail });
      if (entries.length > cap) entries.splice(0, entries.length - cap);
      store.set([...entries]);
    },
    subscribe: store.subscribe,
    getEntries: () => get(store),
    clear() {
      entries.length = 0;
      store.set([]);
    },
  };
}