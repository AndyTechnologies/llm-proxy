/**
 * bun:test suite for the workflows surface (workflows.ts). Mirrors
 * config.test.ts (U01) style — describe/test, imports "./x.js" — and injects
 * a fake fetch via WorkflowOptions.fetchImpl, so no real network/backend.
 */

import { describe, expect, test } from "bun:test";
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  runWorkflow,
  saveWorkflow,
  workflowLogs,
} from "./workflows.js";
import type { ExecutionLogRow, WorkflowWithYaml } from "./types.js";

function jsonBody(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), { status, headers });
}

describe("workflows surface", () => {
  test("listWorkflows() returns metadata rows", async () => {
    const rows = [{ name: "summary", version: 3, updatedAt: "2024-01-01T00:00:00Z" }];
    const result = await listWorkflows({
      origin: "http://test",
      fetchImpl: jsonBody(rows),
    });
    expect(result).toEqual(rows);
  });

  test("getWorkflow() returns the record with yaml", async () => {
    const row: WorkflowWithYaml = {
      name: "summary",
      version: 3,
      updatedAt: "2024-01-01T00:00:00Z",
      yaml: "name: summary\n",
    };
    const result = await getWorkflow("summary", {
      origin: "http://test",
      fetchImpl: jsonBody(row),
    });
    expect(result.yaml).toContain("name: summary");
  });

  test("saveWorkflow() PUTs raw YAML text and returns the envelope", async () => {
    const yaml = "name: summary\nversion: 1\n";
    const result = await saveWorkflow("summary", yaml, {
      origin: "http://test",
      fetchImpl: jsonBody({ ok: true, name: "summary", version: 4 }),
    });
    expect(result).toEqual({ ok: true, name: "summary", version: 4 });
  });

  test("deleteWorkflow() resolves on 204", async () => {
    const result = await deleteWorkflow("summary", {
      origin: "http://test",
      fetchImpl: jsonBody(undefined, 204),
    });
    expect(result).toBeUndefined();
  });

  test("runWorkflow() POSTs messages and returns the completion", async () => {
    const result = await runWorkflow(
      "summary",
      [{ role: "user", content: "hi" }],
      {
        origin: "http://test",
        fetchImpl: jsonBody({
          id: "cmpl-1",
          object: "chat.completion",
          created: 1,
          model: "gateway/summary",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello!" },
              finish_reason: "stop",
            },
          ],
          usage: null,
        }),
      },
    );
    expect(result.model).toBe("gateway/summary");
    expect(result.choices[0].message.content).toBe("Hello!");
  });

  test("workflowLogs() returns execution history rows", async () => {
    const rows: ExecutionLogRow[] = [
      { id: "e1", workflowId: "summary", status: "ok", startedAt: "2024-01-01T00:00:00Z", ms: 12 },
    ];
    const result = await workflowLogs("summary", {
      origin: "http://test",
      fetchImpl: jsonBody(rows),
    });
    expect(result).toEqual(rows);
  });
});
