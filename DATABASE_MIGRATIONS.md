# Database Migrations for Four Critical Issues

This document provides SQL migrations needed to support the four critical fixes.

## Issue #1: Stable Compound Cursors Migration

### Migration: 001_extend_cdc_cursors_for_compound_keys.sql

This migration extends the `cdc_cursors` table to support compound cursor tracking.

```sql
-- Migration: 001_extend_cdc_cursors_for_compound_keys.sql
-- Date: 2025-01-19
-- Purpose: Add compound cursor columns for stable event deduplication (Issue #1)

-- Step 1: Add new columns to cdc_cursors table
ALTER TABLE cdc_cursors
ADD COLUMN IF NOT EXISTS last_tx_hash TEXT,
ADD COLUMN IF NOT EXISTS last_event_index BIGINT,
ADD COLUMN IF NOT EXISTS last_timestamp TIMESTAMPTZ;

-- Step 2: Update existing cursors (safe default: NULL allows restart from lookback)
-- No data update needed; NULL values are safe and mean "first run"

-- Step 3: Add composite index on stream_events for tiebreaker ordering
CREATE INDEX IF NOT EXISTS idx_stream_events_compound_key
  ON stream_events (ledger_sequence, tx_hash, CAST(
    -- Extract eventIndex from eventId (format: ledger-txHash-eventIndex)
    SUBSTRING(event_id, POSITION('-' IN SUBSTRING(event_id, POSITION('-' IN event_id) + 1)) + POSITION('-' IN event_id)) 
    AS BIGINT));

-- Step 4: Verify index was created
-- SELECT * FROM pg_indexes WHERE tablename = 'stream_events' AND indexname LIKE 'idx_stream_events%';

-- Rollback (if needed):
-- ALTER TABLE cdc_cursors DROP COLUMN IF EXISTS last_tx_hash;
-- ALTER TABLE cdc_cursors DROP COLUMN IF EXISTS last_event_index;
-- ALTER TABLE cdc_cursors DROP COLUMN IF EXISTS last_timestamp;
-- DROP INDEX IF EXISTS idx_stream_events_compound_key;
```

### How to Apply

```bash
# Using psql directly:
psql $DATABASE_URL < migrations/001_extend_cdc_cursors_for_compound_keys.sql

# Or using a migration framework (e.g., Flyway, Liquibase):
flyway migrate -configFiles=flyway.conf

# Verify migration:
psql $DATABASE_URL -c "
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'cdc_cursors'
  ORDER BY ordinal_position;
"
```

---

## Issue #2: Failed Event Retention Migration

### Migration: 002_create_failed_events_table.sql

This migration creates tables for tracking failed events and enabling replay with permission checks.

