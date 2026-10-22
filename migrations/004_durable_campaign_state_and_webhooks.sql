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
--
-- Source of truth
-- ---------------
-- * Campaign state is owned by the `campaigns` table. The API treats this
--   table as the single durable source of truth; any in-memory or cache
--   representation is derived and MUST be rebuildable from this table.
-- * Webhook subscriptions are owned by the `webhook_subscriptions` table.
--   Delivery attempts are recorded in `webhook_delivery_attempts` and are
--   append-only.
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
-- * No columns are dropped and no data is rewritten beyond the `updated_at`
--   backfill, so this migration is safe to run online on PostgreSQL >= 11.
--
-- Rollback notes
-- --------------
-- * To roll back: drop the triggers and functions created here, drop the
--   indexes, then drop the added columns (`idempotency_key`,
--   `last_delivery_at`). The `updated_at` backfill is not reversible but is
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

COMMIT;

-- ---------------------------------------------------------------------------
-- DOWN (rollback) — run manually if this migration must be reverted.
-- ---------------------------------------------------------------------------
-- BEGIN;
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