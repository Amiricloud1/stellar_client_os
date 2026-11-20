-- Migration: 004_durable_campaign_state_and_webhooks.sql
--
-- Purpose
-- -------
-- Establish the durable source-of-truth model for campaign state and webhook
-- subscriptions used by the API layer. This migration:
--
--   1. Documents the persistence and transaction boundaries for campaign
--      state and webhook subscriptions (see "Source of truth" below).
--   2. Adds/enforces constraints that guarantee record integrity across
--      process restarts (NOT NULL, CHECK, UNIQUE, FK).
--   3. Adds indexes supporting the API's read/write access patterns.
--   4. Adds idempotency keys for webhook subscription mutations so retried
--      requests are safe across restarts.
--   5. Adds `updated_at` maintenance triggers so the API can rely on
--      monotonic timestamps for optimistic concurrency and cache invalidation.
--   6. Adds minimal raw event envelopes (`raw_event_envelopes`) for
--      auditability and compacted archive summaries
--      (`archived_event_summaries`) for high-volume retention, and links
--      derived event records to their source envelope via `envelope_id`.
--
-- Source of truth
-- ---------------
-- * Campaign state is owned by the `campaigns` table. The API treats this
--   table as the single durable source of truth; any in-memory or cache
--   representation is derived and MUST be rebuildable from this table.
-- * Webhook subscriptions are owned by the `webhook_subscriptions` table.
--   Delivery attempts are recorded in `webhook_delivery_attempts` and are
--   append-only.
-- * Raw event envelopes are owned by `raw_event_envelopes`. Each envelope is
--   the integrity-checkable source for one or more derived event records.
--   Derived records reference their source via `envelope_id`; the envelope's
--   `content_hash` allows verifying that the retained payload matches what was
--   originally ingested.
-- * Compacted history is owned by `archived_event_summaries`. When raw
--   envelopes are compacted, a summary row records the aggregate (counts,
--   time range, hash chain) so audit queries can be answered without the raw
--   rows. The archive routing view `event_audit_log` below keeps existing
--   audit queries working across both live and archived data.
--
-- Transaction boundaries
-- ----------------------
-- * A campaign state transition MUST be committed in a single transaction
--   that updates `campaigns.state` and `campaigns.updated_at` together. The
--   trigger below enforces `updated_at` monotonicity.
-- * A webhook subscription create/update MUST be committed in a single
--   transaction that writes the subscription row and its idempotency key
--   together. The UNIQUE constraint on `idempotency_key` guarantees that a
--   retried request after a crash cannot create a duplicate subscription.
-- * Delivery attempts are written in their own transaction and MUST NOT
--   mutate the subscription row except through the standard update path.
-- * An envelope and the derived records that reference it MUST be written in
--   the same transaction. Compaction (moving raw envelopes into
--   `archived_event_summaries`) MUST be committed in a single transaction
--   that inserts the summary and deletes the raw envelopes together, so a
--   crash cannot lose history.
--
-- Compatibility / migration implications
-- ---------------------------------------
-- * Existing rows: `campaigns` and `webhook_subscriptions` are expected to
--   already exist from earlier migrations. This migration is additive and
--   backfills `updated_at` from `created_at` where NULL before adding the
--   NOT NULL constraint.
-- * `idempotency_key` is added as nullable to preserve existing rows; new
--   API writes MUST always supply it. A partial unique index enforces
--   uniqueness only for non-NULL values.
-- * `envelope_id` is added to derived event tables as nullable to preserve
--   existing rows. Backfill creates synthetic envelopes for pre-existing
--   derived rows where the source payload is still available; rows without a
--   recoverable payload keep a NULL `envelope_id` and are treated as
--   legacy/unverifiable. New API writes MUST always supply `envelope_id`.
-- * Existing audit queries keep working: the `event_audit_log` view unions
--   live derived events with `archived_event_summaries`, so callers do not
--   need to know whether a given time range has been compacted. Queries that
--   need raw payloads must join `raw_event_envelopes` and tolerate NULL for
--   compacted ranges.
-- * No columns are dropped and no data is rewritten beyond the `updated_at`
--   and `envelope_id` backfills, so this migration is safe to run online on
--   PostgreSQL >= 11.
--
-- Rollback notes
-- --------------
-- * To roll back: drop the triggers and functions created here, drop the
--   indexes, then drop the added columns (`idempotency_key`,
--   `last_delivery_at`, `envelope_id`). Drop the archive view and the
--   `archived_event_summaries` / `raw_event_envelopes` tables last. The
--   `updated_at` and `envelope_id` backfills are not reversible but are
--   harmless. See the DOWN section at the bottom (commented) for the exact
--   statements.
--
-- All statements are idempotent (IF NOT EXISTS / guarded) so the migration
-- can be re-run safely in CI.

