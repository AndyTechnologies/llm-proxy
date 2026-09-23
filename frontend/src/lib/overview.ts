/**
 * Overview dashboard data mapping — PURE transform (no IO).
 *
 * The Overview island gathers live inputs through the typed API clients
 * (./api) and funnels them through `buildOverviewSnapshot`, so every derived
 * value is deterministic and fully unit-testable. Missing data is represented
 * honestly: an unreachable backend maps to runtime.status "unavailable", and a
 * failed service call arrives from the caller as an empty array / null — never
 * an invented number.
 */

import type { HealthStatus, ModelStatus, WorkflowRecord } from "./api/types.js";

/** Input gathered by the island (or a test) before mapping. */
export interface OverviewInput {
  /** GET /api/health body, or null when the backend is unreachable. */
  health: HealthStatus | null;
  /** True when a bearer-token gate guards the /api/models branch. */
  authEnabled: boolean;
  /** True when the /api/health probe answered (any status, incl. 401). */
  reachable: boolean;
  /** Registry snapshot; empty when the models branch failed. */
  models: ModelStatus[];
  /** Workflow metadata rows (newest first); empty when the call failed. */
  workflows: WorkflowRecord[];
  /** Epoch ms captured at fetch time — injected so the mapper stays pure. */
  now: number;
}

/** How many of the newest-first workflow rows the dashboard lists. */
export const RECENT_WORKFLOWS_LIMIT = 5;

/** Derived dashboard state — every value comes from the input, honestly. */
export interface OverviewSnapshot {
  runtime: {
    reachable: boolean;
    /** "ok" when the runtime probe answered, "unavailable" otherwise. */
    status: "ok" | "unavailable";
    authEnabled: boolean;
  };
  models: {
    total: number;
    /** Rows in state "active". */
    active: number;
    /** Rows in state "error". */
    error: number;
  };
  workflows: {
    total: number;
    /** First RECENT_WORKFLOWS_LIMIT rows of the newest-first list. */
    recent: Array<{ name: string; version: number; updatedAt: string }>;
  };
  fetchedAt: number;
}

/** Map the raw gathered inputs onto the dashboard snapshot. */
export function buildOverviewSnapshot(input: OverviewInput): OverviewSnapshot {
  const active = input.models.filter((model) => model.state === "active").length;
  const error = input.models.filter((model) => model.state === "error").length;
  const recent = input.workflows.slice(0, RECENT_WORKFLOWS_LIMIT).map((workflow) => ({
    name: workflow.name,
    version: workflow.version,
    updatedAt: workflow.updatedAt,
  }));

  return {
    runtime: {
      reachable: input.reachable,
      status: input.reachable ? "ok" : "unavailable",
      authEnabled: input.authEnabled,
    },
    models: { total: input.models.length, active, error },
    workflows: { total: input.workflows.length, recent },
    fetchedAt: input.now,
  };
}