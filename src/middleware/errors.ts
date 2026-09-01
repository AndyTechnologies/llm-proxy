/**
 * Global Express error handler.
 *
 * Normalizes every unhandled error into the OpenAI-shaped envelope:
 *   { error: { message, type, param, code } }
 *
 * CRITICAL INVARIANT (proxy-pipeline spec): when an error occurs after the
 * response headers have already been sent (mid-stream), the handler MUST NOT
 * attempt to write a second response. The `res.headersSent` guard ensures
 * exactly ONE terminal chunk, no duplicate error payload after finish.
 */
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import type { ErrorResponse } from "../types/openai.js";

/**
 * Build an OpenAI-shaped error response body.
 */
function buildErrorResponse(
  message: string,
  type: string,
  param: string | null = null,
  code: string | null = null,
): ErrorResponse {
  return { error: { message, type, param, code } };
}

/**
 * Global error handler — mounted LAST on the Express app.
 *
 * Express identifies error handlers by their 4-argument signature; this
 * function intentionally accepts all four parameters.
 */
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
export function errorHandler(
  err: Error & { status?: number; statusCode?: number },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // ── Invariant: never write after headers are sent ──
  if (res.headersSent) {
    console.error("[errors] headers already sent, swallowing:", err.message);
    return;
  }

  // ── Zod validation errors → 400 ──
  if (err instanceof ZodError) {
    const messages = err.issues.map((i) => i.message).join("; ");
    const payload = buildErrorResponse(
      messages,
      "invalid_request_error",
      null,
      "validation_error",
    );
    res.status(400).json(payload);
    return;
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
    res.status(status).json(payload);
    return;
  }

  // ── Generic unhandled errors → 500 ──
  console.error("[errors] unhandled:", err);
  const payload = buildErrorResponse(
    err.message || "Internal server error",
    "server_error",
    null,
    null,
  );
  res.status(500).json(payload);
}
