import { describe, expect, test } from "bun:test";
import { maskKey, redactSensitive } from "./redact.js";

describe("maskKey", () => {
  test("returns a masked indicator showing only the last 4 characters", () => {
    expect(maskKey("sk-openai-abcdef123456")).toBe("…3456");
  });

  test("never returns the full key, even for short keys", () => {
    const masked = maskKey("abc");
    expect(masked).not.toBe("abc");
    expect(masked.length).toBeLessThan(3);
  });

  test("empty or absent keys stay empty (nothing to leak)", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey(null)).toBe("");
    expect(maskKey(undefined)).toBe("");
  });
});

describe("redactSensitive", () => {
  test("scrubs known key-bearing fields at the top level of log meta", () => {
    const out = redactSensitive({
      apiKey: "sk-top-secret",
      authorization: "Bearer sk-bearer-secret",
      token: "tok-123",
      message: "request failed",
    });
    expect(out.message).toBe("request failed");
    expect(out.apiKey).not.toContain("sk-top-secret");
    expect(out.authorization).not.toContain("sk-bearer-secret");
    expect(out.token).not.toContain("tok-123");
    expect(String(out.apiKey)).toMatch(/…/);
  });

  test("scrubs nested objects recursively (headers and inner records)", () => {
    const out = redactSensitive({
      headers: { Authorization: "Bearer sk-nested", "X-Key": "nx-42" },
      meta: { credentials: { password: "hunter2" }, secret: "s3c" },
    });
    expect(out.headers.Authorization).not.toContain("sk-nested");
    expect(out.headers["X-Key"]).not.toContain("nx-42");
    expect(out.meta.credentials.password).not.toContain("hunter2");
    expect(out.meta.secret).not.toContain("s3c");
  });

  test("never emits the key material anywhere in the redacted output", () => {
    const secret = "sk-ultra-confidential-999";
    const out = redactSensitive({ apiKey: secret, nested: { key: secret } });
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});