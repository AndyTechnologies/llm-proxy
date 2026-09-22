/**
 * bun:test suite for models-ui.ts (U08) — pure, deterministic helpers.
 * Mirrors the sibling suites (overview.test.ts / workflows-ui.test.ts):
 * describe/test, imports "./x.js", no network, no Svelte imports.
 */

import { describe, expect, test } from "bun:test";
import {
  MODEL_STATE_CHIPS,
  errorCell,
  formatError,
  formatPid,
  formatPort,
  modelRows,
  stateChip,
  summarizeModels,
} from "./models-ui.js";
import type { ModelStatus } from "./api/types.js";

const ACTIVE: ModelStatus = { id: "zebra-7b", state: "active", pid: 4242, port: 11180 };
const DISABLED: ModelStatus = { id: "alpha-1b", state: "disabled" };
const ERROR: ModelStatus = {
  id: "mid-3b",
  state: "error",
  error: "GGUF file not found: '(none)'",
};

describe("summarizeModels", () => {
  test("counts each state bucket over a mixed registry", () => {
    expect(summarizeModels([ACTIVE, DISABLED, ERROR, ACTIVE])).toEqual({
      total: 4,
      active: 2,
      disabled: 1,
      error: 1,
    });
  });

  test("an empty registry is all-zero, never invented numbers", () => {
    expect(summarizeModels([])).toEqual({ total: 0, active: 0, disabled: 0, error: 0 });
  });

  test("error bucket counts only state error", () => {
    expect(summarizeModels([ERROR, DISABLED])).toEqual({
      total: 2,
      active: 0,
      disabled: 1,
      error: 1,
    });
  });
});

describe("stateChip / MODEL_STATE_CHIPS", () => {
  test("the three real states map to stable chips", () => {
    expect(stateChip("active")).toEqual(MODEL_STATE_CHIPS.active);
    expect(stateChip("disabled")).toEqual(MODEL_STATE_CHIPS.disabled);
    expect(stateChip("error")).toEqual(MODEL_STATE_CHIPS.error);
  });

  test("chip contract: ok/idle/error tones with Active/Disabled/Error labels", () => {
    expect(MODEL_STATE_CHIPS.active).toEqual({ tone: "ok", label: "Active" });
    expect(MODEL_STATE_CHIPS.disabled).toEqual({ tone: "idle", label: "Disabled" });
    expect(MODEL_STATE_CHIPS.error).toEqual({ tone: "error", label: "Error" });
  });
});

describe("modelRows", () => {
  const registry = [ACTIVE, DISABLED, ERROR];

  test("no hints → every model sorted by id ascending", () => {
    expect(modelRows(registry).map((m) => m.id)).toEqual(["alpha-1b", "mid-3b", "zebra-7b"]);
  });

  test("hint ids pin first, in the given order, rest sorted after", () => {
    const rows = modelRows(registry, ["zebra-7b", "alpha-1b"]);
    expect(rows.map((m) => m.id)).toEqual(["zebra-7b", "alpha-1b", "mid-3b"]);
    expect(rows[0]).toEqual(ACTIVE);
    expect(rows[1]).toEqual(DISABLED);
  });

  test("duplicate hint ids pin once", () => {
    expect(modelRows(registry, ["zebra-7b", "zebra-7b"]).map((m) => m.id)).toEqual([
      "zebra-7b",
      "alpha-1b",
      "mid-3b",
    ]);
  });

  test("hint ids absent from the registry are ignored", () => {
    expect(modelRows(registry, ["ghost"]).map((m) => m.id)).toEqual([
      "alpha-1b",
      "mid-3b",
      "zebra-7b",
    ]);
  });

  test("empty registry stays empty", () => {
    expect(modelRows([])).toEqual([]);
  });
});

describe("formatPid / formatPort", () => {
  test("numbers render verbatim", () => {
    expect(formatPid(4242)).toBe("4242");
    expect(formatPort(11180)).toBe("11180");
  });

  test("absent values render a dash", () => {
    expect(formatPid(undefined)).toBe("—");
    expect(formatPort(undefined)).toBe("—");
  });

  test("non-finite numbers render a dash, never NaN", () => {
    expect(formatPid(Number.NaN)).toBe("—");
    expect(formatPort(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatError / errorCell", () => {
  test("the backend message renders verbatim", () => {
    expect(formatError("spawn failed: boom")).toBe("spawn failed: boom");
  });

  test("absent errors render a dash", () => {
    expect(formatError(undefined)).toBe("—");
    expect(formatError("")).toBe("—");
  });

  test("short messages pass through untruncated", () => {
    expect(errorCell("spawn failed")).toBe("spawn failed");
  });

  test("long messages truncate with an ellipsis at the max length", () => {
    const long = "x".repeat(200);
    const cell = errorCell(long);
    expect(cell.length).toBe(97); // 96 chars + the ellipsis
    expect(cell.endsWith("…")).toBe(true);
    expect(cell.startsWith(long.slice(0, 96))).toBe(true);
  });

  test("absent errors stay a dash even under truncation", () => {
    expect(errorCell(undefined)).toBe("—");
  });
});