BEGIN;

-- ---------------------------------------------------------------------------
-- Shared helper: updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    -- Enforce monotonicity: never move updated_at backwards even if a caller
    -- supplies an explicit value. This keeps optimistic concurrency and cache
    -- invalidation correct across process restarts.
    IF NEW.updated_at IS NULL OR NEW.updated_at <= OLD.updated_at THEN
        NEW.updated_at := GREATEST(clock_timestamp(), OLD.updated_at + INTERVAL '1 microsecond');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Campaign state: durable source of truth
-- ---------------------------------------------------------------------------

-- Backfill updated_at for pre-existing rows before enforcing NOT NULL.
UPDATE campaigns
   SET updated_at = COALESCE(updated_at, created_at, clock_timestamp())
 WHERE updated_at IS NULL;

ALTER TABLE campaigns
    ALTER COLUMN updated_at SET DEFAULT clock_timestamp();

ALTER TABLE campaigns
    ALTER COLUMN updated_at SET NOT NULL;

-- Campaign state must be one of the known lifecycle values. Keep this list in
-- sync with the API's CampaignState enum.
ALTER TABLE campaigns
    DROP CONSTRAINT IF EXISTS campaigns_state_check;
ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_state_check
    CHECK (state IN (
        'draft',
        'scheduled',
        'active',
        'paused',
        'completed',
        'cancelled'
    ));

-- A campaign must always have an owner and a stable identifier for the API.
ALTER TABLE campaigns
    ALTER COLUMN id SET NOT NULL;

-- Index supporting the API's primary read pattern: list campaigns by state,
-- most recently updated first.
CREATE INDEX IF NOT EXISTS idx_campaigns_state_updated_at
    ON campaigns (state, updated_at DESC);

-- Index supporting lookups of a single campaign's latest state by id is
-- covered by the primary key; no extra index required.

DROP TRIGGER IF EXISTS trg_campaigns_set_updated_at ON campaigns;
CREATE TRIGGER trg_campaigns_set_updated_at
    BEFORE UPDATE ON campaigns
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook subscriptions: durable source of truth
-- ---------------------------------------------------------------------------

-- Idempotency key for subscription mutations. Nullable to preserve existing
-- rows; the partial unique index below enforces uniqueness for new writes.
ALTER TABLE webhook_subscriptions
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Timestamp of the most recent delivery attempt, denormalized for fast reads.
ALTER TABLE webhook_subscriptions
    ADD COLUMN IF NOT EXISTS last_delivery_at TIMESTAMPTZ;

-- Backfill updated_at for pre-existing rows before enforcing NOT NULL.
UPDATE webhook_subscriptions
   SET updated_at = COALESCE(updated_at, created_at, clock_timestamp())
 WHERE updated_at IS NULL;

ALTER TABLE webhook_subscriptions
    ALTER COLUMN updated_at SET DEFAULT clock_timestamp();

ALTER TABLE webhook_subscriptions
    ALTER COLUMN updated_at SET NOT NULL;

-- A subscription must always target a valid URL and belong to a campaign.
ALTER TABLE webhook_subscriptions
    ALTER COLUMN id SET NOT NULL;

ALTER TABLE webhook_subscriptions
    ALTER COLUMN campaign_id SET NOT NULL;

ALTER TABLE webhook_subscriptions
    ALTER COLUMN target_url SET NOT NULL;

ALTER TABLE webhook_subscriptions
    DROP CONSTRAINT IF EXISTS webhook_subscriptions_target_url_check;
ALTER TABLE webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_target_url_check
    CHECK (target_url ~* '^https?://');

-- Subscription status must be one of the known values.
ALTER TABLE webhook_subscriptions
    DROP CONSTRAINT IF EXISTS webhook_subscriptions_status_check;
ALTER TABLE webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_status_check
    CHECK (status IN ('active', 'paused', 'disabled'));

