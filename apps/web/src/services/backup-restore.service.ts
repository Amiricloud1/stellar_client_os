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
  fileChecks: RestoreFileCheck[];
  status: 'SUCCESS' | 'INTEGRITY_FAILURE' | 'DECRYPTION_FAILURE' | 'ERROR';
}

export interface CreateBackupOptions {
  sourcePaths: string[];
  baseDir: string;
  passphrase: string;
  rpoWindowMinutes?: number;
}

export interface RestoreOptions {
  archive: EncryptedBackupArchive;
  passphrase: string;
  isolatedDir: string;
  rtoTargetMs?: number;
}

const PBKDF2_ITERATIONS = 100_000;
const KEY_LEN = 32; // 256 bits

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
    const { sourcePaths, baseDir, passphrase, rpoWindowMinutes = 15 } = options;
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

    const drillId = `drill_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await fs.mkdir(isolatedDir, { recursive: true });

    let decryptedPayload: { manifest: BackupManifest; files: Record<string, string> };

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
        fileChecks: [],
        status: 'DECRYPTION_FAILURE',
      };
    }

    const { manifest, files } = decryptedPayload;
    const fileChecks: RestoreFileCheck[] = [];
    let totalRestoredBytes = 0;
    let allChecksumsMatch = true;
    let allJsonValid = true;

    for (const item of manifest.items) {
      const b64 = files[item.relativePath];
      if (!b64) {
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
      const targetFilePath = path.join(isolatedDir, item.relativePath);
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

    const elapsedMs = Number((performance.now() - start).toFixed(2));
    const rtoSlaMet = elapsedMs <= rtoTargetMs;
    const overallSuccess = allChecksumsMatch && allJsonValid;

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
      fileChecks,
      status: overallSuccess ? 'SUCCESS' : 'INTEGRITY_FAILURE',
    };
  }

  /**
   * Runs an automated end-to-end restore drill against live files in an isolated temporary sandbox.
   */
  async runRestoreDrill(
    sourcePaths: string[],
    baseDir: string,
    passphrase: string = 'DrillPassphrase2026!Secure',
    sandboxDir?: string
  ): Promise<RestoreDrillResult> {
    const isolatedDir =
      sandboxDir || path.join(baseDir, 'scratch', `restore_drill_${Date.now()}_${randomUUID().slice(0, 6)}`);

    try {
      const archive = await this.createBackup({
        sourcePaths,
        baseDir,
        passphrase,
      });

      return await this.restoreBackup({
        archive,
        passphrase,
        isolatedDir,
      });
    } finally {
      // Ensure isolated drill sandbox is cleaned up if created automatically
      if (!sandboxDir) {
        await fs.rm(isolatedDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
