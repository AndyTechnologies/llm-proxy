import { describe, expect, test } from "bun:test";
import { makeAuthGate } from "./auth.js";

const store = (keys: Record<string, string>) => ({
  get: async (scope: string) => keys[scope] ?? null,
});

describe("makeAuthGate", () => {
  test("auth disabled (default): every request is admitted", async () => {
    const gate = makeAuthGate({ enabled: false, store: store({}) });
    expect(await gate(new Request("http://127.0.0.1:4317/v1/chat/completions"))).toBe(true);
  });

  test("enabled + missing Authorization header → denied", async () => {
    const gate = makeAuthGate({ enabled: true, store: store({ auth: "sk-live" }) });
    expect(await gate(new Request("http://127.0.0.1:4317/v1/models"))).toBe(false);
  });

  test("enabled + non-Bearer scheme → denied", async () => {
    const gate = makeAuthGate({ enabled: true, store: store({ auth: "sk-live" }) });
    const req = new Request("http://127.0.0.1:4317/v1/models", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(await gate(req)).toBe(false);
  });

  test("enabled + correct Bearer token → admitted", async () => {
    const gate = makeAuthGate({ enabled: true, store: store({ auth: "sk-live" }) });
    const req = new Request("http://127.0.0.1:4317/v1/models", {
      headers: { Authorization: "Bearer sk-live" },
    });
    expect(await gate(req)).toBe(true);
  });

  test("enabled + wrong token → denied", async () => {
    const gate = makeAuthGate({ enabled: true, store: store({ auth: "sk-live" }) });
    const req = new Request("http://127.0.0.1:4317/v1/models", {
      headers: { Authorization: "Bearer sk-wrong" },
    });
    expect(await gate(req)).toBe(false);
  });

  test("enabled + no stored key → denied even with a token", async () => {
    const gate = makeAuthGate({ enabled: true, store: store({}) });
    const req = new Request("http://127.0.0.1:4317/v1/models", {
      headers: { Authorization: "Bearer sk-live" },
    });
    expect(await gate(req)).toBe(false);
  });

  test("malformed header (extra parts) → denied", async () => {
    const gate = makeAuthGate({ enabled: true, store: store({ auth: "sk-live" }) });
    const req = new Request("http://127.0.0.1:4317/v1/models", {
      headers: { Authorization: "Bearer sk-live extra" },
    });
    expect(await gate(req)).toBe(false);
  });
});