# Operational Data Backup & Restore Policy

This policy document establishes the data backup scope, cryptographic encryption standards, retention schedules, and Recovery Point / Recovery Time Objectives (RPO/RTO) for Fundable Protocol's operational data stores.

---

## 📦 1. Backup Scope Matrix

| Data Asset | Location | Storage Type | Criticality | Backup Method | Frequency |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Webhook Subscriptions** | `apps/web/data/webhook_subscriptions.json` | JSON File Store | High | Encrypted Snapshot | Every 15 min |
| **Webhook Deduplication Log** | `apps/web/data/webhook_delivered_events.json` | JSON File Store | High | Encrypted Snapshot | Every 15 min |
| **Webhook Dead-Letter Queue** | `apps/web/data/webhook_dead_letter.json` | JSON File Store | Medium | Encrypted Snapshot | Every 1 hour |
| **Deployment Registries** | `deployments/*.json` | JSON File Store | Critical | Git Versioned + Backup | Daily / On-Deploy |
| **Campaign & Verification Stores** | `apps/web/data/campaigns.json` | JSON File Store | High | Encrypted Snapshot | Every 15 min |
| **Operational Rate Limits & Cache** | Redis Cluster | Key-Value / Memory | Medium | Redis RDB Snapshot | Daily |
| **Smart Contract & On-Chain State** | Stellar Blockchain | Distributed Ledger | Inherent | Horizon Ledger Replay | Continuous (RPO = 0) |

> [!NOTE]
> On-chain smart contract states (payment streams, distributions, Soroban storage) are inherently preserved across the decentralized Stellar network. On-chain history is reconstructed via Horizon/RPC transaction replay and does not require local disk backups.

---

## 🔐 2. Cryptographic Encryption Standards

All operational data backups are protected in transit and at rest using authenticated symmetric encryption:

- **Encryption Algorithm:** **AES-256-GCM** (Galois/Counter Mode).
- **Key Derivation Function (KDF):** **PBKDF2-HMAC-SHA256** with:
  - 100,000 hash iterations.
  - 16-byte cryptographically secure random salt generated per backup archive.
  - 256-bit derived key.
- **Initialization Vector (IV):** 12-byte random IV per archive.
- **Authentication Tag:** 16-byte GCM authentication tag validating ciphertext integrity and preventing tampering or unauthorized modification.
- **Cryptographic File Checksums:** SHA-256 hash computed for every individual file in the backup manifest.

---

## 🗓️ 3. Retention Schedule (Grandfather-Father-Son)

Backups follow a tiered grandfather-father-son retention lifecycle:

| Tier | Frequency | Retention Duration | Target Destination |
| :--- | :--- | :--- | :--- |
| **Daily** | Every 24 hours | **7 Days** | S3 Standard Storage (Encrypted) |
| **Weekly** | Every Sunday 00:00 UTC | **4 Weeks** | S3 Standard Storage (Encrypted) |
| **Monthly** | 1st of every month | **12 Months** | S3 Glacier Flexible / WORM Vault |

Archives older than their retention window are automatically pruned via cloud object lifecycle rules.

---

## ⏱️ 4. Recovery Objectives (RPO & RTO)

| Metric | Target | Description |
| :--- | :--- | :--- |
| **RPO (Recovery Point Objective)** | **<= 15 Minutes** | Maximum acceptable data loss period for off-chain operational metadata in disaster recovery scenarios. (RPO = 0 for on-chain state). |
| **RTO (Recovery Time Objective)** | **<= 30 Minutes** | Maximum acceptable time from disaster declaration to full isolated restoration and health verification. |

---

## 🧪 5. Isolated Restore Drill Mandate

- **Frequency:** Quarterly (at minimum) and following any major storage schema migration.
- **Requirement:** Must execute in a quarantined sandbox directory without impacting live operational stores or interrupting active API traffic.
- **Integrity Validation:** Every restored file must undergo 100% SHA-256 manifest comparison and JSON structural syntax verification.
- **Execution Guide:** Refer to [`docs/runbooks/backup-restore-drill.md`](./runbooks/backup-restore-drill.md).
