/**
 * Encrypted offline storage with schema versioning.
 *
 * Classifies persisted fields into sensitive vs. non-sensitive categories,
 * wraps any {@link KeyValueStorage} with a pluggable {@link StorageCipher},
 * and handles forward schema migration and corruption recovery.
 *
 * ## Field classification
 *
 * | Field class      | Examples                          | Treatment          |
 * |------------------|-----------------------------------|--------------------|
 * | Sensitive        | wallet address, auth token        | Always encrypted   |
 * | Non-sensitive    | campaign list, wishlist ids       | Stored as-is       |
 *
 * ## Schema versioning
 *
 * Every persisted blob carries a `schemaVersion` integer. `readEncryptedJSON`
 * runs the registered migration chain before returning data, so older blobs
 * are transparently upgraded on first read without a separate migration step.
 *
 * ## Corruption recovery
 *
 * Any failure during decryption or JSON parsing is treated as a corrupt entry:
 * the value is deleted and `null` is returned so the caller can re-fetch.
 *
 * ## Logout / account-switch cleanup
 *
 * `clearSensitiveStorage` removes every key in the sensitive namespace without
 * touching non-sensitive cache keys. Call it on logout.
 */

import { type KeyValueStorage } from "./storage";

// ── Cipher interface ─────────────────────────────────────────────────────────

/**
 * Pluggable cipher injected by the host application.
 *
 * In a real Expo app, use expo-secure-store or a libsodium wrapper. In tests,
 * inject the `createIdentityCipher()` no-op or a deterministic mock.
 *
 * Security note: the cipher **must** use authenticated encryption (e.g.
 * AES-256-GCM or XSalsa20-Poly1305) so that tampered ciphertext is detected
 * before decryption, preventing padding-oracle and bit-flip attacks.
 */
export interface StorageCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** No-op cipher for tests and non-sensitive data paths. */
export function createIdentityCipher(): StorageCipher {
  return {
    async encrypt(plaintext: string): Promise<string> {
      return plaintext;
    },
    async decrypt(ciphertext: string): Promise<string> {
      return ciphertext;
    },
  };
}

/**
 * XOR-based cipher for lightweight in-process testing only.
 * NOT suitable for production — it provides no semantic security.
 */
export function createXorCipher(key: string): StorageCipher {
  const xor = (text: string): string => {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length)!);
    }
    return out;
  };
  // Encode to avoid raw binary chars in storage.
  const toHex = (s: string): string =>
    Array.from(s)
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("");
  const fromHex = (h: string): string => {
    let s = "";
    for (let i = 0; i < h.length; i += 2) {
      s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    }
    return s;
  };
  return {
    async encrypt(plaintext: string): Promise<string> {
      return toHex(xor(plaintext));
    },
    async decrypt(ciphertext: string): Promise<string> {
      return xor(fromHex(ciphertext));
    },
  };
}

// ── Schema migration ─────────────────────────────────────────────────────────

/** Current schema version. Increment when the persisted shape changes. */
export const CURRENT_SCHEMA_VERSION = 1;

export type MigrationFn = (raw: unknown) => unknown;

/**
 * Registry of migrations keyed by the version they upgrade *from*.
 * For example: `{ 1: migrate_v1_to_v2 }` runs when reading a v1 blob.
 */
export type MigrationMap = Record<number, MigrationFn>;

/** Blob envelope stored in the underlying storage. */
export interface StoredEnvelope<T> {
  schemaVersion: number;
  data: T;
}

/**
 * Apply all registered migrations from `fromVersion` up to
 * {@link CURRENT_SCHEMA_VERSION}. Returns the migrated data.
 */
export function applyMigrations(
  data: unknown,
  fromVersion: number,
  migrations: MigrationMap,
): unknown {
  let current = data;
  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const fn = migrations[v];
    if (fn) current = fn(current);
  }
  return current;
}

// ── Encrypted storage helpers ─────────────────────────────────────────────────

/**
 * Write an encrypted, versioned JSON blob to the given `storage` at `key`.
 */
export async function writeEncryptedJSON<T>(
  storage: KeyValueStorage,
  cipher: StorageCipher,
  key: string,
  value: T,
): Promise<void> {
  const envelope: StoredEnvelope<T> = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    data: value,
  };
  const plaintext = JSON.stringify(envelope);
  const ciphertext = await cipher.encrypt(plaintext);
  await storage.setItem(key, ciphertext);
}

/**
 * Read and decrypt a versioned JSON blob from `storage` at `key`.
 *
 * - Returns `null` when the key is absent.
 * - On decryption or parse failure, deletes the corrupt entry and returns
 *   `null` so the caller can re-fetch from the network.
 * - Runs the migration chain if the stored version is older than the current
 *   schema.
 */
export async function readEncryptedJSON<T>(
  storage: KeyValueStorage,
  cipher: StorageCipher,
  key: string,
  migrations: MigrationMap = {},
): Promise<T | null> {
  const raw = await storage.getItem(key);
  if (raw === null || raw === undefined) return null;
  try {
    const plaintext = await cipher.decrypt(raw);
    const envelope = JSON.parse(plaintext) as StoredEnvelope<unknown>;
    const migrated = applyMigrations(
      envelope.data,
      envelope.schemaVersion,
      migrations,
    );
    return migrated as T;
  } catch {
    // Corrupt or tampered: delete the entry to allow clean re-population.
    await storage.removeItem(key).catch(() => undefined);
    return null;
  }
}

// ── Sensitive namespace management ───────────────────────────────────────────

/** Default namespace prefix for sensitive keys. */
export const SENSITIVE_NAMESPACE = "fundable.offline.secure";

/**
 * Remove all keys under the sensitive namespace from `storage`.
 * Call on logout or account switch to prevent data leakage.
 */
export async function clearSensitiveStorage(
  storage: KeyValueStorage,
  namespace: string = SENSITIVE_NAMESPACE,
): Promise<void> {
  if (!storage.getAllKeys) return;
  const prefix = `${namespace}.`;
  const keys = await storage.getAllKeys();
  await Promise.all(
    keys
      .filter((k) => k.startsWith(prefix))
      .map((k) => storage.removeItem(k)),
  );
}

// ── EncryptedKeyValueStorage wrapper ─────────────────────────────────────────

/**
 * Wraps any {@link KeyValueStorage} so every value written under the
 * configured `namespace` is transparently encrypted and decrypted.
 *
 * Keys outside the namespace pass through to the underlying store untouched.
 */
export class EncryptedKeyValueStorage implements KeyValueStorage {
  constructor(
    private readonly inner: KeyValueStorage,
    private readonly cipher: StorageCipher,
    private readonly namespace: string = SENSITIVE_NAMESPACE,
  ) {}

  private isSensitive(key: string): boolean {
    return key.startsWith(`${this.namespace}.`);
  }

  async getItem(key: string): Promise<string | null> {
    const raw = await this.inner.getItem(key);
    if (!this.isSensitive(key) || raw === null) return raw;
    try {
      return await this.cipher.decrypt(raw);
    } catch {
      // Tampered or corrupt — delete and surface null.
      await this.inner.removeItem(key).catch(() => undefined);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!this.isSensitive(key)) {
      await this.inner.setItem(key, value);
      return;
    }
    const encrypted = await this.cipher.encrypt(value);
    await this.inner.setItem(key, encrypted);
  }

  async removeItem(key: string): Promise<void> {
    await this.inner.removeItem(key);
  }

  async getAllKeys(): Promise<readonly string[]> {
    return this.inner.getAllKeys?.() ?? [];
  }
}
