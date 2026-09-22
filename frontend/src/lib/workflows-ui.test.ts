/**
 * Unit tests for the workflow library display helpers (workflows-ui.ts).
 * No IO: "now" is injected, and absolute-timestamp expectations are built
 * through the same Date API the helpers use, so assertions are timezone-robust.
 */

import { describe, expect, test } from "bun:test";
import {
  formatLocalDateTime,
  formatMs,
  formatUpdatedAt,
  runOutcomeContent,
  workflowRow,
} from "./workflows-ui.js";
import type { RunWorkflowResult, WorkflowRecord } from "./api/types.js";

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function isoAgo(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

describe("formatUpdatedAt", () => {
  test("invalid timestamps render em dash", () => {
    expect(formatUpdatedAt("not-a-date", NOW)).toBe("—");
    expect(formatUpdatedAt("", NOW)).toBe("—");
  });

  test("the present and near-future render just now", () => {
    expect(formatUpdatedAt(isoAgo(0), NOW)).toBe("just now");
    expect(formatUpdatedAt(isoAgo(-5 * MINUTE_MS), NOW)).toBe("just now");
  });

  test("under an hour renders minutes ago", () => {
    expect(formatUpdatedAt(isoAgo(MINUTE_MS), NOW)).toBe("1 min ago");
    expect(formatUpdatedAt(isoAgo(59 * MINUTE_MS), NOW)).toBe("59 min ago");
  });

  test("under a day renders hours ago", () => {
    expect(formatUpdatedAt(isoAgo(2 * 60 * MINUTE_MS), NOW)).toBe("2 h ago");
    expect(formatUpdatedAt(isoAgo(23 * 60 * MINUTE_MS), NOW)).toBe("23 h ago");
  });

  test("under seven days renders days ago", () => {
    expect(formatUpdatedAt(isoAgo(DAY_MS), NOW)).toBe("1 d ago");
    expect(formatUpdatedAt(isoAgo(6 * DAY_MS + 12 * 60 * MINUTE_MS), NOW)).toBe("6 d ago");
  });

  test("seven days or older renders an absolute local timestamp", () => {
    const date = new Date(2026, 0, 15, 9, 30); // local wall clock
    const formatted = formatUpdatedAt(date.toISOString(), date.getTime() + 7 * DAY_MS);
    expect(formatted).toBe("2026-01-15 09:30");
  });
});

describe("formatLocalDateTime", () => {
  test("zero-pads month, day, hours and minutes", () => {
    expect(formatLocalDateTime(new Date(2026, 0, 5, 7, 5))).toBe("2026-01-05 07:05");
    expect(formatLocalDateTime(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31 23:59");
  });
});

describe("formatMs", () => {
  test("null and invalid durations render em dash", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(-5)).toBe("—");
    expect(formatMs(Number.NaN)).toBe("—");
  });

  test("sub-second durations render milliseconds", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(384)).toBe("384ms");
    expect(formatMs(999)).toBe("999ms");
  });

  test("one second and beyond render seconds with one decimal", () => {
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(1200)).toBe("1.2s");
    expect(formatMs(1500)).toBe("1.5s");
    expect(formatMs(123_456)).toBe("123.5s");
  });
});

function sampleRecord(version = 2): WorkflowRecord {
  return { name: "summary", version, updatedAt: "2026-09-20T10:00:00Z" };
}

describe("workflowRow", () => {
  test("passes the record through untouched without a version hint", () => {
    expect(workflowRow(sampleRecord(), null)).toEqual(sampleRecord());
  });

  test("a version hint overrides the version column", () => {
    expect(workflowRow(sampleRecord(2), 5).version).toBe(5);
  });

  test("an explicit null hint keeps the record version", () => {
    expect(workflowRow(sampleRecord(3), null).version).toBe(3);
  });
});

function sampleCompletion(): RunWorkflowResult {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gateway/summary",
    choices: [
      { index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" },
    ],
    usage: null,
  };
}

describe("runOutcomeContent", () => {
  test("extracts the first assistant completion text", () => {
    expect(runOutcomeContent(sampleCompletion())).toBe("Hello!");
  });

  test("an empty choices list yields null", () => {
    expect(runOutcomeContent({ ...sampleCompletion(), choices: [] })).toBeNull();
  });

  test("an empty completion text is preserved, not nulled", () => {
    const empty = {
      ...sampleCompletion(),
      choices: [
        { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
      ],
    };
    expect(runOutcomeContent(empty)).toBe("");
  });

  test("a missing content field yields null (defensive)", () => {
    const malformed = {
      ...sampleCompletion(),
      choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "stop" }],
    } as unknown as RunWorkflowResult;
    expect(runOutcomeContent(malformed)).toBeNull();
  });
});