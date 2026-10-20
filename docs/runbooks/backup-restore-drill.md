# Operational Data Isolated Restore Drill Runbook

This operational runbook details the procedures for executing and auditing periodic isolated restore drills of Fundable Protocol operational data stores.

---

## 🎯 Drill Objectives

- Prove the integrity and recoverability of operational data without impacting production traffic.
- Validate that the **RTO SLA (<= 30 minutes)** and **RPO SLA (<= 15 minutes)** are achieved.
- Verify that **AES-256-GCM authenticated encryption** correctly identifies any tampered or corrupted archives.
- Validate 100% SHA-256 manifest matching and JSON structural syntax integrity.

---

## 🛠️ Step-by-Step Drill Execution

### Step 1: Prepare Isolated Quarantine Sandbox
Create a dedicated isolated sandbox path outside production data directories:
```bash
SANDBOX_DIR="/tmp/fundable_restore_drill_$(date +%s)"
mkdir -p "$SANDBOX_DIR"
```

### Step 2: Retrieve Latest Encrypted Backup Archive
Download the latest snapshot archive from backup storage:
```bash
# Example retrieving from S3 bucket:
aws s3 cp s3://fundable-operational-backups/daily/latest.bak.enc "$SANDBOX_DIR/archive.json"
```

### Step 3: Run Automated Programmatic Restore & Integrity Verification
Execute the automated restore service inside the isolated quarantine directory:
```typescript
import { BackupRestoreService } from '@/services/backup-restore.service';
import fs from 'fs/promises';

const service = new BackupRestoreService();
const archiveData = JSON.parse(await fs.readFile(`${SANDBOX_DIR}/archive.json`, 'utf8'));

const drillResult = await service.restoreBackup({
  archive: archiveData,
  passphrase: process.env.BACKUP_PASSPHRASE!,
  isolatedDir: `${SANDBOX_DIR}/restored_data`,
  rtoTargetMs: 30 * 60 * 1000, // 30 minutes
});

console.log('Drill Result Status:', drillResult.status);
console.log('All Checksums Match:', drillResult.allChecksumsMatch);
console.log('Elapsed Duration (ms):', drillResult.elapsedMs);
```

### Step 4: Verify Integrity Checks
1. **Decryption & Auth Tag Check:** GCM auth tag must validate cleanly. Any corrupted or tampered bit returns `DECRYPTION_FAILURE`.
2. **Cryptographic Checksum Verification:** Every file in `archive.manifest.items` must match the SHA-256 hash of the extracted file.
3. **Structural JSON Syntax Validation:** Every `.json` file must parse without syntax errors.

---

## 📋 Drill Sign-Off Report Template

After completing the drill, document results in the compliance record:

```markdown
# Backup Restore Drill Audit Report
- **Date & Time (UTC):** 2026-10-16T14:30:00Z
- **Operator Name:** Noah Akerityo (@maztah1)
- **Drill ID:** drill_1770000000_a1b2c3
- **Backup ID:** bak_1770000000_d4e5f6
- **Algorithm:** AES-256-GCM (PBKDF2-HMAC-SHA256, 100k iterations)
- **Scope Verified:**
  - `webhook_subscriptions.json` (SHA-256 Verified)
  - `webhook_delivered_events.json` (SHA-256 Verified)
  - `webhook_dead_letter.json` (SHA-256 Verified)
  - `deployments/testnet.json` (SHA-256 Verified)
- **Measured Restore Duration:** 342 ms
- **RTO SLA Target (30m):** MET (PASS)
- **RPO SLA Target (15m):** MET (PASS)
- **Tamper Resistance Check:** PASSED (Corrupted archive rejected)
- **Overall Status:** SUCCESS
```

---

## 🤖 Automated Regression Testing

Automated end-to-end regression testing of this drill is enforced in CI:
```bash
pnpm --filter @fundable/web test src/services/backup-restore.service.test.ts
```
