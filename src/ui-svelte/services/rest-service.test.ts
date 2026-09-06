/**
 * RED→GREEN tests for the REST service (svelte-ui task 3.1).
 *
 * `rest-service` wraps every `/api/ui/*` endpoint the dashboard views need.
 * The global fetch is stubbed per test; URLs, methods, JSON bodies and the
 * error envelope are all asserted — the browser never sees a raw URL.
 */
import { describe, it, expect, mock } from "bun:test";
import { createRestService, ApiError } from "./rest-service.js";
import type { RestService } from "./rest-service.js";

/** Stub global fetch and capture (url, init). */
function stubFetch(status = 200, body: unknown = {}): () => Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  (globalThis as { fetch: unknown }).fetch = fn;
  return () => calls;
}

function service(): RestService {
  return createRestService("http://test.local");
}

describe("rest service (api/ui contract)", () => {
  it("listPipelines GETs /api/ui/pipelines and parses rows", async () => {
    const calls = stubFetch(200, [{ id: "p1" }]);
    const rows = await service().listPipelines();
    expect(rows).toEqual([{ id: "p1" }]);
    const [{ url, init }] = calls();
    expect(url).toBe("http://test.local/api/ui/pipelines");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("getPipeline encodes the id segment", async () => {
    const calls = stubFetch(200, { id: "a/b c", nodes: [], edges: [] });
    await service().getPipeline("a/b c");
    expect(calls()[0]!.url).toBe("http://test.local/api/ui/pipelines/a%2Fb%20c");
  });

  it("listModels GETs /api/ui/models", async () => {
    const calls = stubFetch(200, { models: [], modelsDir: "/m" });
    const res = await service().listModels();
    expect(res.modelsDir).toBe("/m");
    expect(calls()[0]!.url).toBe("http://test.local/api/ui/models");
  });

  it("getConfig GETs /api/ui/config", async () => {
    const calls = stubFetch(200, { llama: {} });
    await service().getConfig();
    expect(calls()[0]!.url).toBe("http://test.local/api/ui/config");
  });

  it("applyConfig POSTs { config } with JSON content-type", async () => {
    const calls = stubFetch(200, { ok: true });
    const config = { llama: { lifecycle: { ttl: 300 } } };
    await service().applyConfig(config);
    const [{ url, init }] = calls();
    expect(url).toBe("http://test.local/api/ui/apply");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(init.body as string)).toEqual({ config });
  });

  it("unloadModel POSTs the model-specific endpoint", async () => {
    const calls = stubFetch(200, { unloaded: true, modelId: "qwen:7b" });
    await service().unloadModel("qwen:7b");
    const [{ url, init }] = calls();
    expect(url).toBe("http://test.local/api/ui/models/qwen%3A7b/unload");
    expect(init.method).toBe("POST");
  });

  it("unloadAllModels POSTs /api/ui/models/unload-all", async () => {
    const calls = stubFetch(200, { unloaded: 2 });
    await service().unloadAllModels();
    expect(calls()[0]!.url).toBe("http://test.local/api/ui/models/unload-all");
    expect(calls()[0]!.init.method).toBe("POST");
  });

  it("listExecutions forwards the limit query param", async () => {
    const calls = stubFetch(200, []);
    await service().listExecutions(25);
    expect(calls()[0]!.url).toBe("http://test.local/api/ui/executions?limit=25");
  });

  it("validatePipeline POSTs the payload to /validate", async () => {
    const calls = stubFetch(200, { valid: true });
    const payload = { nodes: [], edges: [] };
    await service().validatePipeline("demo", payload);
    const [{ url, init }] = calls();
    expect(url).toBe("http://test.local/api/ui/pipelines/demo/validate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("retryStep POSTs the step-retry endpoint", async () => {
    const calls = stubFetch(200, { success: true, retryExecutionId: "e2" });
    const res = await service().retryStep("e1", "n7");
    expect(res.retryExecutionId).toBe("e2");
    const [{ url, init }] = calls();
    expect(url).toBe("http://test.local/api/ui/executions/e1/steps/n7/retry");
    expect(init.method).toBe("POST");
  });

  it("agentsStatus GETs /api/ui/agents/status", async () => {
    const calls = stubFetch(200, []);
    await service().agentsStatus();
    expect(calls()[0]!.url).toBe("http://test.local/api/ui/agents/status");
  });

  it("configureAgent POSTs /api/ui/agents/configure", async () => {
    const calls = stubFetch(200, { configured: true });
    const cfg = { id: "a1" };
    await service().configureAgent(cfg);
    const [{ url, init }] = calls();
    expect(url).toBe("http://test.local/api/ui/agents/configure");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(cfg);
  });

  it("throws a typed ApiError with status and code on non-2xx", async () => {
    stubFetch(404, { error: { message: "Pipeline not found", type: "not_found_error", code: null } });
    try {
      await service().getPipeline("nope");
      expect.unreachable("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.message).toMatch(/Pipeline not found/);
      expect(apiErr.type).toBe("not_found_error");
    }
  });

  it("throws a generic ApiError when the body is not an error envelope", async () => {
    stubFetch(500, { oops: true });
    try {
      await service().listPipelines();
      expect.unreachable("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
    }
  });
});