```sql
-- Migration: 002_create_failed_events_table.sql
-- Date: 2025-01-19
-- Purpose: Enable failed event retention and auditable replay (Issue #2)

-- Step 1: Create failed_events table for retryable failures
CREATE TABLE IF NOT EXISTS failed_events (
  id                 BIGSERIAL PRIMARY KEY,
  event_id           TEXT            NOT NULL,
  contract_id        TEXT            NOT NULL,
  cause              VARCHAR(50)     NOT NULL, -- XDR_PARSE_ERROR, DB_INSERT_ERROR, etc.
  attempts           INT             NOT NULL DEFAULT 1,
  max_attempts       INT             NOT NULL DEFAULT 5,
  last_attempt_at    TIMESTAMPTZ     NOT NULL,
  next_retry_at      TIMESTAMPTZ,
  raw_event          JSONB           NOT NULL, -- Serialized event for replay
  error_message      TEXT,
  should_retry       BOOLEAN         NOT NULL DEFAULT TRUE,
  actor_who_queued   VARCHAR(56),              -- Stellar address who triggered retry
  reason             TEXT,                      -- Why we're retrying
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Step 2: Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_failed_events_contract
  ON failed_events (contract_id)
  WHERE should_retry = TRUE;

CREATE INDEX IF NOT EXISTS idx_failed_events_retry_needed
  ON failed_events (next_retry_at)
  WHERE should_retry = TRUE AND next_retry_at <= NOW();

CREATE INDEX IF NOT EXISTS idx_failed_events_cause
  ON failed_events (cause)
  WHERE should_retry = TRUE;

-- Step 3: Create event_replay_audit table for compliance
CREATE TABLE IF NOT EXISTS event_replay_audits (
  id                  BIGSERIAL PRIMARY KEY,
  failed_event_id     BIGINT          NOT NULL REFERENCES failed_events(id),
  attempt_number      INT             NOT NULL,
  actor               VARCHAR(56)     NOT NULL, -- Operator/service account
  action              VARCHAR(50)     NOT NULL, -- RETRY_SUBMITTED, PERMISSION_DENIED, SUCCESS, etc.
  permission_granted  BOOLEAN,                   -- Whether actor had permission
  result              VARCHAR(50),               -- SUCCESS, NETWORK_ERROR, PERMISSION_DENIED, etc.
  error_message       TEXT,
  attempted_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Step 4: Create index for audit trail
CREATE INDEX IF NOT EXISTS idx_event_replay_audits_event
  ON event_replay_audits (failed_event_id);

-- Step 5: Create partition_status table for isolation tracking
CREATE TABLE IF NOT EXISTS partition_status (
  id                  BIGSERIAL PRIMARY KEY,
  partition_key       VARCHAR(100)    NOT NULL, -- e.g., contract_id, stream_id
  partition_type      VARCHAR(50)     NOT NULL, -- CONTRACT, STREAM, CAMPAIGN
  status              VARCHAR(50)     NOT NULL, -- HEALTHY, DEGRADED, FAILED
  failed_at           TIMESTAMPTZ,
  recovery_attempted  INT             NOT NULL DEFAULT 0,
  last_error          TEXT,
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(partition_key, partition_type)
);

CREATE INDEX IF NOT EXISTS idx_partition_status_failed
  ON partition_status (partition_type, status);

-- Rollback:
-- DROP TABLE IF EXISTS partition_status;
-- DROP TABLE IF EXISTS event_replay_audits;
-- DROP TABLE IF EXISTS failed_events;
```

### How to Apply

```bash
psql $DATABASE_URL < migrations/002_create_failed_events_table.sql

# Verify tables created:
psql $DATABASE_URL -c "\dt | grep -E 'failed_events|event_replay|partition_status'"
```

### How to Use Failed Events Table

```typescript
// When parsing fails:
try {
  const parsed = parseStreamEvent(raw, ledger, timestamp);
} catch (error) {
  await insertFailedEvent(db, {
    eventId: raw.id,
    contractId: raw.contractId,
    cause: 'XDR_PARSE_ERROR',
    attempts: 1,
    rawEvent: raw,
    errorMessage: error.message,
  });
}

// Replay failed events (with permission check):
const failedEvents = await getFailedEventsForRetry(db);
for (const failedEvent of failedEvents) {
  // Check if user still has permission
  const hasPermission = await checkPermissions(actor, failedEvent.contract_id);
  
  if (!hasPermission) {
    await auditReplayAttempt(db, failedEvent.id, actor, 'PERMISSION_DENIED');
    continue; // Skip this event
  }
  
  try {
    const event = JSON.parse(failedEvent.raw_event);
    await processEvent(event);
    await markEventReplaySuccessful(db, failedEvent.id);
  } catch (error) {
    await markEventReplayFailed(db, failedEvent.id, error.message);
  }
}
```

---

## Issue #3: Draft Persistence Migration

### No Database Migration Required

Issue #3 uses localStorage for persistence, not database tables. However, if integrating with a backend:

```sql
-- Optional: Store draft state on server for sync across devices
CREATE TABLE IF NOT EXISTS user_drafts (
  id                  BIGSERIAL PRIMARY KEY,
  user_address        VARCHAR(56)     NOT NULL, -- Stellar address
  draft_id            VARCHAR(36)     NOT NULL, -- UUID from sync queue
  draft_type          VARCHAR(50)     NOT NULL, -- campaign, stream, payment
  draft_payload       JSONB           NOT NULL,
  draft_status        VARCHAR(50)     NOT NULL, -- editing, offline_saved, online_confirmed, deployed
  requires_confirmation BOOLEAN       NOT NULL DEFAULT TRUE,
  online_confirmed_at TIMESTAMPTZ,
  deployed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(user_address, draft_id)
);

CREATE INDEX idx_user_drafts_user ON user_drafts (user_address, created_at DESC);
CREATE INDEX idx_user_drafts_status ON user_drafts (user_address, draft_status)
  WHERE draft_status != 'deployed';
```

---

## Issue #4: Projection Comparison and Audit Migration

### Migration: 003_create_projection_audit_tables.sql

This migration creates tables for projection anchoring, drift detection, and audit trail.

