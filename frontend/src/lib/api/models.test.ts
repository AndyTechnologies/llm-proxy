/**
 * bun:test suite for the models surface (models.ts). Mirrors config.test.ts
 * (U01) style — describe/test, imports "./x.js" — and injects a fake fetch
 * via ModelOptions.fetchImpl so no real network / backend process is touched.
 */

import { expect, test } from "bun:test";
import {
  activateModel,
  deactivateModel,
  getModel,
  listModels,
} from "./models.js";
import { ApiError, type FetchLike } from "./http.js";
import type { ModelStatus } from "./types.js";

function jsonBody(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), { status, headers });
}

const opts = { origin: "http://test", } as const;

test("listModels() GETs /api/models and returns the registry rows", async () => {
  const rows: ModelStatus[] = [
    { id: "llama-3.1-8b", state: "active", pid: 44, port: 11180 },
    { id: "qwen2.5-coder", state: "disabled" },
  ];
  const result = await listModels({ fetchImpl: jsonBody(rows), ...opts });
  expect(result).toEqual(rows);
});

test("getModel() fetches /api/models/:id/status", async () => {
  const row: ModelStatus = { id: "llama-3.1-8b", state: "active", pid: 44, port: 11180 };
  const result = await getModel("llama-3.1-8b", { fetchImpl: jsonBody(row), ...opts });
  expect(result).toEqual(row);
});

test("activateModel() POSTs /activate and returns the pid/port", async () => {
  const result = await activateModel("llama-3.1-8b", {
    fetchImpl: jsonBody({ state: "active", pid: 44, port: 11180 }),
    ...opts,
  });
  expect(result).toEqual({ state: "active", pid: 44, port: 11180 });
});

test("deactivateModel() POSTs /deactivate and returns {state:disabled}", async () => {
  const result = await deactivateModel("llama-3.1-8b", {
    fetchImpl: jsonBody({ state: "disabled" }),
    ...opts,
  });
  expect(result).toEqual({ state: "disabled" });
});

test("returns backend error envelope via ApiError on 404", async () => {
  const caught = await getModel("missing", {
    fetchImpl: jsonBody({ error: "model_not_found" }, 404),
    ...opts,
  }).catch((err: unknown) => err);   ;

  expect(caught).toBeInstanceOf(ApiError);
  expect((caught as ApiError).status).toBe(404);
  expect((caught as ApiError).code).toBe("model_not_found");
  expect((caught as ApiError).message).toBe("model_not_found");
});
