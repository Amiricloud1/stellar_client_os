import fs from 'fs/promises';
import path from 'path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from 'crypto';

export interface BackupManifestItem {
  relativePath: string;
  bytes: number;
  sha256: string;
}

/**
 * A single retained raw event, captured verbatim so projections can be
 * deterministically rebuilt from the event log after a restore.
 */
export interface RetainedRawEvent {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  aggregateId: string;
  sequence: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/**
 * A projection output captured at backup time. Used as the reference output
 * that a post-restore replay must reproduce exactly before cutover.
 */
export interface ProjectionSnapshot {
  projectionName: string;
  schemaVersion: string;
  state: Record<string, unknown>;
  lastEventSequence: number;
  /** Authoritative Stellar ledger sequence represented by this projection. */
  ledgerSequence?: number;
}

export interface AuthoritativeLedgerSnapshot {
  ledgerSequence: number;
  state: Record<string, unknown>;
}

export interface AuthoritativeLedgerReader {
  readProjectionAtLedger(
    projectionName: string,
    ledgerSequence: number
  ): Promise<AuthoritativeLedgerSnapshot>;
}

export interface ReplayVerificationResult {
  projectionName: string;
  schemaVersion: string;
  deterministic: boolean;
  replayedState: Record<string, unknown>;
  expectedState: Record<string, unknown>;
  eventsReplayed: number;
  mismatchPaths: string[];
  error?: string;
}

export interface LedgerReconciliationResult {
  projectionName: string;
  ledgerSequence?: number;
  status: "MATCHED" | "MISMATCH" | "UNAVAILABLE";
  mismatchPaths: string[];
  error?: string;
}

export interface BackupManifest {
  backupId: string;
  version: string;
  createdAt: string;
  rpoWindowMinutes: number;
  totalFiles: number;
  totalBytes: number;
  items: BackupManifestItem[];
}

export interface EncryptedBackupArchive {
  backupId: string;
  version: string;
  algorithm: 'AES-256-GCM';
  saltHex: string;
  ivHex: string;
  authTagHex: string;
  encryptedDataHex: string;
  manifest: BackupManifest;
}

export interface RestoreFileCheck {
  relativePath: string;
  bytes: number;
  sha256Match: boolean;
  jsonSyntaxValid: boolean;
  status: 'VERIFIED' | 'CORRUPT' | 'FAILED';
  error?: string;
}

export interface RestoreDrillResult {
  drillId: string;
  backupId: string;
  isolatedDir: string;
  filesProcessed: number;
  totalBytesRestored: number;
  allChecksumsMatch: boolean;
  allJsonValid: boolean;
  elapsedMs: number;
  rtoTargetMs: number;
  rtoSlaMet: boolean;
  rpoAgeMs: number;
  rpoTargetMs: number;
  rpoSlaMet: boolean;
  fileChecks: RestoreFileCheck[];
  status:
    | 'SUCCESS'
    | 'INTEGRITY_FAILURE'
    | 'DECRYPTION_FAILURE'
    | 'LEDGER_RECONCILIATION_FAILURE'
    | 'RECOVERY_OBJECTIVE_FAILURE'
    | 'ERROR';
  replayVerifications: ReplayVerificationResult[];
  allReplaysDeterministic: boolean;
  ledgerReconciliations: LedgerReconciliationResult[];
  allLedgerReconciled: boolean;
}

export interface CreateBackupOptions {
  sourcePaths: string[];
  baseDir: string;
  passphrase: string;
  rpoWindowMinutes?: number;
  /** Retained raw events used to rebuild projections deterministically. */
  rawEvents?: RetainedRawEvent[];
  /** Projection outputs captured at backup time, used as replay reference. */
  projectionSnapshots?: ProjectionSnapshot[];
}

export interface RestoreOptions {
  archive: EncryptedBackupArchive;
  passphrase: string;
  isolatedDir: string;
  rtoTargetMs?: number;
  ledgerReader?: AuthoritativeLedgerReader;
  now?: () => number;
}

const PBKDF2_ITERATIONS = 100_000;
const KEY_LEN = 32; // 256 bits

/**
 * Deterministic projection reducer. Given a projection name and the ordered
 * raw events, produces the projection state. Must be pure and version-stable
 * so replays across event-schema versions are reproducible.
 */
export type ProjectionReducer = (
  projectionName: string,
  events: RetainedRawEvent[]
) => Record<string, unknown>;

/**
 * Default reducer: folds events into a per-aggregate sequence map. This is
 * intentionally simple and deterministic; callers may supply a richer reducer.
 */
const defaultProjectionReducer: ProjectionReducer = (_projectionName, events) => {
  const state: Record<string, unknown> = {};
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const event of sorted) {
    const key = event.aggregateId;
    const existing = (state[key] as { lastSequence?: number; eventCount?: number }) || {};
    state[key] = {
      lastSequence: event.sequence,
      eventCount: (existing.eventCount ?? 0) + 1,
    };
  }
  return state;
};