-- Idempotency: a given key may be used at most once. Partial index so that
-- legacy rows with NULL keys remain valid.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_subscriptions_idempotency_key
    ON webhook_subscriptions (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Index supporting the API's read pattern: list subscriptions for a campaign.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_campaign_id
    ON webhook_subscriptions (campaign_id);

-- Index supporting delivery scheduling: active subscriptions ordered by last
-- delivery time.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_status_last_delivery
    ON webhook_subscriptions (status, last_delivery_at NULLS FIRST);

DROP TRIGGER IF EXISTS trg_webhook_subscriptions_set_updated_at ON webhook_subscriptions;
CREATE TRIGGER trg_webhook_subscriptions_set_updated_at
    BEFORE UPDATE ON webhook_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook delivery attempts: append-only audit log
-- ---------------------------------------------------------------------------

-- Delivery attempts are append-only; they must reference a subscription and
-- record a terminal outcome. This table is created here if it does not yet
-- exist so the durable model is self-contained.
CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
    id                BIGSERIAL PRIMARY KEY,
    subscription_id   TEXT NOT NULL
        REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
    attempt_number    INTEGER NOT NULL CHECK (attempt_number >= 1),
    outcome           TEXT NOT NULL
        CHECK (outcome IN ('success', 'failure', 'timeout')),
    response_status   INTEGER,
    error_message     TEXT,
    attempted_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Index supporting per-subscription delivery history reads.
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_subscription_id
    ON webhook_delivery_attempts (subscription_id, attempted_at DESC);

-- Enforce append-only semantics: reject UPDATE and DELETE on attempts.
CREATE OR REPLACE FUNCTION webhook_delivery_attempts_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'webhook_delivery_attempts is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_webhook_delivery_attempts_no_update
    ON webhook_delivery_attempts;
CREATE TRIGGER trg_webhook_delivery_attempts_no_update
    BEFORE UPDATE ON webhook_delivery_attempts
    FOR EACH ROW
    EXECUTE FUNCTION webhook_delivery_attempts_append_only();

DROP TRIGGER IF EXISTS trg_webhook_delivery_attempts_no_delete
    ON webhook_delivery_attempts;
CREATE TRIGGER trg_webhook_delivery_attempts_no_delete
    BEFORE DELETE ON webhook_delivery_attempts
    FOR EACH ROW
    EXECUTE FUNCTION webhook_delivery_attempts_append_only();

-- ---------------------------------------------------------------------------
-- Raw event envelopes: minimal, integrity-checkable source records
-- ---------------------------------------------------------------------------

-- An envelope retains only the minimal metadata needed to audit and verify a
-- derived event: who produced it, when, and a hash of the original payload.
-- The full payload is NOT retained here; privacy rules require that only the
-- minimal envelope survives. `content_hash` lets operators verify that a
-- derived record was produced from the retained source.
CREATE TABLE IF NOT EXISTS raw_event_envelopes (
    id                TEXT PRIMARY KEY,
    source            TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Retention: envelopes become eligible for compaction after this time.
    retain_until      TIMESTAMPTZ NOT NULL
        DEFAULT (clock_timestamp() + INTERVAL '30 days'),
    -- Set when the envelope has been compacted into a summary. NULL means the
    -- raw envelope is still live and queryable.
    compacted_at      TIMESTAMPTZ,
    CONSTRAINT raw_event_envelopes_content_hash_check
        CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

-- Index supporting compaction sweeps: find live envelopes past retention.
CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_retention
    ON raw_event_envelopes (retain_until)
    WHERE compacted_at IS NULL;

-- Index supporting audit lookups by source and time.
CREATE INDEX IF NOT EXISTS idx_raw_event_envelopes_source_received_at
    ON raw_event_envelopes (source, received_at DESC);

-- ---------------------------------------------------------------------------
-- Archived event summaries: compacted history for high-volume data
-- ---------------------------------------------------------------------------

-- When raw envelopes are compacted, one summary row per (source, event_type,
-- time bucket) records the aggregate so audit queries can still be answered.
-- `envelope_count` and `hash_chain` allow reconstruction verification: the
-- chain is the ordered concatenation of the compacted envelopes' hashes.
CREATE TABLE IF NOT EXISTS archived_event_summaries (
    id                BIGSERIAL PRIMARY KEY,
    source            TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    bucket_start      TIMESTAMPTZ NOT NULL,
    bucket_end        TIMESTAMPTZ NOT NULL,
    envelope_count    BIGINT NOT NULL CHECK (envelope_count >= 1),
    hash_chain        TEXT NOT NULL,
    compacted_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT archived_event_summaries_bucket_check
        CHECK (bucket_end > bucket_start),
    CONSTRAINT archived_event_summaries_unique_bucket
        UNIQUE (source, event_type, bucket_start, bucket_end)
);

-- Index supporting audit queries over compacted ranges.
CREATE INDEX IF NOT EXISTS idx_archived_event_summaries_source_bucket
    ON archived_event_summaries (source, bucket_start DESC);

-- ---------------------------------------------------------------------------
-- Link derived event records to their source envelope
-- ---------------------------------------------------------------------------

-- Derived event tables carry an `envelope_id` FK. The FK is nullable to
-- preserve legacy rows; new writes MUST supply it. ON DELETE RESTRICT prevents
-- compaction from silently orphaning derived records: compaction must first
-- write the summary, then delete envelopes in the same transaction.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS envelope_id TEXT
        REFERENCES raw_event_envelopes (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_events_envelope_id
    ON events (envelope_id)
    WHERE envelope_id IS NOT NULL;

-- Backfill: create synthetic envelopes for pre-existing derived rows where a
-- payload hash is still available. Rows without a recoverable payload keep a
-- NULL envelope_id and are treated as legacy/unverifiable.
INSERT INTO raw_event_envelopes (id, source, event_type, content_hash, received_at)
SELECT
    'legacy-' || e.id,
    COALESCE(e.source, 'legacy'),
    COALESCE(e.event_type, 'unknown'),
    e.payload_hash,
    COALESCE(e.created_at, clock_timestamp())
  FROM events e
 WHERE e.envelope_id IS NULL
   AND e.payload_hash IS NOT NULL
   AND e.payload_hash ~ '^[0-9a-f]{64}$'
ON CONFLICT (id) DO NOTHING;

UPDATE events e
   SET envelope_id = 'legacy-' || e.id
 WHERE e.envelope_id IS NULL
   AND e.payload_hash IS NOT NULL
   AND e.payload_hash ~ '^[0-9a-f]{64}$';

-- ---------------------------------------------------------------------------
-- Audit routing view: live + archived history in one shape
-- ---------------------------------------------------------------------------

-- Existing audit queries can select from this view instead of `events` to
-- transparently include compacted ranges. Live rows expose their envelope_id;
-- archived rows expose the summary aggregate with NULL envelope_id.
CREATE OR REPLACE VIEW event_audit_log AS
SELECT
    e.id                AS event_id,
    e.envelope_id       AS envelope_id,
    e.source            AS source,
    e.event_type        AS event_type,
    e.created_at        AS occurred_at,
    'live'::TEXT        AS origin
  FROM events e
UNION ALL
SELECT
    NULL::TEXT          AS event_id,
    NULL::TEXT          AS envelope_id,
    s.source            AS source,
    s.event_type        AS event_type,
    s.bucket_start      AS occurred_at,
    'archived'::TEXT    AS origin
  FROM archived_event_summaries s;

COMMIT;

-- ---------------------------------------------------------------------------
-- DOWN (rollback) — run manually if this migration must be reverted.
-- ---------------------------------------------------------------------------
-- BEGIN;
-- DROP VIEW IF EXISTS event_audit_log;
-- DROP INDEX IF EXISTS idx_events_envelope_id;
-- ALTER TABLE events
--     DROP COLUMN IF EXISTS envelope_id;
-- DROP INDEX IF EXISTS idx_archived_event_summaries_source_bucket;
-- DROP TABLE IF EXISTS archived_event_summaries;
-- DROP INDEX IF EXISTS idx_raw_event_envelopes_source_received_at;
-- DROP INDEX IF EXISTS idx_raw_event_envelopes_retention;
-- DROP TABLE IF EXISTS raw_event_envelopes;
-- DROP TRIGGER IF EXISTS trg_webhook_delivery_attempts_no_delete
--     ON webhook_delivery_attempts;
-- DROP TRIGGER IF EXISTS trg_webhook_delivery_attempts_no_update
--     ON webhook_delivery_attempts;
-- DROP FUNCTION IF EXISTS webhook_delivery_attempts_append_only();
-- DROP TABLE IF EXISTS webhook_delivery_attempts;
-- DROP TRIGGER IF EXISTS trg_webhook_subscriptions_set_updated_at
--     ON webhook_subscriptions;
-- DROP INDEX IF EXISTS idx_webhook_subscriptions_status_last_delivery;
-- DROP INDEX IF EXISTS idx_webhook_subscriptions_campaign_id;
-- DROP INDEX IF EXISTS uq_webhook_subscriptions_idempotency_key;
-- ALTER TABLE webhook_subscriptions
--     DROP CONSTRAINT IF EXISTS webhook_subscriptions_status_check;
-- ALTER TABLE webhook_subscriptions
--     DROP CONSTRAINT IF EXISTS webhook_subscriptions_target_url_check;
-- ALTER TABLE webhook_subscriptions
--     DROP COLUMN IF EXISTS last_delivery_at;
-- ALTER TABLE webhook_subscriptions
--     DROP COLUMN IF EXISTS idempotency_key;
-- DROP TRIGGER IF EXISTS trg_campaigns_set_updated_at ON campaigns;
-- DROP INDEX IF EXISTS idx_campaigns_state_updated_at;
-- ALTER TABLE campaigns
--     DROP CONSTRAINT IF EXISTS campaigns_state_check;
-- DROP FUNCTION IF EXISTS set_updated_at();
-- COMMIT;
--
-- Note: dropping `raw_event_envelopes` requires that no derived rows still
-- reference it (ON DELETE RESTRICT). If `envelope_id` backfill ran, drop the
-- column first as shown above.