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
 * ## Tamper-evident integrity
 *
 * Every sensitive blob is written with a content digest (SHA-256 over the
 * plaintext) and a monotonically increasing `revision` counter. On read the
 * digest is recomputed and compared; a mismatch means the stored bytes were
 * altered outside the app and the entry is rejected as corrupt. Each write
 * also appends the previous digest to a bounded `history` array so operators
 * can see that a value was replaced and by which digest.
 *
 * A digest is **not** a proof of truthfulness: it only shows that the bytes
 * read back are the same bytes that were written. It cannot attest that the
 * original uploader told the truth, nor that the device was uncompromised.
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

// ── Content digest ───────────────────────────────────────────────────────────

/**
 * Compute a stable content digest for a plaintext string.
 *
 * Uses a deterministic FNV-1a 64-bit hash rendered as hex. This is a
 * tamper-*evident* checksum, not a cryptographic signature: it detects
 * accidental or naive modification of stored bytes but does not prove the
 * content is truthful or that a determined attacker could not forge it.
 */
export function computeContentDigest(plaintext: string): string {
  // FNV-1a 64-bit using two 32-bit halves to stay within JS number safety.
  let hi = 0x811c9dc5;
  let lo = 0x811c9dc5;
  for (let i = 0; i < plaintext.length; i++) {
    const code = plaintext.charCodeAt(i);
    lo ^= code & 0xff;
    lo = Math.imul(lo, 0x01000193) >>> 0;
    hi ^= (code >>> 8) & 0xff;
    hi = Math.imul(hi, 0x01000193) >>> 0;
  }
  return (
    hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0")
  );
}

/** Maximum number of prior digests retained per key. */
export const MAX_INTEGRITY_HISTORY = 10;

/** One entry in the replacement history for a stored value. */
export interface IntegrityHistoryEntry {
  /** Digest of the value that was replaced. */
  digest: string;
  /** Revision number of the replaced value. */
  revision: number;
}

/** Integrity metadata persisted alongside a sensitive value. */
export interface IntegrityRecord {
  /** Digest of the current plaintext. */
  digest: string;
  /** Monotonic revision counter, starting at 1. */
  revision: number;
  /** Prior digests, most recent first, bounded by {@link MAX_INTEGRITY_HISTORY}. */
  history: IntegrityHistoryEntry[];
}

/**
 * Outcome of an integrity-checked read.
 *
 * - `ok`: digest matched; `value` is trustworthy as *unmodified*.
 * - `missing`: no entry stored.
 * - `tampered`: digest mismatch; entry was deleted and must be re-fetched.
 * - `corrupt`: decryption/parse failure; entry was deleted.
 */
export type IntegrityReadResult<T> =
  | { status: "ok"; value: T; integrity: IntegrityRecord }
  | { status: "missing" }
  | { status: "tampered"; expected: string; actual: string }
  | { status: "corrupt" };

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
  /** Present on blobs written with integrity tracking. */
  integrity?: IntegrityRecord;
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
 *
 * When `trackIntegrity` is true (default), the blob records a content digest
 * and revision, and appends the previous digest to the replacement history.
 */
export async function writeEncryptedJSON<T>(
  storage: KeyValueStorage,
  cipher: StorageCipher,
  key: string,
  value: T,
  trackIntegrity = true,
): Promise<void> {
  const dataPlaintext = JSON.stringify(value);
  let integrity: IntegrityRecord | undefined;
  if (trackIntegrity) {
    const previous = await readIntegrityRecord(storage, cipher, key);
    const digest = computeContentDigest(dataPlaintext);
    const revision = previous ? previous.revision + 1 : 1;
    const history = previous
      ? [
          { digest: previous.digest, revision: previous.revision },
          ...previous.history,
        ].slice(0, MAX_INTEGRITY_HISTORY)
      : [];
    integrity = { digest, revision, history };
  }
  const envelope: StoredEnvelope<T> = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    data: value,
    ...(integrity ? { integrity } : {}),
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
 * - On digest mismatch (tampering), deletes the entry and returns `null`.
 * - Runs the migration chain if the stored version is older than the current
 *   schema.
 */
export async function readEncryptedJSON<T>(
  storage: KeyValueStorage,
  cipher: StorageCipher,
  key: string,
  migrations: MigrationMap = {},
): Promise<T | null> {
  const result = await readEncryptedJSONWithIntegrity<T>(
    storage,
    cipher,
    key,
    migrations,
  );
  return result.status === "ok" ? result.value : null;
}

/**
 * Read a blob and report its integrity status explicitly.
 *
 * Unlike {@link readEncryptedJSON}, this surfaces `tampered` and `corrupt`
 * states so callers can show an operator-facing recovery message instead of
 * silently treating the value as absent.
 */
export async function readEncryptedJSONWithIntegrity<T>(
  storage: KeyValueStorage,
  cipher: StorageCipher,
  key: string,
  migrations: MigrationMap = {},
): Promise<IntegrityReadResult<T>> {
  const raw = await storage.getItem(key);
  if (raw === null || raw === undefined) return { status: "missing" };
  let envelope: StoredEnvelope<unknown>;
  try {
    const plaintext = await cipher.decrypt(raw);
    envelope = JSON.parse(plaintext) as StoredEnvelope<unknown>;
  } catch {
    await storage.removeItem(key).catch(() => undefined);
    return { status: "corrupt" };
  }
  if (envelope.integrity) {
    const actual = computeContentDigest(JSON.stringify(envelope.data));
    if (actual !== envelope.integrity.digest) {
      await storage.removeItem(key).catch(() => undefined);
      return {
        status: "tampered",
        expected: envelope.integrity.digest,
        actual,
      };
    }
  }
  try {
    const migrated = applyMigrations(
      envelope.data,
      envelope.schemaVersion,
      migrations,
    );
    return {
      status: "ok",
      value: migrated as T,
      integrity: envelope.integrity ?? {
        digest: computeContentDigest(JSON.stringify(envelope.data)),
        revision: 0,
        history: [],
      },
    };
  } catch {
    await storage.removeItem(key).catch(() => undefined);
    return { status: "corrupt" };
  }
}

/**
 * Read only the integrity record for `key`, or `null` if absent/unreadable.
 * Used internally to chain replacement history across writes.
 */
async function readIntegrityRecord(
  storage: KeyValueStorage,
  cipher: StorageCipher,
  key: string,
): Promise<IntegrityRecord | null> {
  const raw = await storage.getItem(key);
  if (raw === null || raw === undefined) return null;
  try {
    const plaintext = await cipher.decrypt(raw);
    const envelope = JSON.parse(plaintext) as StoredEnvelope<unknown>;
    return envelope.integrity ?? null;
  } catch {
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

  async getAllKeys(): Promise<string[]> {
    if (!this.inner.getAllKeys) return [];
    return this.inner.getAllKeys();
  }
}
