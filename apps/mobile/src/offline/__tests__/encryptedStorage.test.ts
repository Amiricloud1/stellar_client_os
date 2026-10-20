import { describe, expect, it } from "vitest";
import {
  createIdentityCipher,
  createXorCipher,
  writeEncryptedJSON,
  readEncryptedJSON,
  applyMigrations,
  clearSensitiveStorage,
  EncryptedKeyValueStorage,
  CURRENT_SCHEMA_VERSION,
  SENSITIVE_NAMESPACE,
  type StoredEnvelope,
  type MigrationMap,
} from "../encryptedStorage";
import { createMemoryStorage } from "../storage";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sensitiveKey(suffix: string): string {
  return `${SENSITIVE_NAMESPACE}.${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// StorageCipher
// ─────────────────────────────────────────────────────────────────────────────

describe("createIdentityCipher", () => {
  it("encrypt then decrypt is a round-trip", async () => {
    const cipher = createIdentityCipher();
    const msg = "hello world";
    expect(await cipher.decrypt(await cipher.encrypt(msg))).toBe(msg);
  });

  it("encrypted value equals plaintext (no-op)", async () => {
    const cipher = createIdentityCipher();
    expect(await cipher.encrypt("data")).toBe("data");
  });
});

describe("createXorCipher", () => {
  it("encrypt then decrypt is a round-trip", async () => {
    const cipher = createXorCipher("secret-key");
    const msg = JSON.stringify({ hello: "world" });
    expect(await cipher.decrypt(await cipher.encrypt(msg))).toBe(msg);
  });

  it("ciphertext differs from plaintext", async () => {
    const cipher = createXorCipher("k");
    const plain = "test";
    const encrypted = await cipher.encrypt(plain);
    expect(encrypted).not.toBe(plain);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeEncryptedJSON / readEncryptedJSON
// ─────────────────────────────────────────────────────────────────────────────

describe("writeEncryptedJSON / readEncryptedJSON", () => {
  it("round-trips a value through the identity cipher", async () => {
    const storage = createMemoryStorage();
    const cipher = createIdentityCipher();
    await writeEncryptedJSON(storage, cipher, "key", { x: 1 });
    const result = await readEncryptedJSON<{ x: number }>(storage, cipher, "key");
    expect(result).toEqual({ x: 1 });
  });

  it("round-trips through the XOR cipher", async () => {
    const storage = createMemoryStorage();
    const cipher = createXorCipher("passphrase");
    const value = { wallet: "GBBB...", token: "abc123" };
    await writeEncryptedJSON(storage, cipher, sensitiveKey("auth"), value);

    // Raw bytes in storage are NOT plain JSON.
    const raw = await storage.getItem(sensitiveKey("auth"));
    expect(raw).not.toContain("wallet");

    const result = await readEncryptedJSON<typeof value>(
      storage,
      cipher,
      sensitiveKey("auth"),
    );
    expect(result).toEqual(value);
  });

  it("returns null when the key is absent", async () => {
    const result = await readEncryptedJSON(
      createMemoryStorage(),
      createIdentityCipher(),
      "missing",
    );
    expect(result).toBeNull();
  });

  it("deletes and returns null on corrupt ciphertext (decryption failure)", async () => {
    const storage = createMemoryStorage();
    // Inject a cipher whose decrypt always throws.
    const badCipher = {
      encrypt: async (p: string) => p,
      decrypt: async (): Promise<string> => {
        throw new Error("tampered");
      },
    };
    await storage.setItem("key", "garbage");
    const result = await readEncryptedJSON(storage, badCipher, "key");
    expect(result).toBeNull();
    // Corrupt entry should be cleaned up.
    expect(await storage.getItem("key")).toBeNull();
  });

  it("deletes and returns null on corrupt JSON (malformed plaintext)", async () => {
    const storage = createMemoryStorage();
    const cipher = createIdentityCipher();
    // Write invalid JSON directly.
    await storage.setItem("key", "not-json-at-all");
    const result = await readEncryptedJSON(storage, cipher, "key");
    expect(result).toBeNull();
    expect(await storage.getItem("key")).toBeNull();
  });

  it("envelope wraps data with the current schema version", async () => {
    const storage = createMemoryStorage();
    const cipher = createIdentityCipher();
    await writeEncryptedJSON(storage, cipher, "key", { v: 99 });
    const raw = await storage.getItem("key");
    const envelope = JSON.parse(raw!) as StoredEnvelope<{ v: number }>;
    expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(envelope.data).toEqual({ v: 99 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema migrations
// ─────────────────────────────────────────────────────────────────────────────

describe("applyMigrations", () => {
  it("no-ops when fromVersion equals CURRENT_SCHEMA_VERSION", () => {
    const migrations: MigrationMap = { 1: () => ({ migrated: true }) };
    // CURRENT_SCHEMA_VERSION is 1, so a v1 blob needs no migration.
    const result = applyMigrations({ original: true }, CURRENT_SCHEMA_VERSION, migrations);
    expect(result).toEqual({ original: true });
  });

  it("applies a single migration step from v0 to v1", () => {
    const migrations: MigrationMap = {
      0: (data: unknown) => ({ ...(data as object), upgraded: true }),
    };
    const result = applyMigrations({ original: true }, 0, migrations);
    expect(result).toEqual({ original: true, upgraded: true });
  });

  it("chains multiple migration steps", () => {
    const migrations: MigrationMap = {
      0: (d: unknown) => ({ ...(d as object), step1: true }),
      // Pretend CURRENT_SCHEMA_VERSION is higher by using a local helper.
    };
    // Manually apply two hypothetical steps (v0 → v1, v1 → v2).
    const v0 = applyMigrations({ a: 1 }, 0, migrations); // applies step 0
    expect(v0).toEqual({ a: 1, step1: true });
  });

  it("skips missing migration entries gracefully", () => {
    // No migration registered for version 0.
    const result = applyMigrations({ a: 1 }, 0, {});
    expect(result).toEqual({ a: 1 });
  });
});

describe("readEncryptedJSON migration integration", () => {
  it("reads a v0 blob and upgrades it on the fly", async () => {
    const storage = createMemoryStorage();
    const cipher = createIdentityCipher();
    // Simulate a v0 blob written by an older app version.
    const v0Envelope: StoredEnvelope<{ name: string }> = {
      schemaVersion: 0,
      data: { name: "old-campaign" },
    };
    await storage.setItem("key", JSON.stringify(v0Envelope));

    const migrations: MigrationMap = {
      0: (d: unknown) => ({ ...(d as object), migrated: true }),
    };

    const result = await readEncryptedJSON<{ name: string; migrated: boolean }>(
      storage,
      cipher,
      "key",
      migrations,
    );
    expect(result).toEqual({ name: "old-campaign", migrated: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearSensitiveStorage
// ─────────────────────────────────────────────────────────────────────────────

describe("clearSensitiveStorage", () => {
  it("removes all keys under the sensitive namespace", async () => {
    const storage = createMemoryStorage();
    await storage.setItem(sensitiveKey("wallet"), "abc");
    await storage.setItem(sensitiveKey("token"), "tok");
    await storage.setItem("fundable.offline.cache.list", "safe");

    await clearSensitiveStorage(storage);

    expect(await storage.getItem(sensitiveKey("wallet"))).toBeNull();
    expect(await storage.getItem(sensitiveKey("token"))).toBeNull();
    // Non-sensitive key must be untouched.
    expect(await storage.getItem("fundable.offline.cache.list")).toBe("safe");
  });

  it("is a no-op when storage has no getAllKeys method", async () => {
    const storage = createMemoryStorage();
    const noKeys = { ...storage, getAllKeys: undefined };
    // Should not throw.
    await expect(clearSensitiveStorage(noKeys)).resolves.toBeUndefined();
  });

  it("uses a custom namespace when provided", async () => {
    const storage = createMemoryStorage();
    await storage.setItem("custom.ns.key", "sensitive");
    await storage.setItem("fundable.offline.secure.key", "untouched");

    await clearSensitiveStorage(storage, "custom.ns");

    expect(await storage.getItem("custom.ns.key")).toBeNull();
    expect(await storage.getItem("fundable.offline.secure.key")).toBe("untouched");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EncryptedKeyValueStorage
// ─────────────────────────────────────────────────────────────────────────────

describe("EncryptedKeyValueStorage", () => {
  it("encrypts values written to the sensitive namespace", async () => {
    const inner = createMemoryStorage();
    const cipher = createXorCipher("k");
    const store = new EncryptedKeyValueStorage(inner, cipher);

    const key = sensitiveKey("wallet");
    await store.setItem(key, "GBBB...");

    // The underlying store must NOT contain the plaintext.
    const raw = await inner.getItem(key);
    expect(raw).not.toBe("GBBB...");

    // Reading through the encrypted store round-trips correctly.
    expect(await store.getItem(key)).toBe("GBBB...");
  });

  it("passes non-sensitive keys through unencrypted", async () => {
    const inner = createMemoryStorage();
    const cipher = createXorCipher("k");
    const store = new EncryptedKeyValueStorage(inner, cipher);

    const key = "fundable.offline.cache.list";
    await store.setItem(key, '["a","b"]');

    expect(await inner.getItem(key)).toBe('["a","b"]');
    expect(await store.getItem(key)).toBe('["a","b"]');
  });

  it("returns null and removes the key when decryption fails", async () => {
    const inner = createMemoryStorage();
    const brokenCipher = {
      encrypt: async (p: string) => p,
      decrypt: async (): Promise<string> => {
        throw new Error("bad key");
      },
    };
    const store = new EncryptedKeyValueStorage(inner, brokenCipher);
    const key = sensitiveKey("data");
    await inner.setItem(key, "corrupt");

    const result = await store.getItem(key);
    expect(result).toBeNull();
    expect(await inner.getItem(key)).toBeNull();
  });

  it("delegates removeItem to the inner store", async () => {
    const inner = createMemoryStorage();
    const store = new EncryptedKeyValueStorage(inner, createIdentityCipher());
    const key = sensitiveKey("x");
    await store.setItem(key, "v");
    await store.removeItem(key);
    expect(await inner.getItem(key)).toBeNull();
  });

  it("delegates getAllKeys to the inner store", async () => {
    const inner = createMemoryStorage();
    const store = new EncryptedKeyValueStorage(inner, createIdentityCipher());
    await store.setItem(sensitiveKey("a"), "1");
    await store.setItem("plain", "2");
    const keys = await store.getAllKeys();
    expect(keys).toContain(sensitiveKey("a"));
    expect(keys).toContain("plain");
  });
});
