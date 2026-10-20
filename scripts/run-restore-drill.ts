#!/usr/bin/env node

/**
 * Operational Data Isolated Restore Drill Runner
 *
 * Runs an isolated restore drill of operational data (webhook subscriptions,
 * deduplication log, dead letters, deployment registries) and validates
 * cryptographic SHA-256 integrity and JSON structural syntax against RTO targets.
 */

import path from 'path';
import { BackupRestoreService } from '../apps/web/src/services/backup-restore.service';

async function main() {
  console.log('================================================================');
  console.log('   Fundable Protocol: Operational Data Isolated Restore Drill   ');
  console.log('================================================================\n');

  const rootDir = path.resolve(__dirname, '..');
  const service = new BackupRestoreService();

  const sourcePaths = [
    'apps/web/data/webhook_subscriptions.json',
    'apps/web/data/webhook_delivered_events.json',
    'apps/web/data/webhook_dead_letter.json',
    'deployments/testnet.json',
  ];

  const passphrase = process.env.BACKUP_PASSPHRASE || 'DrillPassphrase2026!Default';
  console.log('Starting automated drill against operational data scope:');
  for (const p of sourcePaths) {
    console.log(` - ${p}`);
  }
  console.log('');

  const result = await service.runRestoreDrill(sourcePaths, rootDir, passphrase);

  console.log('---------------- Drill Results ----------------');
  console.log(`Drill ID:            ${result.drillId}`);
  console.log(`Backup ID:           ${result.backupId}`);
  console.log(`Status:              ${result.status}`);
  console.log(`Files Processed:     ${result.filesProcessed}`);
  console.log(`Total Bytes:         ${result.totalBytesRestored}`);
  console.log(`Checksums Match:     ${result.allChecksumsMatch ? 'PASS (100%)' : 'FAIL'}`);
  console.log(`JSON Syntax Valid:   ${result.allJsonValid ? 'PASS (100%)' : 'FAIL'}`);
  console.log(`Elapsed Duration:    ${result.elapsedMs} ms`);
  console.log(`RTO Target (30m):    ${result.rtoTargetMs} ms`);
  console.log(`RTO SLA Met:         ${result.rtoSlaMet ? 'YES' : 'NO'}`);
  console.log('------------------------------------------------\n');

  if (result.status !== 'SUCCESS') {
    console.error('❌ Restore drill failed integrity validation!');
    process.exit(1);
  }

  console.log('✅ Isolated restore drill completed successfully and verified.\n');
}

main().catch((err) => {
  console.error('Fatal error running restore drill:', err);
  process.exit(1);
});
