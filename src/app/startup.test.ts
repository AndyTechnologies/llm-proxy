import { describe, expect, test } from "bun:test";
import { coldStartOk, measureColdStart } from "./startup.js";

describe("cold start budget", () => {
  test("a sub-2s boot passes the interactive budget", () => {
    const t0 = performance.now();
    // Simulated fast boot: measure right away.
    const ms = measureColdStart(t0);
    expect(coldStartOk(ms)).toBe(true);
  });

  test("a boot far over 2s fails the gate", () => {
    expect(coldStartOk(2500)).toBe(false);
    expect(coldStartOk(2500, 2000)).toBe(false);
  });

  test("custom budget is honoured", () => {
    expect(coldStartOk(1500, 2000)).toBe(true);
    expect(coldStartOk(2100, 2100)).toBe(true);
  });
});