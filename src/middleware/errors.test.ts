/**
 * Error handler tests (strict TDD, S2.1 — Bun.serve migration).
 *
 * The error handler is a plain function that takes an error and returns
 * a Response with the OpenAI-shaped envelope. It replaces helmet with
 * manual security headers and preserves hop-by-hop + 503/502 behavior.
 */
import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { errorHandler, securityHeaders } from "./errors.js";

describe("errorHandler — zod errors → 400", () => {
  test("ZodError maps to 400 with OpenAI envelope", async () => {
    const err = new ZodError([
      {
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: ["model"],
        message: "Expected string, received number",
      },
    ]);

    const res = errorHandler(err);

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.type).toBe("invalid_request_error");
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("Expected string, received number");
  });

  test("multiple zod issues joined with .;.", async () => {
    const err = new ZodError([
      {
        code: "too_small",
        minimum: 1,
        type: "string",
        inclusive: true,
        exact: false,
        path: ["model"],
        message: "Required",
      },
      {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: [],
        message: "Required",
      },
    ]);

    const res = errorHandler(err);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.message).toContain(";");
  });
});

describe("errorHandler — upstream HTTP errors", () => {
  test("status 429 → rate_limit_error", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const res = errorHandler(err);

    expect(res.status).toBe(429);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.type).toBe("rate_limit_error");
    expect(error.message).toBe("rate limited");
  });

  test("status 502 → server_error", async () => {
    const err = Object.assign(new Error("bad gateway"), { status: 502 });
    const res = errorHandler(err);

    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.type).toBe("server_error");
  });

  test("status 503 → server_error", async () => {
    const err = Object.assign(new Error("unavailable"), { status: 503 });
    const res = errorHandler(err);

    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.type).toBe("server_error");
  });

  test("status 400 → invalid_request_error", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const res = errorHandler(err);

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.type).toBe("invalid_request_error");
  });
});

describe("errorHandler — generic errors", () => {
  test("generic Error → 500 server_error", async () => {
    const res = errorHandler(new Error("something broke"));

    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.type).toBe("server_error");
    expect(error.message).toBe("something broke");
  });

  test("empty message defaults to .Internal server error.", async () => {
    const res = errorHandler(new Error(""));
    const body = await res.json() as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.message).toBe("Internal server error");
  });
});

describe("errorHandler — envelope shape", () => {
  test("response body is { error: { message, type, param, code } }", async () => {
    const err = Object.assign(new Error("test"), { status: 418 });
    const res = errorHandler(err);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toHaveProperty("error");
    const error = body.error as Record<string, unknown>;
    expect(error).toHaveProperty("message");
    expect(error).toHaveProperty("type");
    expect(error).toHaveProperty("param");
    expect(error).toHaveProperty("code");
  });
});

describe("securityHeaders", () => {
  test("returns helmet-equivalent security headers", () => {
    const headers = securityHeaders();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-XSS-Protection"]).toBe("1; mode=block");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
  });

  test("returns a new object each time (no shared mutation)", () => {
    const a = securityHeaders();
    const b = securityHeaders();
    a["X-Frame-Options"] = "SAMEORIGIN";
    expect(b["X-Frame-Options"]).toBe("DENY");
  });
});
