/**
 * Pure display helpers for the executions surface (U10).
 *
 * Deterministic and unit-tested in executions-ui.test.ts. No IO, no Svelte
 * imports: importable under bun:test. Every value derives from the
 * ExecutionLogRow[] arrays the backend actually serves (GET
 * /api/workflows/:name/logs — src/orchestrator/store.ts selects
 * `ORDER BY started_at DESC`, so rows arrive newest first).
 *
 * Honest-aggregate discipline: there is NO global executions endpoint, so a
 * page summary can only sum the per-workflow log rows it actually fetched.
 * These helpers count exactly the rows they are given — nothing more, and
 * never "all-time" numbers.
 */

import type { ExecutionLogRow } from "./api/types.js";
import { errorCell } from "./models-ui.js";
import { formatLocalDateTime, formatMs } from "./workflows-ui.js";

/** The two real log statuses the backend writes (store.ts recordExecution). */
export type ExecutionStatus = ExecutionLogRow["status"];

/** Counts over one workflow's log rows — total and per-status buckets. */
export interface ExecutionSummary {
  total: number;
  ok: number;
  error: number;
}

/**
 * Count a log array by status. Every bucket derives from the rows verbatim;
 * an empty array maps to all-zero counts (the honest "No runs yet" case).
 */
export function summarizeExecutions(rows: readonly ExecutionLogRow[]): ExecutionSummary {
  const summary: ExecutionSummary = { total: rows.length, ok: 0, error: 0 };
  for (const row of rows) {
    if (row.status === "ok") {
      summary.ok += 1;
    } else {
      summary.error += 1;
    }
  }
  return summary;
}

/**
 * Parse an ISO timestamp; invalid input sorts last so broken rows never
 * masquerade as the newest run.
 */
function timestampMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * The most recent run: rows sorted by startedAt descending, first element.
 * The backend already orders newest-first; the defensive sort keeps the
 * helper correct against any input order, with stable ties (equal
 * timestamps keep their input order).
 */
export function latestRun(rows: readonly ExecutionLogRow[]): ExecutionLogRow | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => timestampMs(b.startedAt) - timestampMs(a.startedAt));
  return sorted[0] ?? null;
}

/** Chip mapping per status. `tone` is a StatusDot tone; `label` the chip text. */
export const EXECUTION_STATUS_CHIPS = {
  ok: { tone: "ok", label: "OK" },
  error: { tone: "error", label: "Error" },
} as const;

export type ExecutionStatusChip = (typeof EXECUTION_STATUS_CHIPS)[ExecutionStatus];

/** Absolute local "YYYY-MM-DD HH:mm"; invalid timestamps render "—". */
function formatStartedAt(iso: string): string {
  const ms = timestampMs(iso);
  if (!Number.isFinite(ms)) return "—";
  return formatLocalDateTime(new Date(ms));
}

/** How far error text is truncated in the summary line (title keeps the full text). */
const ERROR_CELL_MAX = 96;

/**
 * Display view for one log row: stable {#each} key, chip mapping, formatted
 * timestamps/duration, and the error surface (full + truncated). The caller
 * renders exactly this — no row-level formatting logic in the component.
 */
export interface ExecutionRowView {
  /** Stable identity for {#each} keys — the backend log row id. */
  key: string;
  status: ExecutionStatus;
  chip: ExecutionStatusChip;
  /** Absolute local "YYYY-MM-DD HH:mm". */
  startedAt: string;
  /** "1.2s" / "384ms" / "—". */
  duration: string;
  /** Verbatim backend message on error rows, null otherwise. */
  error: string | null;
  /** Ellipsis-truncated error text for compact rows. */
  errorCell: string;
}

export function executionRowView(row: ExecutionLogRow): ExecutionRowView {
  const isError = row.status === "error" && row.error !== null && row.error !== "";
  const error: string | null = isError ? row.error : null;
  return {
    key: row.id,
    status: row.status,
    chip: EXECUTION_STATUS_CHIPS[row.status],
    startedAt: formatStartedAt(row.startedAt),
    duration: formatMs(row.ms),
    error,
    errorCell: errorCell(error ?? undefined, ERROR_CELL_MAX),
  };
}