/**
 * Optional Bearer token authentication middleware.
 *
 * Reads the required token from `BEARER_TOKEN` env. When the env var is set,
 * every inbound request must carry `Authorization: Bearer <token>` — missing
 * or mismatched tokens receive a 401 with the standard OpenAI-shaped body.
 * When the env var is absent, the middleware is a no-op pass-through.
 *
 * WHY optional (design decision): local development and single-user deployments
 * should not be forced to configure auth. Production deployments set the env
 * and get automatic protection without code changes.
 */
import type { Request, Response, NextFunction } from "express";

const REQUIRED_TOKEN = process.env.BEARER_TOKEN;

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // No token configured → auth is disabled; every request passes.
  if (!REQUIRED_TOKEN) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${REQUIRED_TOKEN}`) {
    res.status(401).json({
      error: {
        message: "Unauthorized",
        type: "authentication_error",
        param: null,
        code: null,
      },
    });
    return;
  }

  next();
}
