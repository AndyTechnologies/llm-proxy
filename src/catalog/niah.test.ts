/**
 * Phase 3 — NIAH context probe (local-model-catalog): needle-in-a-haystack
 * probe that validates a model's effective context and records per-model
 * pass/fail in the SQLite registry.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import {
  buildNiahPrompt,
  evaluateNiah,
  getProbeStatus,
  needleRecalled,
  runNiahProbe,
  setProbeStatus,
} from "./niah.js";

function memoryDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("needleRecalled + evaluateNiah (3.7)", () => {
  test("recall detection is exact-substring based", () => {
    expect(needleRecalled("The passphrase is S3CR3T-NEEDLE.", "S3CR3T-NEEDLE")).toBe(true);
    expect(needleRecalled("Nothing relevant here.", "S3CR3T-NEEDLE")).toBe(false);
  });

  test("evaluateNiah maps recall to pass/fail", () => {
    expect(evaluateNiah(true)).toBe("pass");
    expect(evaluateNiah(false)).toBe("fail");
  });
});

describe("buildNiahPrompt", () => {
  test("embeds the needle once among haystack filler with a retrieval instruction", () => {
    const prompt = buildNiahPrompt({
      needle: "BTW-9142",
      filler: "The quick brown fox jumps over the lazy dog.",
      haystackSize: 4,
    });
    expect(prompt).toContain("BTW-9142");
    expect(prompt).toContain("secret string");
    // Filler blocks appear haystackSize times around the needle.
    expect(prompt.match(/quick brown fox/g)).toHaveLength(4);
  });
});

describe("runNiahProbe (3.7)", () => {
  test("needle retrieved → pass result", async () => {
    const result = await runNiahProbe({
      declaredCtx: 131072,
      needle: "BTW-9142",
      filler: "The quick brown fox jumps over the lazy dog.",
      haystackSize: 8,
      generate: async (prompt) => {
        expect(prompt).toContain("BTW-9142");
        return "The secret string is BTW-9142.";
      },
    });
    expect(result.needleFound).toBe(true);
    expect(result.status).toBe("pass");
    expect(result.declaredCtx).toBe(131072);
  });

  test("needle not retrieved → fail result surfaced", async () => {
    const result = await runNiahProbe({
      declaredCtx: 131072,
      needle: "BTW-9142",
      filler: "The quick brown fox jumps over the lazy dog.",
      haystackSize: 8,
      generate: async () => "I have no idea what the secret string is.",
    });
    expect(result.needleFound).toBe(false);
    expect(result.status).toBe("fail");
  });
});

describe("probe status persistence", () => {
  test("setProbeStatus records pass/fail against the model and reads back", () => {
    const db = memoryDb();
    db.query(
      `INSERT INTO models (id, source, name, state, gguf_ctx, yarn_orig_ctx) VALUES (?, 'local', ?, 'registered', 32768, 8192)`,
    ).run("m-1", "m-1");
    setProbeStatus(db, "m-1", "pass");
    expect(getProbeStatus(db, "m-1")).toBe("pass");
    setProbeStatus(db, "m-1", "fail");
    expect(getProbeStatus(db, "m-1")).toBe("fail");
  });

  test("runNiahProbe persists the result to the registry", async () => {
    const db = memoryDb();
    db.query(
      `INSERT INTO models (id, source, name, state) VALUES (?, 'local', ?, 'registered')`,
    ).run("m-2", "m-2");
    const result = await runNiahProbe({
      declaredCtx: 131072,
      needle: "BTW-9142",
      filler: "The quick brown fox jumps over the lazy dog.",
      haystackSize: 8,
      generate: async () => "BTW-9142",
      db,
      modelId: "m-2",
    });
    expect(result.status).toBe("pass");
    expect(getProbeStatus(db, "m-2")).toBe("pass");
  });
});