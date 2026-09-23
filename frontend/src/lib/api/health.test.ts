/**
 * bun:test suite for the /api/health client (getHealth). NO auth gate on the
 * backend — the health branch is open. fetchImpl injected; no network.
 */

import { describe, expect, test } from "bun:test";
import { ApiError, type FetchLike } from "./http.js";
import { getHealth } from "./health.js";

function jsonBody(
  body: unknown,
  status = 200,
): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("getHealth()", () => {
  test("returns {status:\"ok\"} for a live backend", async () => {
    const fetchImpl = jsonBody({ status: "ok" });
    const result = await getHealth({ origin: "http://test", fetchImpl });
    expect(result).toEqual({ status: "ok" });
  });

  test("propagates localModels when a hub is wired", async () => {
    const fetchImpl = jsonBody({ status: "ok", localModels: ["llama-3.1-8b"] });
    const result = await getHealth({ origin: "http://test", fetchImpl });
    expect(result.localModels).toEqual(["llama-3.1-8b"]);
  });

  test("throws ApiError on a non-ok backend status", async () => {
    const fetchImpl = jsonBody({ error: "service_unavailable" }, 503);
    const caught = await getHealth({ origin: "http://test", fetchImpl }).catch(
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
    expect((caught as ApiError).code).toBe("service_unavailable");
  });
});
