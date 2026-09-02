/**
 * Structured JSON log emitter (S3.1 — health-endpoints Req 4).
 *
 * Emits a single-line JSON object with `level` and `message` plus optional
 * extra fields. Kept a pure function so callers can inject the sink (pass a
 * custom write in tests) and so `index.ts` can route through it.
 *
 * Levels used by the gateway: info, warn, error, fatal.
 */
export function logJson(
  level: string,
  message: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ level, message, ...extra });
}
