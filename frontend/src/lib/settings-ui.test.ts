/**
 * Pure helper tests for the Settings page (U13). The honest-data discipline
 * is enforced here: the server-environment rows may only carry the "Coming
 * from backend" placeholder, and auth views derive strictly from the probe.
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeStatus } from "./api/runtime.js";
import {
  AUTH_NOTE,
  COMING_FROM_BACKEND,
  SERVER_ENV_NOTE,
  SERVER_ENV_ROWS,
  authProbe,
  authView,
} from "./settings-ui.js";

describe("authProbe", () => {
  test("reachable with the gate active reports enabled", () => {
    const status: RuntimeStatus = { reachable: true, authEnabled: true };
    expect(authProbe(status)).toEqual({ status: "loaded", authEnabled: true });
  });

  test("reachable with the gate inactive reports disabled", () => {
    const status: RuntimeStatus = { reachable: true, authEnabled: false };
    expect(authProbe(status)).toEqual({ status: "loaded", authEnabled: false });
  });

  test("unreachable backend is an honest error, never telemetry", () => {
    const status: RuntimeStatus = { reachable: false, authEnabled: false };
    expect(authProbe(status)).toEqual({
      status: "error",
      error: "backend unreachable",
    });
  });
});

describe("authView", () => {
  test("loading renders the probing placeholder with no status dot", () => {
    expect(authView({ status: "loading" })).toEqual({
      value: "…",
      hint: "Probing the auth gate…",
      tone: "neutral",
      statusLabel: "",
    });
  });

  test("enabled renders Enabled with the server-owned note", () => {
    expect(authView({ status: "loaded", authEnabled: true })).toEqual({
      value: "Enabled",
      hint: AUTH_NOTE,
      tone: "ok",
      statusLabel: "Enabled",
    });
  });

  test("disabled renders Disabled with the same server-owned note", () => {
    expect(authView({ status: "loaded", authEnabled: false })).toEqual({
      value: "Disabled",
      hint: AUTH_NOTE,
      tone: "neutral",
      statusLabel: "Disabled",
    });
  });

  test("error renders Unavailable with the error verbatim", () => {
    expect(authView({ status: "error", error: "backend unreachable" })).toEqual({
      value: "—",
      hint: "backend unreachable",
      tone: "error",
      statusLabel: "Unavailable",
    });
  });
});

describe("SERVER_ENV_ROWS", () => {
  test("covers the four server-owned settings", () => {
    expect(SERVER_ENV_ROWS.map((row) => row.label)).toEqual([
      "Host",
      "Port",
      "App data directory",
      "State store",
    ]);
  });

  test("every row shows the honest placeholder, never a fake path", () => {
    for (const row of SERVER_ENV_ROWS) {
      expect(row.value).toBe(COMING_FROM_BACKEND);
    }
  });

  test("the note is a single neutral line naming the real env keys", () => {
    expect(SERVER_ENV_NOTE).toContain("WEAVELLM_HOST");
    expect(SERVER_ENV_NOTE).toContain("WEAVELLM_PORT");
    expect(SERVER_ENV_NOTE).toContain("WEAVELLM_APP_DATA");
    expect(SERVER_ENV_NOTE).toContain("not exposed through the public API");
  });
});