```sql
-- Migration: 003_create_projection_audit_tables.sql
-- Date: 2025-01-19
-- Purpose: Enable projection comparison and audit (Issue #4)

-- Step 1: Create projection_results table with ledger anchoring
CREATE TABLE IF NOT EXISTS projection_results (
  id                  BIGSERIAL PRIMARY KEY,
  campaign_id         VARCHAR(56)     NOT NULL,
  ledger_sequence     BIGINT          NOT NULL, -- NEW: Which ledger this was calculated at
  calculated_at       TIMESTAMPTZ     NOT NULL,
  projection_type     VARCHAR(50)     NOT NULL, -- co2, carbon_offset, impact
  result_data         JSONB           NOT NULL, -- Complete projection data
  checksum            VARCHAR(64),               -- SHA-256 of result_data
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, ledger_sequence, projection_type)
);

-- Step 2: Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_projection_results_campaign
  ON projection_results (campaign_id, ledger_sequence DESC);

-- Step 3: Create projection_drifts table for recording divergences
CREATE TABLE IF NOT EXISTS projection_drifts (
  id                  BIGSERIAL PRIMARY KEY,
  campaign_id         VARCHAR(56)     NOT NULL,
  previous_ledger     BIGINT,
  current_ledger      BIGINT          NOT NULL,
  projection_type     VARCHAR(50)     NOT NULL,
  field_name          VARCHAR(100)    NOT NULL, -- e.g., totalCo2Kg, ci95HighKg
  previous_value      NUMERIC,
  current_value       NUMERIC         NOT NULL,
  percent_change      DECIMAL(10, 2),
  drift_category      VARCHAR(50),              -- MINOR, MAJOR, CRITICAL
  detected_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  audit_entry_id      VARCHAR(36)               -- Link to AuditRecord
);

-- Step 4: Create index for drift queries
CREATE INDEX IF NOT EXISTS idx_projection_drifts_campaign
  ON projection_drifts (campaign_id, current_ledger DESC);

CREATE INDEX IF NOT EXISTS idx_projection_drifts_severity
  ON projection_drifts (campaign_id, drift_category)
  WHERE drift_category IS NOT NULL;

-- Step 5: Create projection_audits table for repair trail
CREATE TABLE IF NOT EXISTS projection_audits (
  id                  BIGSERIAL PRIMARY KEY,
  campaign_id         VARCHAR(56)     NOT NULL,
  action              VARCHAR(50)     NOT NULL, -- RECALCULATE, REPAIR, APPROVE, REJECT
  actor               VARCHAR(56)     NOT NULL, -- Operator/admin
  actor_role          VARCHAR(50)     NOT NULL, -- admin, operator, auditor
  reason              TEXT,
  previous_ledger     BIGINT,
  current_ledger      BIGINT,
  drift_detected      BOOLEAN,
  drift_summary       JSONB,                    -- Summarized drifts
  approved_by         VARCHAR(56),              -- Secondary approver for critical repairs
  approved_at         TIMESTAMPTZ,
  executed_at         TIMESTAMPTZ,
  status              VARCHAR(50)     NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, EXECUTED, REJECTED
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Step 6: Create index for audit trail
CREATE INDEX IF NOT EXISTS idx_projection_audits_campaign
  ON projection_audits (campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_projection_audits_pending
  ON projection_audits (status)
  WHERE status = 'PENDING';

-- Step 7: Create ledger_snapshots table for state rollback capability
CREATE TABLE IF NOT EXISTS ledger_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  campaign_id         VARCHAR(56)     NOT NULL,
  ledger_sequence     BIGINT          NOT NULL,
  snapshot_type       VARCHAR(50)     NOT NULL, -- campaign_state, projection, all
  snapshot_data       JSONB           NOT NULL,
  captured_by         VARCHAR(56),              -- Service account or operator
  captured_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, ledger_sequence, snapshot_type)
);

-- Step 8: Create index for snapshot queries
CREATE INDEX IF NOT EXISTS idx_ledger_snapshots_campaign
  ON ledger_snapshots (campaign_id, ledger_sequence DESC);

-- Rollback:
-- DROP TABLE IF EXISTS ledger_snapshots;
-- DROP TABLE IF EXISTS projection_audits;
-- DROP TABLE IF EXISTS projection_drifts;
-- DROP TABLE IF EXISTS projection_results;
```

### How to Apply

