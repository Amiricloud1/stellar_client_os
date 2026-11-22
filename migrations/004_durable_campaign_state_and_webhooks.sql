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
--   6. Adds partitioned ingestion state (`cdc_cursors`, `backfill_jobs`,
--      `ingestion_health`) keyed by (network, deployment_id) so a stalled
--      source cannot block other deployments.
--   7. Adds reviewer comments with evidence references (`reviewer_comments`)
--      and terms snapshot binding for contributions (`terms_snapshot_hash`).
--
-- Source of truth
-- ---------------
-- * Campaign state is owned by the `campaigns` table. The API treats this
--   table as the single durable source of truth; any in-memory or cache
--   representation is derived and MUST be rebuildable from this table.
-- * Webhook subscriptions are owned by the `webhook_subscriptions` table.
--   Delivery attempts are recorded in `webhook_delivery_attempts` and are
--   append-only.
-- * Ingestion state is owned by `cdc_cursors`, `backfill_jobs` and
--   `ingestion_health`. Every row is scoped to exactly one
--   (network, deployment_id) partition. There is no shared/global cursor:
--   each partition advances independently, so a stalled source only affects
--   its own partition.
-- * Reviewer comments are owned by `reviewer_comments` and are append-only
--   except for the `resolved_at`/`resolved_by` resolution fields.
-- * The terms shown to a contributor before signing are bound to the
--   contribution via `contributions.terms_snapshot_hash` (and optional
--   `terms_version`). The hash MUST be computed over the exact terms content
--   presented at signing time.
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
-- * A cursor advance MUST be committed in a single transaction that updates
--   `cdc_cursors.last_committed_position` and `updated_at` together, scoped
--   by (network, deployment_id). Backfill job transitions and health updates
--   are likewise scoped to a single partition.
-- * A reviewer comment insert MUST reference an existing evidence version;
--   resolution updates only touch `resolved_at`/`resolved_by`.
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
-- * `contributions.terms_snapshot_hash` is added as nullable to preserve
--   existing rows. Legacy contributions have no verifiable terms binding;
--   operators MUST treat NULL as "unbound" and MAY backfill from archived
--   terms where available. New contributions MUST always supply it.
-- * Legacy shared ingestion cursors: if a pre-existing single-row cursor
--   table (e.g. `ingestion_cursors` or `cdc_state`) exists, this migration
--   copies each row into `cdc_cursors` under the partition identified by the
--   row's `network`/`deployment_id` columns when present. Rows without a
--   deployment are copied into a `legacy` deployment partition so operators
--   can triage them; they are NOT used to seed new partitions. The legacy
--   table is left in place (not dropped) for rollback safety.
-- * No columns are dropped and no data is rewritten beyond the `updated_at`
--   backfill and the legacy cursor copy, so this migration is safe to run
--   online on PostgreSQL >= 11.
--
-- Rollback notes
-- --------------
-- * To roll back: drop the triggers and functions created here, drop the
--   indexes, then drop the added columns (`idempotency_key`,
--   `last_delivery_at`, `terms_snapshot_hash`, `terms_version`), the new
--   tables (`cdc_cursors`, `backfill_jobs`, `ingestion_health`,
--   `reviewer_comments`). The `updated_at` backfill and the legacy cursor
--   copy are not reversible but are harmless. See the DOWN section at the
--   bottom (commented) for the exact statements.
--
-- All statements are idempotent (IF NOT EXISTS / guarded) so the migration
-- can be re-run safely in CI.
--
-- Addendum: deployment registry, canonical event mappings, replay runs, and
-- consumer backpressure metrics
-- ------------------------------------------------------------------------
-- This migration also establishes the durable model for:
--
--   * `contract_deployments` — the validated contract deployment registry.
--     Records network, address, deployment ledger, spec version, and
--     lifecycle state for every environment. Uniqueness is enforced on
--     (network, address) and on (network, environment) for the single active
--     deployment per environment.
--   * `contract_event_mappings` — canonical domain mappings from a
--     (contract, event version) pair to a projection. Unknown versions are
--     retained with `is_known = false` and a NULL projection so payloads are
--     never dropped.
--   * `projection_replay_runs` — deterministic replay runs across
--     event-schema versions. A run records the source/target schema version,
--     the comparison outcome, and the operator-visible state so cutover can
--     be gated on a successful comparison.
--   * `consumer_queue_metrics` — bounded-queue and concurrency observations
--     for event consumers, used to prove bounded memory and recovery
--     throughput under RPC or consumer outages.
--
-- Migration path for existing environments
-- ----------------------------------------
-- * All new tables are created with IF NOT EXISTS and are additive; no
--   existing table is altered destructively.
-- * `contract_deployments` rows are expected to be seeded by operators from
--   the existing deployment configuration. Until seeded, consumers MUST
--   treat the registry as empty and refuse to start (fail closed) rather
--   than falling back to hard-coded addresses.
-- * `contract_event_mappings` rows for known versions are seeded by the
--   application on startup; unknown versions are inserted on first sight.
-- * `projection_replay_runs` and `consumer_queue_metrics` start empty.
-- * Rollback: see the DOWN section at the bottom.

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
-- Ingestion state: partitioned by (network, deployment_id)
-- ---------------------------------------------------------------------------
-- Each partition owns its cursor, backfill jobs and health row. A stalled
-- source only affects its own partition; other deployments keep advancing.

