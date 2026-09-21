/**
 * bun:test suite for the http transport (request + ApiError). Mirrors the
 * config.test.ts style (U01) — bun:test, describe/test, imports "./x.js" —
 * and drives request() with an injected fake fetch so no real network or
 * backend process is touched.
 */

import { describe, expect, test } from "bun:test";
import { ApiError, request } from "./http.js";

/** Fake fetch returning a canned Response for a single call. */
function jsonBody(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "content-type": "application/json" },
): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers });
}

describe("request()", () => {
  test("parses a 200 JSON response body", async () => {
    const fetchImpl = jsonBody({ name: "file", version: 3 });
    const result = await request<{ name: string; version: number }>("/api/workflows", {
      origin: "http://test",
      fetchImpl,
    });
    expect(result).toEqual({ name: "file", version: 3 });
  });

  test("returns undefined for a 204", async () => {
    const fetchImpl = jsonBody(undefined, 204);
    const result = await request<void>("/api/workflows/del", {
      method: "DELETE",
      origin: "http://test",
      fetchImpl,
    });
    expect(result).toBeUndefined();
  });

  test("throws ApiError wrapping the {error} envelope on non-2xx", async () => {
    const fetchImpl = jsonBody(
      { error: "workflow_not_found" },
      404,
      { "content-type": "application/json" },
    );
    const caught = await request<unknown>("/api/workflows/missing", {
      origin: "http://test",
      fetchImpl,
    }).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.code).toBe("workflow_not_found");
    expect(apiError.message).toBe("workflow_not_found");
  });

  test("throws ApiError(0, network_error) on transport failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const caught = await request<unknown>("/api/health", {
      origin: "http://test",
      fetchImpl,
    }).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(0);
    expect(apiError.code).toBe("network_error");
  });

  test("carries backend envelope errors when present", async () => {
    const fetchImpl = jsonBody(
      { error: "invalid_yaml", errors: [{ path: "nodes", message: "missing start" }] },
      400,
      { "content-type": "application/json" },
    );
    const caught = await request<unknown>("/api/workflows/x", {
      method: "PUT",
      origin: "http://test",
      fetchImpl,
    }).catch((err: unknown) => err);

    const apiError = caught as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("invalid_yaml");
    expect(apiError.errors).toEqual([{ path: "nodes", message: "missing start" }]);
  });
});
