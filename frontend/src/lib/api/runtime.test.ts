/**
 * bun:test suite for the runtime status probe (runtime.ts). Mirrors
 * config.test.ts (U01) style — describe/test, imports "./x.js" — and injects
 * fake fetch implementations so no real network/backend is touched.
 *
 * runtimeStatus() is deliberately non-throwing; its two key behaviours:
 *   - transport failure ⇒ { reachable:false, authEnabled:false };
 *   - reachable + 401 on the models branch ⇒ authEnabled:true.
 */

import { expect, test } from "bun:test";
import { runtimeStatus } from "./runtime.js";

function jsonBody(
  body: unknown,
  status = 200,
): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

function failingFetch(): typeof fetch {
  return async () => {
    throw new TypeError("fetch failed");
  };
}

const opts = { origin: "http://test" } as const;

test("returns reachable=true plus health when the backend answers", async () => {
  const result = await runtimeStatus({
    ...opts,
    fetchImpl: jsonBody({ status: "ok" }),
  });
  expect(result.reachable).toBe(true);
  expect(result.health).toEqual({ status: "ok" });
  expect(result.authEnabled).toBe(false);
});

test("sets authEnabled=true when the models branch is 401-gated", async () => {
  // Real backend behaviour: /api/health is open (200), only /api/models
  // is auth-gated (401) — so the probe must route by URL.
  const routedFetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/api/health")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }) as typeof fetch;

  const result = await runtimeStatus({
    ...opts,
    fetchImpl: routedFetch,
  });
  expect(result.reachable).toBe(true);
  expect(result.authEnabled).toBe(true);
});

test("returns reachable=false on transport failure, never throwing", async () => {
  const result = await runtimeStatus({
    ...opts,
    fetchImpl: failingFetch(),
  });
  expect(result.reachable).toBe(false);
  expect(result.authEnabled).toBe(false);
  expect(result.health).toBeUndefined();
});
