/**
 * Trace panel presenters (svelte-ui verify scenario 11). Pure, framework-free.
 */

/** Local time HH:MM:SS from a Date.now() timestamp (deterministic, no locale
 * formatting that could differ across environments). */
export function formatTraceTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Detail presenter: pretty JSON for objects, String for scalars. */
export function formatTraceDetail(detail: unknown): string {
  if (typeof detail === "object" && detail !== null) {
    return JSON.stringify(detail, null, 2);
  }
  return String(detail);
}