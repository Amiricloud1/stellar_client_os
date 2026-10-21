import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BackupRestoreService } from './backup-restore.service';
import fs from 'fs/promises';
import path from 'path';

describe('Operational Data Backup & Isolated Restore Drill Service', () => {
  const testBaseDir = path.join(process.cwd(), 'scratch', `test_backup_${Date.now()}`);
  const dataDir = path.join(testBaseDir, 'data');
  const isolatedRestoreDir = path.join(testBaseDir, 'restore_sandbox');
  const passphrase = 'SuperSecureDrillPassphrase!2026';

  let service: BackupRestoreService;

  beforeEach(async () => {
    service = new BackupRestoreService();
    await fs.mkdir(dataDir, { recursive: true });

    // Seed mock operational files matching production scope
    await fs.writeFile(
      path.join(dataDir, 'webhook_subscriptions.json'),
      JSON.stringify(
        [
          {
            id: 'sub_test_001',
            url: 'https://subscriber.example.com/events',
            events: ['stream.created', 'tree_verified'],
            secret: 'whsec_secret_123',
            createdAt: '2026-10-01T12:00:00.000Z',
          },
        ],
        null,
        2
      )
    );

    await fs.writeFile(
      path.join(dataDir, 'webhook_delivered_events.json'),
      JSON.stringify(
        {
          delivered: ['stream.created:stream_123', 'tree_verified:verification_456'],
        },
        null,
        2
      )
    );

    await fs.writeFile(
      path.join(dataDir, 'empty_file.json'),
      '{}'
    );
  });

  afterEach(async () => {
    await fs.rm(testBaseDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('createBackup', () => {
    it('creates an AES-256-GCM encrypted backup archive with full manifest', async () => {
      const sourcePaths = [
        path.join(dataDir, 'webhook_subscriptions.json'),
        path.join(dataDir, 'webhook_delivered_events.json'),
      ];

      const archive = await service.createBackup({
        sourcePaths,
        baseDir: testBaseDir,
        passphrase,
        rpoWindowMinutes: 15,
      });

      expect(archive.backupId).toMatch(/^bak_\d+_[a-z0-9-]+$/);
      expect(archive.algorithm).toBe('AES-256-GCM');
      expect(archive.saltHex).toHaveLength(32);
      expect(archive.ivHex).toHaveLength(24);
      expect(archive.authTagHex).toHaveLength(32);
      expect(archive.encryptedDataHex).toBeTruthy();

      expect(archive.manifest.totalFiles).toBe(2);
      expect(archive.manifest.totalBytes).toBeGreaterThan(0);
      expect(archive.manifest.rpoWindowMinutes).toBe(15);
      expect(archive.manifest.items).toHaveLength(2);
      expect(archive.manifest.items[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('gracefully handles missing optional files without failing the backup', async () => {
      const sourcePaths = [
        path.join(dataDir, 'webhook_subscriptions.json'),
        path.join(dataDir, 'non_existent_optional.json'),
      ];

      const archive = await service.createBackup({
        sourcePaths,
        baseDir: testBaseDir,
        passphrase,
      });

      expect(archive.manifest.totalFiles).toBe(1);
    });
  });

  describe('restoreBackup (Isolated Sandbox)', () => {
    it('restores files into isolated directory and passes all integrity checks', async () => {
      const sourcePaths = [
        path.join(dataDir, 'webhook_subscriptions.json'),
        path.join(dataDir, 'webhook_delivered_events.json'),
      ];

      const archive = await service.createBackup({
        sourcePaths,
        baseDir: testBaseDir,
        passphrase,
      });

      const result = await service.restoreBackup({
        archive,
        passphrase,
        isolatedDir: isolatedRestoreDir,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.allChecksumsMatch).toBe(true);
      expect(result.allJsonValid).toBe(true);
      expect(result.rtoSlaMet).toBe(true);
      expect(result.filesProcessed).toBe(2);

      // Verify files actually exist in isolated directory
      const restoredSub = await fs.readFile(
        path.join(isolatedRestoreDir, 'data', 'webhook_subscriptions.json'),
        'utf8'
      );
      const parsed = JSON.parse(restoredSub);
      expect(parsed[0].id).toBe('sub_test_001');
    });

    it('fails decryption immediately when supplied with wrong passphrase', async () => {
      const sourcePaths = [path.join(dataDir, 'webhook_subscriptions.json')];
      const archive = await service.createBackup({
        sourcePaths,
        baseDir: testBaseDir,
        passphrase,
      });

      const result = await service.restoreBackup({
        archive,
        passphrase: 'WrongIncorrectPassphrase123!',
        isolatedDir: isolatedRestoreDir,
      });

      expect(result.status).toBe('DECRYPTION_FAILURE');
      expect(result.allChecksumsMatch).toBe(false);
      expect(result.filesProcessed).toBe(0);
    });

    it('detects tampering and rejects corrupted ciphertext via GCM auth tag', async () => {
      const sourcePaths = [path.join(dataDir, 'webhook_subscriptions.json')];
      const archive = await service.createBackup({
        sourcePaths,
        baseDir: testBaseDir,
        passphrase,
      });

      // Tamper with one character of the ciphertext
      const tamperedHex =
        archive.encryptedDataHex.slice(0, 4) === 'aaaa'
          ? 'bbbb' + archive.encryptedDataHex.slice(4)
          : 'aaaa' + archive.encryptedDataHex.slice(4);

      const tamperedArchive = {
        ...archive,
        encryptedDataHex: tamperedHex,
      };

      const result = await service.restoreBackup({
        archive: tamperedArchive,
        passphrase,
        isolatedDir: isolatedRestoreDir,
      });

      expect(result.status).toBe('DECRYPTION_FAILURE');
    });

    it('detects tampering with authentication tag', async () => {
      const sourcePaths = [path.join(dataDir, 'webhook_subscriptions.json')];
      const archive = await service.createBackup({
        sourcePaths,
        baseDir: testBaseDir,
        passphrase,
      });

      // Tamper with auth tag
      const tamperedTag = archive.authTagHex.split('').reverse().join('');
      const tamperedArchive = {
        ...archive,
        authTagHex: tamperedTag,
      };

      const result = await service.restoreBackup({
        archive: tamperedArchive,
        passphrase,
        isolatedDir: isolatedRestoreDir,
      });

      expect(result.status).toBe('DECRYPTION_FAILURE');
    });
  });

  describe('runRestoreDrill (End-to-End Simulation)', () => {
    it('executes full automated isolated restore drill with integrity checks', async () => {
      const sourcePaths = [
        path.join(dataDir, 'webhook_subscriptions.json'),
        path.join(dataDir, 'webhook_delivered_events.json'),
        path.join(dataDir, 'empty_file.json'),
      ];

      const drillResult = await service.runRestoreDrill(sourcePaths, testBaseDir, passphrase);

      expect(drillResult.status).toBe('SUCCESS');
      expect(drillResult.filesProcessed).toBe(3);
      expect(drillResult.allChecksumsMatch).toBe(true);
      expect(drillResult.allJsonValid).toBe(true);
      expect(drillResult.rtoSlaMet).toBe(true);
      expect(drillResult.elapsedMs).toBeLessThan(30 * 60 * 1000); // Well under 30min RTO
    });
  });
});
