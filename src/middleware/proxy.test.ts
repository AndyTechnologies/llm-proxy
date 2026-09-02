/**
 * Passthrough proxy tests (S2.1 — Bun.serve migration).
 *
 * Verifies hop-by-hop headers are stripped from the forwarded request, and
 * upstream error responses (502, 503) are normalized to the OpenAI envelope.
 * Uses a real in-process Bun.serve backend as the upstream fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LlamaServeManager } from "../backend/manager.js";
import { createPassthroughProxy, forwardHeaders } from "./proxy.js";

let servers: ReturnType<typeof Bun.serve>[] = [];

function serve(fetchImpl: (req: Request) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, fetch: fetchImpl });
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

function managerFor(baseUrl: string): LlamaServeManager {
  return {
    status: () => ({
      state: "running",
      pid: 1,
      models: [] as string[],
      baseUrl,
    }),
  } as unknown as LlamaServeManager;
}

describe("passthrough proxy — hop-by-hop stripping", () => {
  test("forwardHeaders strips connection/keep-alive/te/upgrade and content-length/host", () => {
    const client = new Headers({
      "Content-Type": "application/json",
      Connection: "keep-alive",
      "Keep-Alive": "timeout=5",
      Te: "trailers",
      Upgrade: "websocket",
      Authorization: "Bearer secret",
      Host: "gateway",
      "Content-Length": "42",
    });

    const out = forwardHeaders(client, null);
    expect(out.get("connection")).toBeNull();
    expect(out.get("keep-alive")).toBeNull();
    expect(out.get("te")).toBeNull();
    expect(out.get("upgrade")).toBeNull();
    expect(out.get("host")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("authorization")).toBe("Bearer secret");
    expect(out.get("content-type")).toBe("application/json");
  });

  test("forwardHeaders fills content-type when absent but body content signals JSON", () => {
    const client = new Headers({ Authorization: "Bearer x" });
    const out = forwardHeaders(client, "application/json");
    expect(out.get("content-type")).toBe("application/json");
  });

  test("connection/keep-alive/te/upgrade are stripped from forwarded headers (live upstream)", async () => {
    let seenHeaders: Record<string, string> = {};
    const upstream = serve((req) => {
      seenHeaders = Object.fromEntries(req.headers.entries());
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const proxy = createPassthroughProxy(() => managerFor(`http://127.0.0.1:${upstream.port}`), 5000);
    const clientReq = new Request(`http://gateway/v1/chat/completions?x=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Te: "trailers",
        Upgrade: "websocket",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });

    const res = await proxy(clientReq);
    const body = await res.json();

    expect(res.status).toBe(200);
    // User-supplied hop-by-hop headers must not reach the upstream.
    expect(seenHeaders["te"]).toBeUndefined();
    expect(seenHeaders["upgrade"]).toBeUndefined();
    // Authorization and content-type survive.
    expect(seenHeaders["authorization"]).toBe("Bearer secret");
    expect(seenHeaders["content-type"]).toBe("application/json");
    expect(body).toEqual({});
  });
});

describe("passthrough proxy — 502 normalization", () => {
  test("connection failure → 502 upstream_error envelope", async () => {
    // Refused port on localhost — fetch will throw quickly.
    const proxy = createPassthroughProxy(
      () => managerFor("http://127.0.0.1:1"),
      5000,
    );

    const clientReq = new Request("http://gateway/v1/completions", {
      method: "POST",
      body: "{}",
    });

    const res = await proxy(clientReq);
    const body = (await res.json()) as {
      error: { type: string; code: string };
    };
    expect(res.status).toBe(502);
    expect(body.error.type).toBe("server_error");
    expect(body.error.code).toBe("upstream_error");
  });
});

describe("passthrough proxy — 503 backend unavailable", () => {
  test("empty baseUrl → 503 backend_unavailable", async () => {
    const proxy = createPassthroughProxy(() => managerFor(""), 5000);
    const res = await proxy(new Request("http://gateway/v1/completions"));
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("backend_unavailable");
  });
});

describe("passthrough proxy — upstream error normalization", () => {
  test("upstream 400 is re-enveloped (normalized), not forwarded verbatim", async () => {
    const upstream = serve(() =>
      new Response("raw upstream text", { status: 400 }),
    );
    const proxy = createPassthroughProxy(
      () => managerFor(`http://127.0.0.1:${upstream.port}`),
      5000,
    );

    const res = await proxy(new Request("http://gateway/v1/chat/completions", { method: "POST", body: "{}" }));
    const body = (await res.json()) as { error: { message: string; type: string; param: null; code: null } };
    expect(res.status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("raw upstream text");
    expect(body.error.param).toBeNull();
    expect(body.error.code).toBeNull();
  });

  test("upstream 200 body is streamed through with content-type preserved and hop-by-hop stripped", async () => {
    const upstream = serve(() =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
          Connection: "keep-alive",
        },
      }),
    );
    const proxy = createPassthroughProxy(
      () => managerFor(`http://127.0.0.1:${upstream.port}`),
      5000,
    );

    const res = await proxy(new Request("http://gateway/v1/completions", { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    // Hop-by-hop headers must NOT be present on the gateway response.
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });
});
