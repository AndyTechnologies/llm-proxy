/**
 * Unit tests for the pure overview mapping (overview.ts). No IO: each test
 * feeds a deterministic input object and asserts on the derived snapshot —
 * empty inputs, state counts, newest-first truncation, unreachable runtime
 * and allSettled-style partial inputs (missing pieces arrive as empty arrays
 * / null / false and must map deterministically).
 */

import { describe, expect, test } from "bun:test";
import { buildOverviewSnapshot, RECENT_WORKFLOWS_LIMIT } from "./overview.js";
import type { OverviewInput } from "./overview.js";
import type { HealthStatus, ModelStatus, WorkflowRecord } from "./api/types.js";

const NOW = 1_700_000_000_000;

function sampleHealth(): HealthStatus {
  return { status: "ok" };
}

function sampleModel(id: string, state: ModelStatus["state"], error?: string): ModelStatus {
  return error === undefined ? { id, state } : { id, state, error };
}

function sampleWorkflow(name: string, version = 1): WorkflowRecord {
  return {
    name,
    version,
    updatedAt: `2026-09-${String(version).padStart(2, "0")}T10:00:00Z`,
  };
}

function baseInput(): OverviewInput {
  return {
    health: sampleHealth(),
    authEnabled: false,
    reachable: true,
    models: [],
    workflows: [],
    now: NOW,
  };
}

describe("buildOverviewSnapshot", () => {
  test("empty inputs produce a deterministic zeroed snapshot", () => {
    const snapshot = buildOverviewSnapshot({
      health: null,
      authEnabled: false,
      reachable: false,
      models: [],
      workflows: [],
      now: NOW,
    });

    expect(snapshot).toEqual({
      runtime: { reachable: false, status: "unavailable", authEnabled: false },
      models: { total: 0, active: 0, error: 0 },
      workflows: { total: 0, recent: [] },
      fetchedAt: NOW,
    });
  });

  test("counts active and error states from the model rows", () => {
    const snapshot = buildOverviewSnapshot({
      ...baseInput(),
      authEnabled: true,
      models: [
        sampleModel("a", "active"),
        sampleModel("b", "active"),
        sampleModel("c", "disabled"),
        sampleModel("d", "error", "spawn failed"),
      ],
    });

    expect(snapshot.runtime).toEqual({
      reachable: true,
      status: "ok",
      authEnabled: true,
    });
    expect(snapshot.models).toEqual({ total: 4, active: 2, error: 1 });
  });

  test("truncates the newest-first workflow list to the limit", () => {
    const workflows = Array.from({ length: RECENT_WORKFLOWS_LIMIT + 2 }, (_x, i) =>
      sampleWorkflow(`wf-${i}`, i + 1),
    );
    const snapshot = buildOverviewSnapshot({
      ...baseInput(),
      workflows,
    });

    expect(snapshot.workflows.total).toBe(RECENT_WORKFLOWS_LIMIT + 2);
    expect(snapshot.workflows.recent).toHaveLength(RECENT_WORKFLOWS_LIMIT);
    expect(snapshot.workflows.recent[0].name).toBe("wf-0");
    expect(snapshot.workflows.recent[RECENT_WORKFLOWS_LIMIT - 1].name).toBe(
      `wf-${RECENT_WORKFLOWS_LIMIT - 1}`,
    );
  });

  test("keeps the caller-given newest-first order untouched", () => {
    const workflows = [sampleWorkflow("newest", 4), sampleWorkflow("older", 1)];
    const snapshot = buildOverviewSnapshot({ ...baseInput(), workflows });

    expect(snapshot.workflows.recent.map((wf) => wf.name)).toEqual(["newest", "older"]);
  });

  test("an unreachable runtime reads unavailable even when health data exists", () => {
    const snapshot = buildOverviewSnapshot({
      health: sampleHealth(),
      authEnabled: false,
      reachable: false,
      models: [sampleModel("a", "active")],
      workflows: [sampleWorkflow("w")],
      now: NOW,
    });

    expect(snapshot.runtime).toEqual({
      reachable: false,
      status: "unavailable",
      authEnabled: false,
    });
    // The rest of the dashboard still maps from whatever actually arrived.
    expect(snapshot.models.total).toBe(1);
    expect(snapshot.workflows.total).toBe(1);
  });

  test("allSettled-style partial inputs map deterministically", () => {
    // Mirrors the island: a failed service call lands as an empty array.
    const snapshot = buildOverviewSnapshot({
      health: null,
      authEnabled: true,
      reachable: true,
      models: [],
      workflows: [],
      now: NOW,
    });

    expect(snapshot.runtime.status).toBe("ok");
    expect(snapshot.runtime.authEnabled).toBe(true);
    expect(snapshot.models).toEqual({ total: 0, active: 0, error: 0 });
    expect(snapshot.workflows).toEqual({ total: 0, recent: [] });
  });
});