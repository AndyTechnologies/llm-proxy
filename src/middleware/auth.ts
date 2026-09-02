/**
 * Optional Bearer token authentication guard (S2a — Bun.serve migration).
 *
 * Reads the required token from `BEARER_TOKEN` env. When the env var is set,
 * every inbound request must carry `Authorization: Bearer <token>` — missing
 * or mismatched tokens receive a 401 with the standard OpenAI-shaped body.
 * When the env var is absent, the guard is a no-op pass-through.
 *
 * Returns `null` to indicate the request is authorized (continue); returns a
 * `Response` (401) when the token is missing or mismatched.
 *
 * WHY optional (design decision): local development and single-user deployments
 * should not be forced to configure auth. Production deployments set the env
 * and get automatic protection without code changes.
 */
const REQUIRED_TOKEN = process.env.BEARER_TOKEN;

const UNAUTHORIZED = new Response(
  JSON.stringify({
    error: {
      message: "Unauthorized",
      type: "authentication_error",
      param: null,
      code: null,
    },
  }),
  { status: 401, headers: { "Content-Type": "application/json" } },
);

/**
 * @returns null when authorized (continue), or a 401 Response to short-circuit.
 */
export function authorize(req: Request): Response | null {
  if (!REQUIRED_TOKEN) return null;

  const header = req.headers.get("authorization");
  if (header !== `Bearer ${REQUIRED_TOKEN}`) {
    return UNAUTHORIZED;
  }
  return null;
}

/** Convenience guard for use inside a fetch handler chain. */
export function authGuard(req: Request): Response | null {
  return authorize(req);
}