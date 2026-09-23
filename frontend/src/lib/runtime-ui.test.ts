/**
 * Unit tests for the pure runtime display helpers (runtime-ui.ts). No IO:
 * each test feeds deterministic inputs and asserts on the mapped views —
 * health with/without latency and localModels, the websocket probe state
 * machine (happy path, error path, retry reset, illegal-transition no-ops)
 * and the package.json version line.
 */

import { describe, expect, test } from "bun:test";
import {
  WS_PROBE_INITIAL,
  formatLatency,
  formatLocalModels,
  healthView,
  versionLine,
  wsProbeState,
} from "./runtime-ui.js";
import type { WsProbeState } from "./runtime-ui.js";

describe("healthView", () => {
  test("a null health maps to placeholders and a neutral tone", () => {
    expect(healthView(null, null)).toEqual({
      status: null,
      statusText: "—",
      latency: "—",
      localModels: "—",
      tone: "neutral",
    });
  });

  test("an answered probe shows the backend status verbatim", () => {
    const view = healthView({ status: "ok" }, 12.7);
    expect(view.status).toBe("ok");
    expect(view.statusText).toBe("ok");
    expect(view.tone).toBe("ok");
  });

  test("localModels count renders with pluralization when present", () => {
    expect(healthView({ status: "ok", localModels: ["a"] }, null).localModels).toBe(
      "1 local model",
    );
    expect(healthView({ status: "ok", localModels: ["a", "b"] }, null).localModels).toBe(
      "2 local models",
    );
    expect(healthView({ status: "ok", localModels: [] }, null).localModels).toBe(
      "0 local models",
    );
  });

  test("localModels is an honest dash when the backend sends none", () => {
    expect(healthView({ status: "ok" }, null).localModels).toBe("—");
  });
});

describe("formatLatency", () => {
  test("rounds milliseconds below one second", () => {
    expect(formatLatency(3.2)).toBe("3 ms");
    expect(formatLatency(250.6)).toBe("251 ms");
  });

  test("switches to seconds at and past one second", () => {
    expect(formatLatency(1000)).toBe("1.0 s");
    expect(formatLatency(1234)).toBe("1.2 s");
  });

  test("dashes for absent or invalid measurements", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(Number.NaN)).toBe("—");
    expect(formatLatency(-5)).toBe("—");
  });
});

describe("formatLocalModels", () => {
  test("dashes when the key is absent (hub not wired)", () => {
    expect(formatLocalModels(undefined)).toBe("—");
  });

  test("counts the array when present, singular for one", () => {
    expect(formatLocalModels([])).toBe("0 local models");
    expect(formatLocalModels(["a"])).toBe("1 local model");
    expect(formatLocalModels(["a", "b", "c"])).toBe("3 local models");
  });
});

describe("wsProbeState", () => {
  test("happy path: idle → connecting → connected → closed", () => {
    const started = wsProbeState(WS_PROBE_INITIAL, { type: "start" });
    expect(started).toEqual({ phase: "connecting", everConnected: false, error: null });

    const opened = wsProbeState(started, { type: "open" });
    expect(opened).toEqual({ phase: "connected", everConnected: true, error: null });

    const closed = wsProbeState(opened, { type: "close" });
    expect(closed.phase).toBe("closed");
    // Closed after a successful handshake keeps the positive record.
    expect(closed.everConnected).toBe(true);
  });

  test("error path: connecting → error keeps the message", () => {
    const state = wsProbeState(
      wsProbeState(WS_PROBE_INITIAL, { type: "start" }),
      { type: "error", error: "websocket error" },
    );
    expect(state).toEqual({ phase: "error", everConnected: false, error: "websocket error" });
  });

  test("retry resets the probe from any phase", () => {
    const errored: WsProbeState = {
      phase: "error",
      everConnected: false,
      error: "websocket error",
    };
    expect(wsProbeState(errored, { type: "start" })).toEqual({
      phase: "connecting",
      everConnected: false,
      error: null,
    });

    const closed: WsProbeState = { phase: "closed", everConnected: true, error: null };
    expect(wsProbeState(closed, { type: "start" }).phase).toBe("connecting");
  });

  test("illegal transitions are no-ops (late browser events never corrupt)", () => {
    // close / open / error before any probe: unchanged.
    expect(wsProbeState(WS_PROBE_INITIAL, { type: "close" })).toBe(WS_PROBE_INITIAL);
    expect(wsProbeState(WS_PROBE_INITIAL, { type: "open" })).toBe(WS_PROBE_INITIAL);
    expect(wsProbeState(WS_PROBE_INITIAL, { type: "error", error: "x" })).toBe(
      WS_PROBE_INITIAL,
    );

    // open from connected / closed: unchanged.
    const connected: WsProbeState = { phase: "connected", everConnected: true, error: null };
    expect(wsProbeState(connected, { type: "open" })).toBe(connected);

    // close arriving after error (browser fires onclose after onerror): unchanged.
    const errored: WsProbeState = {
      phase: "error",
      everConnected: true,
      error: "websocket error",
    };
    expect(wsProbeState(errored, { type: "close" })).toBe(errored);

    // error arriving after a clean close: unchanged.
    const closed: WsProbeState = { phase: "closed", everConnected: true, error: null };
    expect(wsProbeState(closed, { type: "error", error: "x" })).toBe(closed);
  });
});

describe("versionLine", () => {
  test("renders name and version from the package metadata", () => {
    expect(versionLine({ name: "weavellm", version: "0.1.0" })).toBe("weavellm v0.1.0");
  });

  test("falls back to the bare version when the name is missing", () => {
    expect(versionLine({ version: "0.1.0" })).toBe("v0.1.0");
  });

  test("dashes when there is no version to show", () => {
    expect(versionLine({ name: "weavellm" })).toBe("—");
    expect(versionLine({})).toBe("—");
    expect(versionLine({ name: "weavellm", version: "" })).toBe("—");
  });
});