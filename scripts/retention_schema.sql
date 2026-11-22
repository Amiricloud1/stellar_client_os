-- Schema for tracking sponsor cohorts and event retention/audit data
--
-- This file is idempotent: every statement uses IF NOT EXISTS or is guarded,
-- so it can be re-applied safely against an existing database.
--
-- ---------------------------------------------------------------------------
-- Migration notes (issues #223 / #224)
-- ---------------------------------------------------------------------------
-- 1. Raw event envelopes (#223)
--    `raw_event_envelopes` stores a minimal, integrity-checkable copy of each
--    source event so derived records can be traced back to their origin.
--    Only the minimum needed for audit is retained: the payload itself is
--    redacted according to `privacy_flags` and `retention_class`, and
--    `payload_hash` (SHA-256 hex of the canonical raw payload) allows
--    integrity verification without storing sensitive data.
--
--    Backfill procedure:
--      a. Deploy this schema (adds tables/indexes only; no data changes).
--      b. Run the envelope backfill job, which reads source events in
--         `observed_at` order and inserts one envelope per `event_id`
--         (ON CONFLICT DO NOTHING, so re-runs are safe).
--      c. Verify with:
--           SELECT count(*) FROM raw_event_envelopes WHERE payload_hash IS NULL;
--         which must return 0.
--      d. Derived tables gain a nullable `envelope_event_id` column. Existing
--         rows keep NULL until the backfill links them; new writes MUST set it.
--         After backfill completes, operators may enforce NOT NULL in a
--         follow-up migration once the NULL count is zero:
--           SELECT count(*) FROM <derived_table> WHERE envelope_event_id IS NULL;
--
-- 2. Archived event summaries (#224)
--    `archived_event_summaries` records compaction campaigns. Each row covers
--    a contiguous [range_start, range_end) ledger range for a campaign/contract
--    and stores the event count, an aggregate payload, and an `archive_hash`
--    (SHA-256 hex over the canonical serialization of the archived events).
--    Individual indexed events in that range may be pruned only after the
--    summary row is committed and its `archive_hash` verified.
--
--    Reconstruction procedure:
--      a. Look up the summary covering the desired ledger:
--           SELECT * FROM archived_event_summaries
--            WHERE campaign_id = $1 AND contract_id = $2
--              AND range_start <= $3 AND $3 < range_end;
--      b. Fetch the archived payload from cold storage using `archive_hash`
--         as the object key / integrity check.
--      c. Recompute the hash over the canonical serialization and compare to
--         `archive_hash`; abort and alert operators on mismatch.
--      d. Replay events in ledger order to rebuild derived state, or answer
--         audit queries directly from the aggregate payload.
--    Failure states are explicit: a summary row is only visible to audit
--    queries once committed; a hash mismatch marks the archive as corrupt and
--    requires operator intervention (no silent fallback to pruned data).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Sponsor cohort tables (existing)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sponsor_signups (
  sponsor_address TEXT PRIMARY KEY,
  signup_date     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sponsorships (
  id              BIGSERIAL PRIMARY KEY,
  sponsor_address TEXT        NOT NULL REFERENCES sponsor_signups(sponsor_address),
  stream_id       TEXT        NOT NULL,
  amount          NUMERIC     NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sponsorships_sponsor_address ON sponsorships(sponsor_address);
CREATE INDEX IF NOT EXISTS idx_sponsorships_created_at ON sponsorships(created_at);

-- ---------------------------------------------------------------------------
-- Raw event envelopes (#223)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS raw_event_envelopes (
  event_id         TEXT        PRIMARY KEY,
  source           TEXT        NOT NULL,
  ledger           BIGINT      NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL,
  -- SHA-256 hex of the canonical raw payload; used for integrity checks.
  payload_hash     TEXT        NOT NULL,
  -- Retention policy bucket, e.g. 'standard', 'extended', 'legal_hold'.
  retention_class  TEXT        NOT NULL DEFAULT 'standard',
  -- Privacy handling applied to the payload, e.g. 'none', 'redacted', 'hashed'.
  privacy_flags    TEXT        NOT NULL DEFAULT 'none',
  -- Minimal redacted payload; never contains unredacted sensitive fields.
  redacted_payload JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit queries: trace a derived record back to its source envelope.
CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_source_ledger
  ON raw_event_envelopes(source, ledger);
CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_observed_at
  ON raw_event_envelopes(observed_at);
CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_retention_class
  ON raw_event_envelopes(retention_class);
CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_payload_hash
  ON raw_event_envelopes(payload_hash);

-- ---------------------------------------------------------------------------
-- Archived event summaries (#224)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS archived_event_summaries (
  id              BIGSERIAL   PRIMARY KEY,
  campaign_id     TEXT        NOT NULL,
  contract_id     TEXT        NOT NULL,
  -- Half-open ledger range [range_start, range_end).
  range_start     BIGINT      NOT NULL,
  range_end       BIGINT      NOT NULL,
  event_count     BIGINT      NOT NULL,
  -- Aggregate payload sufficient to answer agreed history queries.
  aggregate_payload JSONB,
  -- SHA-256 hex over the canonical serialization of the archived events.
  archive_hash    TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT archived_event_summaries_range_valid CHECK (range_end > range_start),
  CONSTRAINT archived_event_summaries_count_nonneg CHECK (event_count >= 0)
);

-- Audit queries: find the summary covering a given ledger.
CREATE INDEX IF NOT EXISTS idx_archived_event_summaries_lookup
  ON archived_event_summaries(campaign_id, contract_id, range_start, range_end);
CREATE INDEX IF NOT EXISTS idx_archived_event_summaries_created_at
  ON archived_event_summaries(created_at);
CREATE INDEX IF NOT EXISTS idx_archived_event_summaries_archive_hash
  ON archived_event_summaries(archive_hash);

-- ---------------------------------------------------------------------------
-- Link column on derived event tables (#223)
-- ---------------------------------------------------------------------------
-- Derived tables (e.g. `sponsorships`) gain a nullable `envelope_event_id`
-- referencing the source envelope. Added via ALTER so existing deployments
-- migrate in place; new writes must populate it (see migration notes).

ALTER TABLE sponsorships
  ADD COLUMN IF NOT EXISTS envelope_event_id TEXT
  REFERENCES raw_event_envelopes(event_id);

CREATE INDEX IF NOT EXISTS idx_sponsorships_envelope_event_id
  ON sponsorships(envelope_event_id);