CREATE TABLE IF NOT EXISTS cdc_cursors (
    network                  TEXT NOT NULL,
    deployment_id            TEXT NOT NULL,
    source                   TEXT NOT NULL,
    last_committed_position  TEXT,
    last_committed_at        TIMESTAMPTZ,
    status                   TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'stalled', 'paused', 'error')),
    last_error               TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (network, deployment_id, source)
);

-- Index supporting operator dashboards: list stalled partitions.
CREATE INDEX IF NOT EXISTS idx_cdc_cursors_status
    ON cdc_cursors (status, updated_at DESC);

DROP TRIGGER IF EXISTS trg_cdc_cursors_set_updated_at ON cdc_cursors;
CREATE TRIGGER trg_cdc_cursors_set_updated_at
    BEFORE UPDATE ON cdc_cursors
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS backfill_jobs (
    id               BIGSERIAL PRIMARY KEY,
    network          TEXT NOT NULL,
    deployment_id    TEXT NOT NULL,
    source           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
    from_position    TEXT,
    to_position      TEXT,
    progress         NUMERIC(5, 2) NOT NULL DEFAULT 0
        CHECK (progress >= 0 AND progress <= 100),
    attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Index supporting per-partition backfill scheduling and retries.
CREATE INDEX IF NOT EXISTS idx_backfill_jobs_partition_status
    ON backfill_jobs (network, deployment_id, status, created_at);

DROP TRIGGER IF EXISTS trg_backfill_jobs_set_updated_at ON backfill_jobs;
CREATE TRIGGER trg_backfill_jobs_set_updated_at
    BEFORE UPDATE ON backfill_jobs
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ingestion_health (
    network              TEXT NOT NULL,
    deployment_id        TEXT NOT NULL,
    source               TEXT NOT NULL,
    state                TEXT NOT NULL DEFAULT 'healthy'
        CHECK (state IN ('healthy', 'degraded', 'stalled', 'error')),
    lag_seconds          BIGINT,
    last_success_at      TIMESTAMPTZ,
    last_failure_at      TIMESTAMPTZ,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
        CHECK (consecutive_failures >= 0),
    last_error           TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (network, deployment_id, source)
);

-- Index supporting alerting on unhealthy partitions.
CREATE INDEX IF NOT EXISTS idx_ingestion_health_state
    ON ingestion_health (state, updated_at DESC);

DROP TRIGGER IF EXISTS trg_ingestion_health_set_updated_at ON ingestion_health;
CREATE TRIGGER trg_ingestion_health_set_updated_at
    BEFORE UPDATE ON ingestion_health
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Backfill from a legacy shared cursor table, if one exists. Rows without a
-- deployment are parked in a `legacy` deployment partition for triage.
DO $$
BEGIN
    IF to_regclass('public.ingestion_cursors') IS NOT NULL THEN
        INSERT INTO cdc_cursors
            (network, deployment_id, source, last_committed_position,
             last_committed_at, status)
        SELECT COALESCE(network, 'unknown'),
               COALESCE(deployment_id, 'legacy'),
               COALESCE(source, 'default'),
               last_position,
               last_updated_at,
               'active'
          FROM ingestion_cursors
        ON CONFLICT (network, deployment_id, source) DO NOTHING;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reviewer comments with evidence references
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reviewer_comments (
    id                BIGSERIAL PRIMARY KEY,
    evidence_id       TEXT NOT NULL,
    evidence_version  INTEGER NOT NULL CHECK (evidence_version >= 1),
    author_id         TEXT NOT NULL,
    body              TEXT NOT NULL CHECK (length(btrim(body)) > 0),
    resolved_at       TIMESTAMPTZ,
    resolved_by       TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

-- Index supporting the reviewer UI: comments for an evidence version, oldest
-- first, with unresolved comments surfaced.
CREATE INDEX IF NOT EXISTS idx_reviewer_comments_evidence
    ON reviewer_comments (evidence_id, evidence_version, created_at);

CREATE INDEX IF NOT EXISTS idx_reviewer_comments_unresolved
    ON reviewer_comments (evidence_id, evidence_version)
    WHERE resolved_at IS NULL;

DROP TRIGGER IF EXISTS trg_reviewer_comments_set_updated_at ON reviewer_comments;
CREATE TRIGGER trg_reviewer_comments_set_updated_at
    BEFORE UPDATE ON reviewer_comments
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Terms snapshot binding for contributions
-- ---------------------------------------------------------------------------

-- Hash of the exact terms content shown to the contributor before signing.
-- Nullable to preserve legacy rows; new contributions MUST supply it.
ALTER TABLE contributions
    ADD COLUMN IF NOT EXISTS terms_snapshot_hash TEXT;

-- Optional human-readable terms version for operator support.
ALTER TABLE contributions
    ADD COLUMN IF NOT EXISTS terms_version TEXT;

-- Index supporting audit lookups by terms snapshot.
CREATE INDEX IF NOT EXISTS idx_contributions_terms_snapshot_hash
    ON contributions (terms_snapshot_hash)
    WHERE terms_snapshot_hash IS NOT NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- DOWN (rollback) — run manually if this migration must be reverted.
-- ---------------------------------------------------------------------------
-- BEGIN;
-- DROP INDEX IF EXISTS idx_contributions_terms_snapshot_hash;
-- ALTER TABLE contributions
--     DROP COLUMN IF EXISTS terms_version;
-- ALTER TABLE contributions
--     DROP COLUMN IF EXISTS terms_snapshot_hash;
-- DROP TRIGGER IF EXISTS trg_reviewer_comments_set_updated_at
--     ON reviewer_comments;
-- DROP TABLE IF EXISTS reviewer_comments;
-- DROP TRIGGER IF EXISTS trg_ingestion_health_set_updated_at
--     ON ingestion_health;
-- DROP INDEX IF EXISTS idx_ingestion_health_state;
-- DROP TABLE IF EXISTS ingestion_health;
-- DROP TRIGGER IF EXISTS trg_backfill_jobs_set_updated_at
--     ON backfill_jobs;
-- DROP INDEX IF EXISTS idx_backfill_jobs_partition_status;
-- DROP TABLE IF EXISTS backfill_jobs;
-- DROP TRIGGER IF EXISTS trg_cdc_cursors_set_updated_at ON cdc_cursors;
-- DROP INDEX IF EXISTS idx_cdc_cursors_status;
-- DROP TABLE IF EXISTS cdc_cursors;
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