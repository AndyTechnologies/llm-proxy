/**
 * Key redaction (keychain-secrets): provider API keys and the proxy auth
 * key must never appear in logs, exports, or error messages. maskKey gives
 * the UI a masked indicator; redactSensitive scrubs key-bearing fields from
 * any log-meta object before it is persisted, recursively.
 */

const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "token",
  "secret",
  "password",
  "passwd",
  "key",
  "x-api-key",
  "x-key",
]);

/** Masked display form: only the final 4 characters survive (UI indicator).
 * Keys of 4 or fewer characters give up nothing — a full mask avoids
 * rendering the complete key material. */
export function maskKey(key: string | null | undefined): string {
  if (key === null || key === undefined || key === "") return "";
  if (key.length <= 4) return "…";
  return `…${key.slice(-4)}`;
}

/** True when a key name suggests it carries secret material. */
function isSensitiveName(name: string): boolean {
  return SENSITIVE_KEYS.has(name.toLowerCase());
}

/**
 * Recursively copy an object replacing every sensitive field with its masked
 * form. Primitive leaves pass through untouched; arrays map element-wise.
 * The key material itself never appears in the returned structure.
 */
export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && isSensitiveName(k)) {
        // The header value often carries a "Bearer " prefix; mask the value
        // without leaking the credential portion.
        const lower = v.toLowerCase();
        if (lower.startsWith("bearer ")) {
          out[k] = `Bearer ${maskKey(v.slice(7))}`;
        } else {
          out[k] = maskKey(v);
        }
      } else if (v !== null && typeof v === "object") {
        out[k] = redactSensitive(v);
      } else {
        out[k] = v;
      }
    }
    return out as T;
  }
  return value;
}