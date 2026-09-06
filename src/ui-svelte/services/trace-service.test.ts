/**
 * RED→GREEN tests for the trace service (svelte-ui task 3.2).
 *
 * Trace is **presentation-only**: it records local events (SSE/store/fetch/
 * editor/error) for the debug/verbose panel. It never fabricates fields that
 * are not already in REST/SSE payloads, keeps a bounded ring buffer, and its
 * subscribers can unsubscribe cleanly (teardown-safe).
 */
import { describe, it, expect } from "bun:test";
import { createTraceService } from "./trace-service.js";
import type { TraceEntry } from "../stores/types.js";

describe("trace service (bounded debug log)", () => {
  it("records a typed entry with a timestamp", () => {
    const trace = createTraceService();
    trace.log("sse", 'received "execution:failed"');
    const entries = trace.getEntries();
    expect(entries).toHaveLength(1);
    const [e] = entries as [TraceEntry];
    expect(e.kind).toBe("sse");
    expect(e.message).toBe('received "execution:failed"');
    expect(typeof e.ts).toBe("number");
  });

  it("keeps only presentation-safe fields (no fabricated data)", () => {
    const trace = createTraceService();
    trace.log("store", "refresh pipelines", { rows: 3 });
    const [e] = trace.getEntries() as [TraceEntry];
    // detail is the original payload, untouched by the service
    expect(e.detail).toEqual({ rows: 3 });
    expect(Object.keys(e).sort()).toEqual(["detail", "kind", "message", "ts"]);
  });

  it("enforces a bounded ring buffer (oldest dropped)", () => {
    const trace = createTraceService({ cap: 5 });
    for (let i = 0; i < 10; i += 1) trace.log("editor", `op ${i}`);
    const entries = trace.getEntries();
    expect(entries).toHaveLength(5);
    expect(entries[0]!.message).toBe("op 5");
    expect(entries[4]!.message).toBe("op 9");
  });

  it("notifies subscribers of new entries", () => {
    const trace = createTraceService();
    const seen: TraceEntry[] = [];
    const unsub = trace.subscribe((entries) => {
      if (entries.length > 0) seen.push(entries[entries.length - 1]!);
    });
    trace.log("error", "apply exploded");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("error");
    unsub();
  });

  it("unsubscribe stops delivery (teardown-safe)", () => {
    const trace = createTraceService();
    let count = 0;
    const unsub = trace.subscribe(() => {
      count += 1;
    });
    // Subscribing delivers the current list once, synchronously.
    expect(count).toBe(1);
    unsub();
    trace.log("fetch", "GET /api/ui/models");
    expect(count).toBe(1);
  });

  it("clear() empties the log", () => {
    const trace = createTraceService();
    trace.log("store", "boot");
    trace.clear();
    expect(trace.getEntries()).toEqual([]);
  });

  it("factory instances are isolated (no shared buffer)", () => {
    const a = createTraceService();
    const b = createTraceService();
    a.log("sse", "one");
    expect(a.getEntries()).toHaveLength(1);
    expect(b.getEntries()).toHaveLength(0);
  });
});