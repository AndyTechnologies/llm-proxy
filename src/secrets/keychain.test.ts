import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../db/schema.js";
import {
  SecretTamperError,
  SecretStore,
  getOrCreateMasterKey,
  makeRandomKey,
  openSecret,
  sealSecret,
  type KeychainBackend,
} from "./keychain.js";

/** In-memory keychain backend: a plain map keyed by the secret string. */
function memoryBackend(initial?: string): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("master", initial);
  return {
    store,
    async get() {
      return store.get("master") ?? null;
    },
    async set(secret: string) {
      store.set("master", secret);
    },
  };
}

/** B64 helper mirroring the module's encoding (validates cross-encoding). */
function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("sealSecret/openSecret — AES-256-GCM", () => {
  test("round-trip: sealed secret opens back to the original plaintext", async () => {
    const key = makeRandomKey();
    const plaintext = "sk-ant-0123456789abcdef";
    const sealed = await sealSecret(key, plaintext);
    expect(await openSecret(key, sealed)).toBe(plaintext);
  });

  test("each seal uses a unique nonce — two seals of the same plaintext differ", async () => {
    const key = makeRandomKey();
    const a = await sealSecret(key, "sk-openai-abc");
    const b = await sealSecret(key, "sk-openai-abc");
    expect(toB64(a.nonce)).not.toBe(toB64(b.nonce));
    expect(toB64(a.ciphertext)).not.toBe(toB64(b.ciphertext));
  });

  test("tampered ciphertext fails with SecretTamperError, never partial plaintext", async () => {
    const key = makeRandomKey();
    const sealed = await sealSecret(key, "sk-secret-value");
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = tampered[0] ^ 0xff;
    await expect(
      openSecret(key, { nonce: sealed.nonce, ciphertext: tampered }),
    ).rejects.toThrow(SecretTamperError);
  });

  test("tampered nonce fails with SecretTamperError", async () => {
    const key = makeRandomKey();
    const sealed = await sealSecret(key, "sk-secret-value");
    const tamperedNonce = new Uint8Array(sealed.nonce);
    tamperedNonce[5] = (tamperedNonce[5] + 1) % 256;
    await expect(
      openSecret(key, { nonce: tamperedNonce, ciphertext: sealed.ciphertext }),
    ).rejects.toThrow(SecretTamperError);
  });

  test("wrong key fails with SecretTamperError (GCM auth check)", async () => {
    const sealed = await sealSecret(makeRandomKey(), "sk-secret-value");
    await expect(openSecret(makeRandomKey(), sealed)).rejects.toThrow(
      SecretTamperError,
    );
  });
});

describe("getOrCreateMasterKey — OS keychain-backed master key", () => {
  test("provisions a 32-byte key on fresh install and reuses the stored one", async () => {
    const backend = memoryBackend();
    const first = await getOrCreateMasterKey(backend);
    expect(first.length).toBe(32);
    // second call reuses the same stored key, does not rotate it
    const second = await getOrCreateMasterKey(backend);
    expect(toB64(first)).toBe(toB64(second));
    expect(backend.store.size).toBe(1);
  });

  test("rejects a stored key that is not 32 bytes (cannot weaken AES-256)", async () => {
    const backend = memoryBackend(toB64(new Uint8Array(16).fill(7)));
    await expect(getOrCreateMasterKey(backend)).rejects.toThrow(/32/);
  });
});

describe("SecretStore — sealed persistence in SQLite", () => {
  function openStore(backend: KeychainBackend): SecretStore {
    const db = new Database(":memory:");
    applySchema(db);
    return new SecretStore(db, backend);
  }

  test("set/get round-trip through SQLite + keychain master key", async () => {
    const store = openStore(memoryBackend());
    await store.set("provider:openai", "sk-openai-live-key");
    expect(await store.get("provider:openai")).toBe("sk-openai-live-key");
  });

  test("get for a scope that was never stored resolves null", async () => {
    const store = openStore(memoryBackend());
    expect(await store.get("provider:anthropic")).toBeNull();
  });

  test("delete removes the record; has() follows the store state", async () => {
    const store = openStore(memoryBackend());
    await store.set("proxy-auth", "sekret");
    expect(await store.has("proxy-auth")).toBe(true);
    await store.delete("proxy-auth");
    expect(await store.has("proxy-auth")).toBe(false);
    expect(await store.get("proxy-auth")).toBeNull();
  });

  test("the secrets table never stores plaintext key material", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const store = new SecretStore(db, memoryBackend());
    const plaintext = "sk-never-in-db-987654";
    await store.set("provider:openai", plaintext);

    const rows = db
      .query("SELECT scope, nonce, ciphertext FROM secrets")
      .all() as Array<{ scope: string; nonce: Uint8Array; ciphertext: Uint8Array }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("provider:openai");
    const nonceText = Buffer.from(rows[0].nonce).toString("latin1");
    const cipherText = Buffer.from(rows[0].ciphertext).toString("latin1");
    expect(nonceText).not.toContain(plaintext);
    expect(cipherText).not.toContain(plaintext);
  });
});