/**
 * Error handler (S2.1 — Bun.serve migration).
 *
 * Plain function that takes an error and returns a Response with the
 * OpenAI-shaped envelope: { error: { message, type, param, code } }.
 *
 * Replaces Express's 4-argument error middleware. Helmet is replaced
 * with manual security headers. Hop-by-hop + 503/502 preserved for proxy.
 *
 * CRITICAL INVARIANT (proxy-pipeline spec): when an error occurs after the
 * response headers have already been sent (mid-stream), the handler MUST NOT
 * attempt to write a second response.
 */
import { ZodError } from "zod";

/** Security headers that replace helmet() for the Bun.serve migration. */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "no-referrer",
};

/**
 * Build an OpenAI-shaped error response body.
 */
function buildErrorResponse(
  message: string,
  type: string,
  param: string | null = null,
  code: string | null = null,
): { error: { message: string; type: string; param: string | null; code: string | null } } {
  return { error: { message, type, param, code } };
}

/**
 * Build security headers for error responses.
 */
export function securityHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS };
}

/**
 * Normalize an error into a Response with the OpenAI-shaped envelope.
 *
 * @param err  The error to normalize
 * @param fallbackStatus  HTTP status when the error does not carry one (default 500)
 */
export function errorHandler(
  err: Error & { status?: number; statusCode?: number },
  fallbackStatus = 500,
): Response {
  // ── Zod validation errors → 400 ──
  if (err instanceof ZodError) {
    const messages = err.issues.map((i) => i.message).join("; ");
    const payload = buildErrorResponse(
      messages,
      "invalid_request_error",
      null,
      "validation_error",
    );
    return new Response(JSON.stringify(payload), {
      status: 400,
      headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
    });
  }

  // ── Upstream HTTP errors (thrown by provider adapters with .status) ──
  const status = err.status ?? err.statusCode;
  if (status && status >= 400 && status < 600) {
    const errorType =
      status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "server_error"
          : "invalid_request_error";
    const payload = buildErrorResponse(err.message, errorType, null, null);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
    });
  }

  // ── Generic unhandled errors → fallbackStatus (default 500) ──
  console.error("[errors] unhandled:", err);
  const payload = buildErrorResponse(
    err.message || "Internal server error",
    "server_error",
    null,
    null,
  );
  return new Response(JSON.stringify(payload), {
    status: fallbackStatus,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}
