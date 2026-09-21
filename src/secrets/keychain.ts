/**
 * Keychain secrets (keychain-secrets): AES-256-GCM sealing under a master
 * key held by the OS keychain (macOS Keychain via `security`, Linux Secret
 * Service via `secret-tool`). The SQLite `secrets` table only ever holds
 * nonce + ciphertext; the master key itself is never written to disk.
 *
 * The KeychainBackend is injectable so unit tests run against an in-memory
 * map while the app default shells out to the platform tooling. The master
 * key is stored as base64 text in the keychain; every seal uses a fresh
 * random 12-byte nonce, and any tampering with nonce or ciphertext fails
 * GCM authentication with a SecretTamperError — never a partial plaintext.
 */
import type { Database } from "bun:sqlite";

/** Raised when a sealed record fails GCM authentication (tamper/wrong key). */
export class SecretTamperError extends Error {
  constructor(message = "sealed secret failed authentication (tampered or wrong key)") {
    super(message);
    this.name = "SecretTamperError";
  }
}

/** A sealed record as persisted: unique nonce + GCM ciphertext. */
export interface SealedSecret {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** OS keychain abstraction: read/write an opaque secret string. */
export interface KeychainBackend {
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
}

const AES_GCM = "AES-GCM" as const;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;

/** Copy bytes into an ArrayBuffer-backed view (BufferSource-safe for WebCrypto). */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Master key ↔ base64 (the keychain stores text, not binary). */
function encodeB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeB64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate a fresh random 32-byte AES-256 master key. */
export function makeRandomKey(): Uint8Array {
  const key = new Uint8Array(new ArrayBuffer(KEY_LENGTH));
  crypto.getRandomValues(key);
  return key;
}

/** Seal a plaintext secret with AES-256-GCM under the given key. */
export async function sealSecret(
  key: Uint8Array,
  plaintext: string,
): Promise<SealedSecret> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(key),
    { name: AES_GCM },
    false,
    ["encrypt"],
  );
  const nonce = new Uint8Array(new ArrayBuffer(NONCE_LENGTH));
  crypto.getRandomValues(nonce);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: AES_GCM, iv: toBufferSource(nonce) },
      cryptoKey,
      new TextEncoder().encode(plaintext),
    ),
  );
  return { nonce, ciphertext };
}

/**
 * Open a sealed secret. Any authentication failure (tampered ciphertext,
 * tampered nonce, wrong key) surfaces as a SecretTamperError — the GCM tag
 * guarantee means no partial plaintext can ever be returned.
 */
export async function openSecret(
  key: Uint8Array,
  sealed: SealedSecret,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(key),
    { name: AES_GCM },
    false,
    ["decrypt"],
  );
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: AES_GCM, iv: toBufferSource(sealed.nonce) },
      cryptoKey,
      toBufferSource(sealed.ciphertext),
    );
  } catch {
    throw new SecretTamperError();
  }
  return new TextDecoder().decode(plain);
}

/**
 * Resolve the master key: reuse the keychain-stored key, or provision a
 * fresh 32-byte key on first use. A stored key that is not 32 bytes is
 * rejected — silently accepting a weak key would downgrade AES-256.
 */
export async function getOrCreateMasterKey(
  backend: KeychainBackend,
): Promise<Uint8Array> {
  const stored = await backend.get();
  if (stored !== null) {
    const key = decodeB64(stored);
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `keychain master key has invalid length ${key.length} (expected ${KEY_LENGTH} bytes)`,
      );
    }
    return key;
  }
  const key = makeRandomKey();
  await backend.set(encodeB64(key));
  return key;
}

/**
 * Secret store: sealed records persisted in the SQLite `secrets` table
 * (scope PK, nonce, ciphertext). The master key is resolved lazily through
 * the keychain and cached for the process lifetime.
 */
export class SecretStore {
  private readonly db: Database;
  private readonly backend: KeychainBackend;
  private keyPromise: Promise<Uint8Array> | null = null;

  constructor(db: Database, backend: KeychainBackend) {
    this.db = db;
    this.backend = backend;
  }

  private key(): Promise<Uint8Array> {
    this.keyPromise ??= getOrCreateMasterKey(this.backend);
    return this.keyPromise;
  }

  /** Seal and persist a secret under the given scope (upsert). */
  async set(scope: string, plaintext: string): Promise<void> {
    const sealed = await sealSecret(await this.key(), plaintext);
    this.db
      .query(
        `INSERT INTO secrets (scope, nonce, ciphertext) VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           nonce = excluded.nonce, ciphertext = excluded.ciphertext`,
      )
      .run(scope, sealed.nonce, sealed.ciphertext);
  }

  /** Read and unseal a secret; null when the scope was never stored. */
  async get(scope: string): Promise<string | null> {
    const row = this.db
      .query("SELECT nonce, ciphertext FROM secrets WHERE scope = ?")
      .get(scope) as { nonce: Uint8Array; ciphertext: Uint8Array } | null;
    if (row === null) return null;
    return openSecret(await this.key(), {
      nonce: row.nonce,
      ciphertext: row.ciphertext,
    });
  }

  async has(scope: string): Promise<boolean> {
    const row = this.db
      .query("SELECT 1 AS present FROM secrets WHERE scope = ?")
      .get(scope);
    return row !== null;
  }

  async delete(scope: string): Promise<void> {
    this.db.query("DELETE FROM secrets WHERE scope = ?").run(scope);
  }
}

/** Spawn a platform binary and return trimmed stdout ('' on missing output). */
type ExecFn = (command: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = async (command, args) => {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) return "";
  return out.trim();
};

/**
 * Real OS keychain backend. Store via `secret-tool` on Linux (Secret
 * Service) and `security` on macOS (Keychain); lookup via the matching
 * read command. Unavailable tooling resolves `get()` to null so a fresh
 * install provisions a new key instead of failing.
 */
export function platformKeychainBackend(
  opts: { exec?: ExecFn; platform?: NodeJS.Platform } = {},
): KeychainBackend {
  const exec = opts.exec ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  const label = "weavellm";
  const account = "master-key";

  if (platform === "darwin") {
    return {
      async get() {
        const out = await exec("security", [
          "find-generic-password",
          "-a",
          account,
          "-s",
          label,
          "-w",
        ]);
        return out === "" ? null : out;
      },
      async set(secret: string) {
        await exec("security", [
          "add-generic-password",
          "-U",
          "-a",
          account,
          "-s",
          label,
          "-w",
          secret,
        ]);
      },
    };
  }

  // Linux Secret Service via libsecret's CLI.
  return {
    async get() {
      const out = await exec("secret-tool", ["lookup", "weavellm", account]);
      return out === "" ? null : out;
    },
    async set(secret: string) {
      await exec("secret-tool", [
        "store",
        "--label=weavellm",
        "weavellm",
        account,
        secret,
      ]);
    },
  };
}