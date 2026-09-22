/**
 * Pure display helpers for the Settings page (U13).
 *
 * The settings surface is deliberately read-only: the backend exposes no
 * settings API, and server-owned env (WEAVELLM_HOST / WEAVELLM_PORT /
 * WEAVELLM_APP_DATA and the SQLite store path) is not observable from the
 * browser. Everything here derives from the REAL surface — the runtime auth
 * probe (runtime.ts) — plus an honest placeholder for what the browser
 * cannot observe. The row table exists so a test can enforce that no fake
 * path or invented value ever enters the server-environment card.
 */

import type { RuntimeStatus } from "./api/runtime.js";

/** The only honest value the server-environment rows can render. */
export const COMING_FROM_BACKEND = "Coming from backend";

/** Note every Authentication card carries (server-owned, never the console). */
export const AUTH_NOTE =
  "Owned server-side via WEAVELLM_AUTH — this console never holds or changes the key.";

/** Display tone choices the Settings cards render (StatusCard / StatusDot). */
export type SettingsTone = "ok" | "error" | "neutral";

/** Authentication probe state: loading → loaded (probe) or error. */
export type AuthProbeState =
  | { status: "loading" }
  | { status: "loaded"; authEnabled: boolean }
  | { status: "error"; error: string };

/** Display view for the Authentication card. */
export interface AuthCardView {
  value: string;
  hint: string;
  tone: SettingsTone;
  statusLabel: string;
}

/**
 * Map the auth probe onto its display view. Placeholders (never guesses):
 * loading renders a wait state, an unreachable backend renders the error
 * verbatim, and the gate outcome renders Enabled/Disabled — all from the
 * runtimeStatus() result, nothing invented.
 */
export function authView(state: AuthProbeState): AuthCardView {
  switch (state.status) {
    case "loading":
      return { value: "…", hint: "Probing the auth gate…", tone: "neutral", statusLabel: "" };
    case "error":
      return { value: "—", hint: state.error, tone: "error", statusLabel: "Unavailable" };
    case "loaded":
      return state.authEnabled
        ? { value: "Enabled", hint: AUTH_NOTE, tone: "ok", statusLabel: "Enabled" }
        : { value: "Disabled", hint: AUTH_NOTE, tone: "neutral", statusLabel: "Disabled" };
  }
}

/**
 * Map a runtimeStatus() result onto the probe state. runtimeStatus never
 * throws: an unreachable backend is the honest error case, never telemetry.
 */
export function authProbe(result: RuntimeStatus): AuthProbeState {
  return result.reachable
    ? { status: "loaded", authEnabled: result.authEnabled }
    : { status: "error", error: "backend unreachable" };
}

/** A static server-environment row: label + the honest placeholder only. */
export interface ServerEnvRow {
  label: string;
  value: string;
}

/**
 * Server-owned configuration the public API never exposes. Values stay the
 * honest placeholder — the browser cannot observe host/port/app-data/store,
 * so any real-looking path here would be a lie.
 */
export const SERVER_ENV_ROWS: readonly ServerEnvRow[] = [
  { label: "Host", value: COMING_FROM_BACKEND },
  { label: "Port", value: COMING_FROM_BACKEND },
  { label: "App data directory", value: COMING_FROM_BACKEND },
  { label: "State store", value: COMING_FROM_BACKEND },
];

/** One-line neutral note for the Server environment card. */
export const SERVER_ENV_NOTE =
  "Server-owned configuration (WEAVELLM_HOST, WEAVELLM_PORT, WEAVELLM_APP_DATA, SQLite store) is not exposed through the public API.";