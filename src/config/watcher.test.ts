/**
 * Models watcher tests (strict TDD — Slice A).
 *
 * The watcher scans the models directory for candidate `*.gguf` models and
 * emits a `models:changed` hook whenever the detected candidate set changes
 * (feeding the dashboard-api model-list merge in Slice C). Candidate-only:
 * non-gguf files are never surfaced.
 */
import { describe, expect, test } from "bun:test";
import { createModelsWatcher } from "./watcher.js";

describe("models watcher scan", () => {
  test("surfaces only .gguf candidates, case-insensitively", async () => {
    const watcher = createModelsWatcher({
      modelsDir: "/models",
      scan: async () => ["M1.gguf", "M2.GGUF", "notes.txt"],
    });

    const candidates = await watcher.scan();
    expect(candidates.sort()).toEqual(["M1.gguf", "M2.GGUF"]);
  });

  test("returns an empty candidate set when the directory has no models", async () => {
    const watcher = createModelsWatcher({
      modelsDir: "/models",
      scan: async () => [],
    });
    const candidates = await watcher.scan();
    expect(candidates).toEqual([]);
  });
});

describe("models:changed hook", () => {
  test("emits models:changed when the candidate set changes", async () => {
    let calls: string[][] = [];
    const sources = [["m1.gguf"], ["m1.gguf", "m2.gguf"]];
    const watcher = createModelsWatcher({
      modelsDir: "/models",
      scan: async () => sources.shift() ?? [],
    });

    watcher.on("models:changed", (files) => calls.push(files));

    await watcher.refresh(); // first scan: m1
    await watcher.refresh(); // second scan: m1 + m2 (changed)
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["m1.gguf", "m2.gguf"]);
  });

  test("does NOT emit when the candidate set is unchanged", async () => {
    let calls = 0;
    const watcher = createModelsWatcher({
      modelsDir: "/models",
      scan: async () => ["m1.gguf"],
    });

    watcher.on("models:changed", () => {
      calls += 1;
    });

    await watcher.refresh(); // m1 (baseline emit)
    await watcher.refresh(); // still m1 → no emit
    await watcher.refresh(); // still m1 → no emit
    expect(calls).toBe(1);
  });

  test("an empty-to-empty refresh emits nothing", async () => {
    let calls = 0;
    const watcher = createModelsWatcher({
      modelsDir: "/models",
      scan: async () => [],
    });
    watcher.on("models:changed", () => {
      calls += 1;
    });
    await watcher.refresh();
    await watcher.refresh();
    expect(calls).toBe(0);
  });
});
