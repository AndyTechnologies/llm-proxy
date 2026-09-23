/**
 * bun:test suite for executions-ui.ts (U10) — pure, deterministic helpers.
 * Mirrors the sibling suites (models-ui.test.ts / workflows-ui.test.ts):
 * describe/test, imports "./x.js", no network, no Svelte imports.
 */

import { describe, expect, test } from "bun:test";
import type { ExecutionLogRow } from "./api/types.js";
import {
  EXECUTION_STATUS_CHIPS,
  executionRowView,
  latestRun,
  summarizeExecutions,
} from "./executions-ui.js";
import { formatLocalDateTime, formatMs } from "./workflows-ui.js";

const OK_ROW: ExecutionLogRow = {
  id: "r-ok-1",
  workflowId: "demo",
  status: "ok",
  error: null,
  startedAt: "2026-09-20T14:30:00.000Z",
  ms: 1240,
};

const ERR_ROW: ExecutionLogRow = {
  id: "r-err-1",
  workflowId: "demo",
  status: "error",
  error: "llama-server exited with code 1",
  startedAt: "2026-09-20T15:00:00.000Z",
  ms: null,
};

const ERR_EMPTY_MSG: ExecutionLogRow = {
  id: "r-err-2",
  workflowId: "demo",
  status: "error",
  error: "",
  startedAt: "2026-09-20T15:10:00.000Z",
  ms: 500,
};

const OK_BAD_DATE: ExecutionLogRow = {
  id: "r-ok-2",
  workflowId: "demo",
  status: "ok",
  error: null,
  startedAt: "not-a-date",
  ms: 12,
};

describe("summarizeExecutions", () => {
  test("counts ok and error over a mixed array", () => {
    expect(summarizeExecutions([OK_ROW, ERR_ROW, OK_ROW])).toEqual({
      total: 3,
      ok: 2,
      error: 1,
    });
  });

  test("an empty array is all-zero, never invented numbers", () => {
    expect(summarizeExecutions([])).toEqual({ total: 0, ok: 0, error: 0 });
  });

  test("an all-error array counts zero ok", () => {
    expect(summarizeExecutions([ERR_ROW, ERR_ROW])).toEqual({
      total: 2,
      ok: 0,
      error: 2,
    });
  });
});

describe("latestRun", () => {
  test("empty rows have no latest run", () => {
    expect(latestRun([])).toBeNull();
  });

  test("newest-first input (the backend contract) returns the first row", () => {
    const rows = [ERR_ROW, OK_ROW];
    expect(latestRun(rows)).toBe(ERR_ROW);
  });

  test("is defensive against unsorted input — returns the actual newest", () => {
    const rows = [OK_ROW, ERR_ROW, OK_BAD_DATE];
    const latest = latestRun(rows);
    expect(latest).toBe(ERR_ROW);
  });

  test("invalid timestamps sort last, never as the newest run", () => {
    expect(latestRun([OK_BAD_DATE, OK_ROW])).toBe(OK_ROW);
  });

  test("ties keep their input order (stable sort)", () => {
    const same = [
      { ...OK_ROW, id: "a" },
      { ...OK_ROW, id: "b" },
      { ...OK_ROW, id: "c" },
    ];
    expect(latestRun(same)?.id).toBe("a");
  });
});

describe("EXECUTION_STATUS_CHIPS", () => {
  test("the two real statuses map to stable chips", () => {
    expect(EXECUTION_STATUS_CHIPS.ok).toEqual({ tone: "ok", label: "OK" });
    expect(EXECUTION_STATUS_CHIPS.error).toEqual({ tone: "error", label: "Error" });
  });
});

describe("executionRowView", () => {
  test("ok rows carry the ok chip, formatted time and duration, no error", () => {
    const view = executionRowView(OK_ROW);
    expect(view.key).toBe("r-ok-1");
    expect(view.status).toBe("ok");
    expect(view.chip).toEqual(EXECUTION_STATUS_CHIPS.ok);
    expect(view.startedAt).toBe(formatLocalDateTime(new Date(OK_ROW.startedAt)));
    expect(view.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(view.duration).toBe(formatMs(1240));
    expect(view.duration).toBe("1.2s");
    expect(view.error).toBeNull();
    expect(view.errorCell).toBe("—");
  });

  test("error rows expose the verbatim message and an error chip", () => {
    const view = executionRowView(ERR_ROW);
    expect(view.status).toBe("error");
    expect(view.chip).toEqual(EXECUTION_STATUS_CHIPS.error);
    expect(view.error).toBe("llama-server exited with code 1");
    expect(view.errorCell).toBe("llama-server exited with code 1");
  });

  test("null ms renders a dash duration", () => {
    expect(executionRowView(ERR_ROW).duration).toBe("—");
  });

  test("an empty error string on an error row renders as no error", () => {
    const view = executionRowView(ERR_EMPTY_MSG);
    expect(view.error).toBeNull();
    expect(view.errorCell).toBe("—");
  });

  test("invalid startedAt renders a dash, never NaN", () => {
    expect(executionRowView(OK_BAD_DATE).startedAt).toBe("—");
  });

  test("long error messages truncate with an ellipsis in the cell", () => {
    const long = "x".repeat(200);
    const view = executionRowView({ ...ERR_ROW, error: long });
    expect(view.errorCell.length).toBe(97); // 96 chars + the ellipsis
    expect(view.errorCell.endsWith("…")).toBe(true);
    expect(view.error).toBe(long); // the full text survives for titles
  });
});