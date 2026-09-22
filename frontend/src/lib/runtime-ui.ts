/**
 * Pure display helpers for the Runtime page (U12).
 *
 * Deterministic and unit-tested in runtime-ui.test.ts. No IO, no Svelte
 * imports: importable under bun:test. Everything derives from the REAL
 * surface — GET /api/health (status + measured latency + localModels), the
 * runtime auth probe outcome (runtime.ts) and the package.json version —
 * with honest absence: values the probe did not observe render as "—",
 * never as invented telemetry.
 */

import type { HealthStatus } from "./api/types.js";

/** Tone choices the Runtime cards render (StatusCard / StatusDot set). */
export type RuntimeTone = "ok" | "error" | "neutral";

/** Display view for the Health card, from health + measured latency. */
export interface HealthView {
  /** The backend status verbatim ("ok"), or null when nothing answered. */
  status: HealthStatus["status"] | null;
  /** "ok" verbatim, or "—" when there is no answer. */
  statusText: string;
  /** Real round-trip latency line ("123 ms", "1.2 s"), or "—". */
  latency: string;
  /** localModels line ("3 local models"), or "—" when none was sent. */
  localModels: string;
  tone: Exclude<RuntimeTone, "error">;
}

/**
 * Map the health probe onto its display view. A null health is the honest
 * "no answer" case (backend unreachable, probe failed, or not probed yet) —
 * it maps to placeholders, never to invented ok/error telemetry.
 */
export function healthView(
  health: HealthStatus | null,
  latencyMs: number | null,
): HealthView {
  if (health === null) {
    return {
      status: null,
      statusText: "—",
      latency: "—",
      localModels: "—",
      tone: "neutral",
    };
  }
  return {
    status: health.status,
    statusText: health.status,
    latency: formatLatency(latencyMs),
    localModels: formatLocalModels(health.localModels),
    tone: "ok",
  };
}

/** Latency line: rounded ms, seconds past 1s, "—" when not measurable. */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/** localModels line: count of hub-served ids, "—" when the key is absent. */
export function formatLocalModels(count: string[] | undefined): string {
  if (count === undefined) return "—";
  return count.length === 1 ? "1 local model" : `${count.length} local models`;
}

/** Phases of the one-shot WebSocket probe (not the run protocol). */
export const WS_PROBE_PHASES = {
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  CLOSED: "closed",
  ERROR: "error",
} as const;

export type WsProbePhase = (typeof WS_PROBE_PHASES)[keyof typeof WS_PROBE_PHASES];

/** Probe state machine state. */
export interface WsProbeState {
  phase: WsProbePhase;
  /** True once the socket ever reached open — closed-after-ok reads positively. */
  everConnected: boolean;
  /** Last error message; present only in the error phase. */
  error: string | null;
}

/** Initial state: no probe has run yet. */
export const WS_PROBE_INITIAL: WsProbeState = {
  phase: "idle",
  everConnected: false,
  error: null,
};

/** Probe lifecycle actions (a probe connects, waits, then closes). */
export type WsProbeAction =
  | { type: "start" }
  | { type: "open" }
  | { type: "close" }
  | { type: "error"; error: string };

/**
 * Pure probe-state reducer. Transitions are deliberately narrow:
 *   start  → connecting (any phase; a retry re-probes from scratch)
 *   open   → connected  (only from connecting)
 *   close  → closed     (only from connecting / connected)
 *   error  → error      (only from connecting / connected)
 * Anything else is a no-op, so late browser events (e.g. close after error)
 * never corrupt the honest state.
 */
export function wsProbeState(state: WsProbeState, action: WsProbeAction): WsProbeState {
  switch (action.type) {
    case "start":
      return { phase: "connecting", everConnected: false, error: null };
    case "open":
      if (state.phase !== "connecting") return state;
      return { ...state, phase: "connected", everConnected: true };
    case "close":
      if (state.phase !== "connecting" && state.phase !== "connected") return state;
      return { ...state, phase: "closed" };
    case "error":
      if (state.phase !== "connecting" && state.phase !== "connected") return state;
      return { phase: "error", everConnected: state.everConnected, error: action.error };
  }
}

/** Minimum package metadata the version card renders (root package.json). */
export interface PackageMeta {
  name?: string;
  version?: string;
}

/**
 * Version line: "WeaveLLM v0.1.0" from the build-time package.json. Falls
 * back to "v0.1.0" when the name is missing, and to "—" when there is no
 * version to show — the version is whatever the package really declares.
 */
export function versionLine(pkg: PackageMeta): string {
  const version =
    typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
  if (version === null) return "—";
  const name = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : "";
  return name.length > 0 ? `${name} v${version}` : `v${version}`;
}