/**
 * Recursively collects dotted paths where two JSON-like values differ.
 */
function collectMismatchPaths(
  expected: unknown,
  actual: unknown,
  prefix: string,
  out: string[]
): void {
  if (expected === actual) return;
  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object';
  if (!bothObjects) {
    out.push(prefix || '<root>');
    return;
  }
  const expObj = expected as Record<string, unknown>;
  const actObj = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(expObj), ...Object.keys(actObj)]);
  for (const key of keys) {
    collectMismatchPaths(expObj[key], actObj[key], prefix ? `${prefix}.${key}` : key, out);
  }
}

/**
 * Stable JSON serialization used for deterministic comparison.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Derives a 256-bit encryption key from a passphrase and salt using PBKDF2-HMAC-SHA256.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

/**
 * Computes SHA-256 hash of a Buffer.
 */
function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export class BackupRestoreService {
  /**
   * Creates an encrypted backup bundle with cryptographic checksums and manifest.
   */
  async createBackup(options: CreateBackupOptions): Promise<EncryptedBackupArchive> {
    const {
      sourcePaths,
      baseDir,
      passphrase,
      rpoWindowMinutes = 15,
      rawEvents = [],
      projectionSnapshots = [],
    } = options;
    const backupId = `bak_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const items: BackupManifestItem[] = [];
    const filesToArchive: Record<string, string> = {}; // relativePath -> base64 content
    let totalBytes = 0;

    for (const filePath of sourcePaths) {
      try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
        const data = await fs.readFile(fullPath);
        const relative = path.relative(baseDir, fullPath);
        const hash = sha256(data);

        items.push({
          relativePath: relative,
          bytes: data.length,
          sha256: hash,
        });

        filesToArchive[relative] = data.toString('base64');
        totalBytes += data.length;
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== 'ENOENT') {
          throw err;
        }
        // Gracefully ignore missing optional files
      }
    }

    const manifest: BackupManifest = {
      backupId,
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      rpoWindowMinutes,
      totalFiles: items.length,
      totalBytes,
      items,
    };

    // Encrypt payload using AES-256-GCM
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = deriveKey(passphrase, salt);

    const plaintext = JSON.stringify({
      manifest,
      files: filesToArchive,
      rawEvents,
      projectionSnapshots,
    });

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
      backupId,
      version: '1.0.0',
      algorithm: 'AES-256-GCM',
      saltHex: salt.toString('hex'),
      ivHex: iv.toString('hex'),
      authTagHex: authTag.toString('hex'),
      encryptedDataHex: encrypted,
      manifest,
    };
  }

  /**
   * Restores an encrypted backup archive into a quarantined, isolated directory
   * and verifies cryptographic checksums and structural JSON syntax.
   */
  async restoreBackup(options: RestoreOptions): Promise<RestoreDrillResult> {
    const start = performance.now();
    const {
      archive,
      passphrase,
      isolatedDir,
      rtoTargetMs = 30 * 60 * 1000, // 30 min RTO target
    } = options;
    const now = options.now ?? Date.now;
    const restoreStartedAt = now();
    let rpoTargetMs = 0;
    let rpoAgeMs = Number.MAX_SAFE_INTEGER;
    let rpoSlaMet = false;

    const drillId = `drill_${restoreStartedAt}_${randomUUID().slice(0, 8)}`;
    await fs.mkdir(isolatedDir, { recursive: true });

    let archiveMetadataMismatch = false;
    let decryptedPayload: {
      manifest: BackupManifest;
      files: Record<string, string>;
      rawEvents?: RetainedRawEvent[];
      projectionSnapshots?: ProjectionSnapshot[];
    };

    try {
      const salt = Buffer.from(archive.saltHex, 'hex');
      const iv = Buffer.from(archive.ivHex, 'hex');
      const authTag = Buffer.from(archive.authTagHex, 'hex');
      const key = deriveKey(passphrase, salt);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(archive.encryptedDataHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      decryptedPayload = JSON.parse(decrypted);
      if (
        archive.backupId !== decryptedPayload.manifest?.backupId ||
        stableStringify(archive.manifest) !== stableStringify(decryptedPayload.manifest)
      ) {
        archiveMetadataMismatch = true;
        throw new Error("Unencrypted archive metadata does not match authenticated metadata");
      }

      const { createdAt, rpoWindowMinutes } = decryptedPayload.manifest;
      const archivedAt = Date.parse(createdAt);
      rpoTargetMs =
        Number.isFinite(rpoWindowMinutes) && rpoWindowMinutes > 0
          ? rpoWindowMinutes * 60 * 1000
          : 0;
      rpoAgeMs =
        Number.isFinite(archivedAt) && archivedAt <= restoreStartedAt
          ? restoreStartedAt - archivedAt
          : Number.MAX_SAFE_INTEGER;
      rpoSlaMet =
        Number.isFinite(rpoTargetMs) && rpoTargetMs > 0 && rpoAgeMs <= rpoTargetMs;
    } catch (err: unknown) {
      const elapsedMs = Number((performance.now() - start).toFixed(2));
      return {
        drillId,
        backupId: archive.backupId,
        isolatedDir,
        filesProcessed: 0,
        totalBytesRestored: 0,
        allChecksumsMatch: false,
        allJsonValid: false,
        elapsedMs,
        rtoTargetMs,
        rtoSlaMet: elapsedMs <= rtoTargetMs,
        rpoAgeMs,
        rpoTargetMs,
        rpoSlaMet,
        fileChecks: [],
        status: archiveMetadataMismatch ? 'INTEGRITY_FAILURE' : 'DECRYPTION_FAILURE',
        replayVerifications: [],
        allReplaysDeterministic: false,
        ledgerReconciliations: [],
        allLedgerReconciled: false,
      };
    }

    const { manifest, files, rawEvents = [], projectionSnapshots = [] } = decryptedPayload;
    const fileChecks: RestoreFileCheck[] = [];
    let totalRestoredBytes = 0;
    let allChecksumsMatch = true;
    let allJsonValid = true;

    for (const item of manifest.items) {
      const b64 = files[item.relativePath];
      if (b64 === undefined) {
        fileChecks.push({
          relativePath: item.relativePath,
          bytes: 0,
          sha256Match: false,
          jsonSyntaxValid: false,
          status: 'FAILED',
          error: 'File missing from decrypted payload',
        });
        allChecksumsMatch = false;
        continue;
      }

      const fileData = Buffer.from(b64, 'base64');
      const actualHash = sha256(fileData);
      const hashMatches = actualHash === item.sha256;
      if (!hashMatches) allChecksumsMatch = false;

      // Verify JSON syntax integrity if file is .json
      let jsonValid = true;
      let jsonError: string | undefined = undefined;
      if (item.relativePath.endsWith('.json')) {
        try {
          JSON.parse(fileData.toString('utf8'));
        } catch (jsonErr: unknown) {
          jsonValid = false;
          allJsonValid = false;
          jsonError = (jsonErr as Error).message;
        }
      }

      // Write to isolated target directory
      const targetRoot = path.resolve(isolatedDir);
      const targetFilePath = path.resolve(targetRoot, item.relativePath);
      if (!targetFilePath.startsWith(`${targetRoot}${path.sep}`)) {
        fileChecks.push({
          relativePath: item.relativePath,
          bytes: 0,
          sha256Match: false,
          jsonSyntaxValid: false,
          status: 'FAILED',
          error: 'Archive path escapes the isolated restore directory',
        });
        allChecksumsMatch = false;
        allJsonValid = false;
        continue;
      }
      await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
      await fs.writeFile(targetFilePath, fileData);

      totalRestoredBytes += fileData.length;
      fileChecks.push({
        relativePath: item.relativePath,
        bytes: fileData.length,
        sha256Match: hashMatches,
        jsonSyntaxValid: jsonValid,
        status: hashMatches && jsonValid ? 'VERIFIED' : 'CORRUPT',
        error: jsonError,
      });
    }

    // Replay retained raw events to rebuild projections and compare against
    // the captured reference snapshots before cutover.
    const replayVerifications = this.replayProjections(rawEvents, projectionSnapshots);
    const allReplaysDeterministic = replayVerifications.every((r) => r.deterministic);
    const ledgerReconciliations = await this.reconcileProjections(
      projectionSnapshots,
      options.ledgerReader
    );
    const allLedgerReconciled = ledgerReconciliations.every(
      (result) => result.status === "MATCHED"
    );

    const elapsedMs = Number((performance.now() - start).toFixed(2));
    const rtoSlaMet = elapsedMs <= rtoTargetMs;
    const overallSuccess =
      allChecksumsMatch &&
      allJsonValid &&
      allReplaysDeterministic &&
      allLedgerReconciled &&
      rtoSlaMet &&
      rpoSlaMet;
    const status = overallSuccess
      ? "SUCCESS"
      : !allLedgerReconciled
        ? "LEDGER_RECONCILIATION_FAILURE"
        : !rtoSlaMet || !rpoSlaMet
          ? "RECOVERY_OBJECTIVE_FAILURE"
          : "INTEGRITY_FAILURE";

    return {
      drillId,
      backupId: archive.backupId,
      isolatedDir,
      filesProcessed: fileChecks.length,
      totalBytesRestored: totalRestoredBytes,
      allChecksumsMatch,
      allJsonValid,
      elapsedMs,
      rtoTargetMs,
      rtoSlaMet,
      rpoAgeMs,
      rpoTargetMs,
      rpoSlaMet,
      fileChecks,
      status,
      replayVerifications,
      allReplaysDeterministic,
      ledgerReconciliations,
      allLedgerReconciled,
    };
  }

  private async reconcileProjections(
    snapshots: ProjectionSnapshot[],
    ledgerReader?: AuthoritativeLedgerReader
  ): Promise<LedgerReconciliationResult[]> {
    return Promise.all(
      snapshots.map(async (snapshot): Promise<LedgerReconciliationResult> => {
        if (!ledgerReader || snapshot.ledgerSequence === undefined) {
          return {
            projectionName: snapshot.projectionName,
            ledgerSequence: snapshot.ledgerSequence,
            status: "UNAVAILABLE",
            mismatchPaths: [],
            error: !ledgerReader
              ? "No authoritative ledger reader is configured"
              : "Projection snapshot has no ledger sequence",
          };
        }

        try {
          const authoritative = await ledgerReader.readProjectionAtLedger(
            snapshot.projectionName,
            snapshot.ledgerSequence
          );
          const ledgerMatches = authoritative.ledgerSequence === snapshot.ledgerSequence;
          const mismatchPaths: string[] = [];
          if (!ledgerMatches) mismatchPaths.push("ledgerSequence");
          if (stableStringify(snapshot.state) !== stableStringify(authoritative.state)) {
            collectMismatchPaths(
              snapshot.state,
              authoritative.state,
              "",
              mismatchPaths
            );
          }
          return {
            projectionName: snapshot.projectionName,
            ledgerSequence: snapshot.ledgerSequence,
            status: mismatchPaths.length === 0 ? "MATCHED" : "MISMATCH",
            mismatchPaths,
            error: ledgerMatches ? undefined : "Ledger reader returned a different sequence",
          };
        } catch (error) {
          return {
            projectionName: snapshot.projectionName,
            ledgerSequence: snapshot.ledgerSequence,
            status: "UNAVAILABLE",
            mismatchPaths: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );
  }

  /**
   * Deterministically replays retained raw events to rebuild each projection and
   * compares the result against the captured reference snapshot. A projection is
   * deterministic only when the replayed state matches the expected state exactly.
   */
  replayProjections(
    rawEvents: RetainedRawEvent[],
    projectionSnapshots: ProjectionSnapshot[],
    reducer: ProjectionReducer = defaultProjectionReducer
  ): ReplayVerificationResult[] {
    return projectionSnapshots.map((snapshot) => {
      try {
        const replayedState = reducer(snapshot.projectionName, rawEvents);
        const deterministic =
          stableStringify(replayedState) === stableStringify(snapshot.state);
        const mismatchPaths: string[] = [];
        if (!deterministic) {
          collectMismatchPaths(snapshot.state, replayedState, '', mismatchPaths);
        }
        return {
          projectionName: snapshot.projectionName,
          schemaVersion: snapshot.schemaVersion,
          deterministic,
          replayedState,
          expectedState: snapshot.state,
          eventsReplayed: rawEvents.length,
          mismatchPaths,
        };
      } catch (err: unknown) {
        return {
          projectionName: snapshot.projectionName,
          schemaVersion: snapshot.schemaVersion,
          deterministic: false,
          replayedState: {},
          expectedState: snapshot.state,
          eventsReplayed: 0,
          mismatchPaths: [],
          error: (err as Error).message,
        };
      }
    });
  }

  /**
   * Runs an automated end-to-end restore drill against live files in an isolated temporary sandbox.
   */
  async runRestoreDrill(
    sourcePaths: string[],
    baseDir: string,
    passphrase: string = 'DrillPassphrase2026!Secure',
    sandboxDir?: string,
    replayInputs?: {
      rawEvents?: RetainedRawEvent[];
      projectionSnapshots?: ProjectionSnapshot[];
      ledgerReader?: AuthoritativeLedgerReader;
    }
  ): Promise<RestoreDrillResult> {
    const isolatedDir =
      sandboxDir || path.join(baseDir, 'scratch', `restore_drill_${Date.now()}_${randomUUID().slice(0, 6)}`);

    try {
      const archive = await this.createBackup({
        sourcePaths,
        baseDir,
        passphrase,
        rawEvents: replayInputs?.rawEvents,
        projectionSnapshots: replayInputs?.projectionSnapshots,
      });

      return await this.restoreBackup({
        archive,
        passphrase,
        isolatedDir,
        ledgerReader: replayInputs?.ledgerReader,
      });
    } finally {
      // Ensure isolated drill sandbox is cleaned up if created automatically
      if (!sandboxDir) {
        await fs.rm(isolatedDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
