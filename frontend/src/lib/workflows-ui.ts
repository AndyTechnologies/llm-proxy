/**
 * Pure display helpers for the workflow library surface (U04).
 *
 * Every function here is deterministic and unit-tested in
 * workflows-ui.test.ts. "Now" is injected (default Date.now()) so relative
 * timestamps stay pure — the same seam buildOverviewSnapshot uses for its
 * fetch-time input. No IO, no Svelte imports: importable under bun:test.
 */

import type { RunWorkflowResult, WorkflowRecord } from "./api/types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Relative timestamps switch to absolute beyond this window (7 days). */
const RELATIVE_WINDOW_MS = 7 * DAY_MS;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Local wall-clock "YYYY-MM-DD HH:mm" (24h), locale-neutral. Exported so
 * tests can assert it with locally-constructed Date objects (timezone-robust).
 */
export function formatLocalDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/**
 * Relative "x min ago" / "x h ago" / "x d ago" under 7 days, absolute local
 * "YYYY-MM-DD HH:mm" beyond that. The present (and near-future timestamps)
 * render "just now"; invalid timestamps render "—".
 */
export function formatUpdatedAt(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "—";
  const diff = now - time;
  if (diff < MINUTE_MS) return "just now";
  if (diff < DAY_MS) {
    const minutes = Math.floor(diff / MINUTE_MS);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ago`;
  }
  if (diff < RELATIVE_WINDOW_MS) {
    return `${Math.floor(diff / DAY_MS)} d ago`;
  }
  return formatLocalDateTime(new Date(time));
}

/**
 * Duration label: "1.2s" at one second and beyond, "384ms" below. Null or
 * otherwise invalid durations render "—".
 */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Display row for the library list. The backend record is the source of
 * truth; `yamlVersionHint` overrides the version column only when the caller
 * holds a fresher revision (e.g. right after a save). The list itself passes
 * null and always treats the API list as truth.
 */
export function workflowRow(
  record: WorkflowRecord,
  yamlVersionHint: number | null = null,
): WorkflowRecord {
  return {
    name: record.name,
    version: yamlVersionHint ?? record.version,
    updatedAt: record.updatedAt,
  };
}

/**
 * The assistant completion text of a run response, or null when the shape
 * carries no extractable content (defensive — never throws).
 */
export function runOutcomeContent(result: RunWorkflowResult): string | null {
  const content = result.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}