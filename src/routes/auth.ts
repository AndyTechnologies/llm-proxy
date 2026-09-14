/**
 * Request authentication gate (gateway-security spec): OFF by default.
 * When enabled, requests MUST carry a valid `Authorization: Bearer <key>`
 * whose value matches the gateway key stored in the keychain store (scope
 * `auth`). Rejects are constant-time (hashed compare), so token length is
 * never observable over the wire — no stored key means no valid key exists,
 * so every request is denied.
 */
import { timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";

export interface AuthGateOptions {
  enabled: boolean;
  /** Keychain-backed store: `get("auth")` resolves the gateway key. */
  store: { get(scope: string): Promise<string | null> };
}

export type AuthGate = (req: Request) => Promise<boolean>;

/** Constant-time string equality; length is hidden by hashing first. */
function safeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/** Build the gate: auth disabled → admit; enabled → verify Bearer token. */
export function makeAuthGate(opts: AuthGateOptions): AuthGate {
  if (!opts.enabled) {
    return async () => true;
  }
  return async (req: Request): Promise<boolean> => {
    const header = req.headers.get("authorization");
    if (header === null) return false;
    const parts = header.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer" || parts[1].length === 0) {
      return false;
    }
    const expected = await opts.store.get("auth");
    if (expected === null || expected.length === 0) return false;
    return safeEqual(parts[1], expected);
  };
}