```bash
psql $DATABASE_URL < migrations/003_create_projection_audit_tables.sql

# Verify tables created:
psql $DATABASE_URL -c "
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
  AND tablename LIKE 'projection%' OR tablename LIKE 'ledger%';
"
```

### How to Use Projection Audit Tables

```typescript
// When calculating a projection:
const current = await calculateProjection(campaignId, currentLedger);

// Store with ledger anchor
await insertProjectionResult(db, {
  campaignId,
  ledgerSequence: currentLedger,
  projectionType: 'co2',
  resultData: current,
  checksum: sha256(JSON.stringify(current)),
});

// Compare with previous if exists:
const previous = await getProjectionAtLedger(db, campaignId, previousLedger);
if (previous) {
  const drifts = compareProjections(previous, current);
  
  for (const drift of drifts) {
    await insertProjectionDrift(db, {
      campaignId,
      previousLedger,
      currentLedger,
      fieldName: drift.field,
      previousValue: drift.previousValue,
      currentValue: drift.currentValue,
      percentChange: drift.percentChange,
      driftCategory: drift.percentChange > 10 ? 'MAJOR' : 'MINOR',
    });
  }
  
  // Audit the drift
  await auditLogger.record({
    actor: operatorId,
    action: 'projection.drift_detected',
    target: `campaign:${campaignId}:projection`,
    reason: `Drift ${drifts.length} fields from ledger ${previousLedger} to ${currentLedger}`,
    outcome: 'DRIFT_DETECTED',
    metadata: { drifts: drifts.length, maxChange: Math.max(...drifts.map(d => d.percentChange)) },
  });
}
```

---

## Migration Execution Order

1. **First**: Run 001_extend_cdc_cursors_for_compound_keys.sql (Issue #1)
2. **Second**: Run 002_create_failed_events_table.sql (Issue #2)
3. **Third**: Run 003_create_projection_audit_tables.sql (Issue #4)

```bash
# Execute all migrations in order
for migration in migrations/00*.sql; do
  echo "Executing $migration..."
  psql $DATABASE_URL < "$migration"
  if [ $? -eq 0 ]; then
    echo "✓ $migration completed"
  else
    echo "✗ $migration failed"
    exit 1
  fi
done
```

---

## Rollback Procedure

If any migration needs to be rolled back:

```bash
# Rollback migration 003
psql $DATABASE_URL << EOF
  DROP TABLE IF EXISTS ledger_snapshots;
  DROP TABLE IF EXISTS projection_audits;
  DROP TABLE IF EXISTS projection_drifts;
  DROP TABLE IF EXISTS projection_results;
EOF

# Rollback migration 002
psql $DATABASE_URL << EOF
  DROP TABLE IF EXISTS partition_status;
  DROP TABLE IF EXISTS event_replay_audits;
  DROP TABLE IF EXISTS failed_events;
EOF

# Rollback migration 001
psql $DATABASE_URL << EOF
  ALTER TABLE cdc_cursors DROP COLUMN IF EXISTS last_tx_hash;
  ALTER TABLE cdc_cursors DROP COLUMN IF EXISTS last_event_index;
  ALTER TABLE cdc_cursors DROP COLUMN IF EXISTS last_timestamp;
  DROP INDEX IF EXISTS idx_stream_events_compound_key;
EOF
```

---

## Testing Migrations

After applying migrations, verify tables and indexes:

```sql
-- Check all new tables exist
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
AND (
  tablename LIKE '%cdc%' OR
  tablename LIKE '%failed%' OR
  tablename LIKE '%projection%' OR
  tablename LIKE '%partition%' OR
  tablename LIKE '%ledger%' OR
  tablename LIKE '%replay%'
)
ORDER BY tablename;

-- Check indexes
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
AND indexname LIKE '%compound%' OR indexname LIKE '%failed%' OR indexname LIKE '%projection%'
ORDER BY indexname;

-- Verify column additions
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'cdc_cursors'
ORDER BY ordinal_position;
```

---

## Performance Considerations

1. **Compound Cursor Index**: Composite index on (ledger, txHash, eventIndex) supports fast cursor lookups
2. **Failed Events Indexes**: Separate indexes on (contract, retry_needed, cause) optimize different replay strategies
3. **Projection Indexes**: Campaign-specific indexes enable fast drift detection for active campaigns
4. **Partition Indexes**: Support quick health checks during replay

Consider running ANALYZE after initial data load:

```bash
psql $DATABASE_URL -c "ANALYZE;" 
```

