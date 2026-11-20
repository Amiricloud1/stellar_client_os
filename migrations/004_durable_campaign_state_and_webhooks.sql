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
-- Contract deployment registry: durable source of truth
-- ---------------------------------------------------------------------------

-- One row per deployed contract instance. The registry is the authoritative
-- boundary for "which contract address is live on which network"; consumers
-- MUST resolve addresses through this table and fail closed if a required
-- entry is missing.
CREATE TABLE IF NOT EXISTS contract_deployments (
    id                BIGSERIAL PRIMARY KEY,
    -- Logical contract name, e.g. 'campaign_registry'.
    contract_name     TEXT NOT NULL CHECK (length(contract_name) > 0),
    -- Network identifier, e.g. 'testnet' or 'mainnet'.
    network           TEXT NOT NULL CHECK (length(network) > 0),
    -- Environment identifier, e.g. 'staging' or 'production'.
    environment       TEXT NOT NULL CHECK (length(environment) > 0),
    -- On-chain contract address (StrKey form).
    address           TEXT NOT NULL CHECK (length(address) > 0),
    -- Ledger sequence at which the deployment was observed.
    deployment_ledger BIGINT NOT NULL CHECK (deployment_ledger >= 0),
    -- Contract spec version the deployment was built against.
    spec_version      TEXT NOT NULL CHECK (length(spec_version) > 0),
    -- Lifecycle state of the deployment.
    state             TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'active', 'deprecated', 'retired')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- A given address is unique per network.
    CONSTRAINT uq_contract_deployments_network_address
        UNIQUE (network, address)
);

-- At most one active deployment per (network, environment). Partial unique
-- index so historical pending/deprecated/retired rows may coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_deployments_active_env
    ON contract_deployments (network, environment)
    WHERE state = 'active';

-- Index supporting the API's read pattern: resolve the active deployment for
-- a contract on a network/environment.
CREATE INDEX IF NOT EXISTS idx_contract_deployments_lookup
    ON contract_deployments (contract_name, network, environment, state);

DROP TRIGGER IF EXISTS trg_contract_deployments_set_updated_at
    ON contract_deployments;
CREATE TRIGGER trg_contract_deployments_set_updated_at
    BEFORE UPDATE ON contract_deployments
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Canonical contract-event domain mappings
-- ---------------------------------------------------------------------------

-- Maps a (contract, event version) pair to a projection. Unknown versions are
-- retained with is_known = false and a NULL projection so raw payloads are
-- never dropped; they surface as explicit "unknown event version" states.
CREATE TABLE IF NOT EXISTS contract_event_mappings (
    id                BIGSERIAL PRIMARY KEY,
    contract_name     TEXT NOT NULL CHECK (length(contract_name) > 0),
    -- Event schema version as observed on chain, e.g. 'v1', 'v2'.
    event_version     TEXT NOT NULL CHECK (length(event_version) > 0),
    -- Event type/topic, e.g. 'campaign_created'.
    event_type        TEXT NOT NULL CHECK (length(event_type) > 0),
    -- Projection target; NULL when the version is unknown.
    projection        TEXT,
    -- Whether this version is a supported, canonical mapping.
    is_known          BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_contract_event_mappings_version
        UNIQUE (contract_name, event_version, event_type),
    -- Known mappings must name a projection; unknown mappings must not.
    CONSTRAINT contract_event_mappings_projection_check
        CHECK (
            (is_known AND projection IS NOT NULL)
            OR (NOT is_known AND projection IS NULL)
        )
);

-- Index supporting mapping resolution during ingestion.
CREATE INDEX IF NOT EXISTS idx_contract_event_mappings_lookup
    ON contract_event_mappings (contract_name, event_version, event_type);

-- Index supporting operator queries for unknown versions awaiting mapping.
CREATE INDEX IF NOT EXISTS idx_contract_event_mappings_unknown
    ON contract_event_mappings (contract_name, event_version)
    WHERE NOT is_known;

DROP TRIGGER IF EXISTS trg_contract_event_mappings_set_updated_at
    ON contract_event_mappings;
CREATE TRIGGER trg_contract_event_mappings_set_updated_at
    BEFORE UPDATE ON contract_event_mappings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Projection replay runs
-- ---------------------------------------------------------------------------

-- Records deterministic replay runs across event-schema versions. Cutover is
-- gated on a run reaching state 'compared' with matching outputs.
CREATE TABLE IF NOT EXISTS projection_replay_runs (
    id                BIGSERIAL PRIMARY KEY,
    -- Projection being replayed, e.g. 'campaign_state'.
    projection        TEXT NOT NULL CHECK (length(projection) > 0),
    -- Event-schema version the retained raw events were produced with.
    source_version    TEXT NOT NULL CHECK (length(source_version) > 0),
    -- Event-schema version the replay targets.
    target_version    TEXT NOT NULL CHECK (length(target_version) > 0),
    -- Operator-visible lifecycle state of the run.
    state             TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN (
            'pending',
            'running',
            'compared',
            'mismatch',
            'failed',
            'cutover'
        )),
    -- Number of raw events replayed.
    events_replayed   BIGINT NOT NULL DEFAULT 0 CHECK (events_replayed >= 0),
    -- Number of projection records that differed from the live output.
    mismatches        INTEGER NOT NULL DEFAULT 0 CHECK (mismatches >= 0),
    -- Deterministic digest of the replayed output, for comparison.
    output_digest     TEXT,
    error_message     TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at       TIMESTAMPTZ,
    -- A compared run must have a digest; a mismatch must report at least one.
    CONSTRAINT projection_replay_runs_digest_check
        CHECK (state NOT IN ('compared', 'cutover') OR output_digest IS NOT NULL),
    CONSTRAINT projection_replay_runs_mismatch_check
        CHECK (state <> 'mismatch' OR mismatches > 0)
);

-- Index supporting operator queries for the latest run per projection.
CREATE INDEX IF NOT EXISTS idx_projection_replay_runs_projection
    ON projection_replay_runs (projection, started_at DESC);

-- Index supporting recovery: find runs stuck in 'running' after a crash.
CREATE INDEX IF NOT EXISTS idx_projection_replay_runs_in_flight
    ON projection_replay_runs (state, started_at)
    WHERE state IN ('pending', 'running');

-- ---------------------------------------------------------------------------
-- Consumer queue metrics: bounded queues and concurrency
-- ---------------------------------------------------------------------------

-- Periodic observations of consumer queue depth and concurrency, used to
-- prove bounded memory and recovery throughput under RPC/consumer outages.
CREATE TABLE IF NOT EXISTS consumer_queue_metrics (
    id                BIGSERIAL PRIMARY KEY,
    -- Consumer identifier, e.g. 'contract-events'.
    consumer          TEXT NOT NULL CHECK (length(consumer) > 0),
    -- Configured capacity of the bounded queue.
    queue_capacity    INTEGER NOT NULL CHECK (queue_capacity > 0),
    -- Observed queue depth; must never exceed capacity.
    queue_depth       INTEGER NOT NULL CHECK (queue_depth >= 0),
    -- Configured maximum concurrency.
    max_concurrency   INTEGER NOT NULL CHECK (max_concurrency > 0),
    -- Observed in-flight work; must never exceed max concurrency.
    in_flight         INTEGER NOT NULL CHECK (in_flight >= 0),
    -- Whether the consumer is applying backpressure.
    backpressure      BOOLEAN NOT NULL DEFAULT false,
    -- Whether the consumer is in an outage/recovery state.
    outage_state      TEXT NOT NULL DEFAULT 'healthy'
        CHECK (outage_state IN ('healthy', 'degraded', 'outage', 'recovering')),
    observed_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Boundedness invariants enforced at the authoritative boundary.
    CONSTRAINT consumer_queue_metrics_depth_check
        CHECK (queue_depth <= queue_capacity),
    CONSTRAINT consumer_queue_metrics_in_flight_check
        CHECK (in_flight <= max_concurrency)
);

-- Index supporting operator queries for the latest metrics per consumer.
CREATE INDEX IF NOT EXISTS idx_consumer_queue_metrics_consumer
    ON consumer_queue_metrics (consumer, observed_at DESC);

-- Index supporting alerting on unhealthy consumers.
CREATE INDEX IF NOT EXISTS idx_consumer_queue_metrics_unhealthy
    ON consumer_queue_metrics (consumer, observed_at DESC)
    WHERE outage_state <> 'healthy' OR backpressure;

COMMIT;

-- ---------------------------------------------------------------------------
-- DOWN (rollback) — run manually if this migration must be reverted.
-- ---------------------------------------------------------------------------
-- BEGIN;
-- DROP INDEX IF EXISTS idx_consumer_queue_metrics_unhealthy;
-- DROP INDEX IF EXISTS idx_consumer_queue_metrics_consumer;
-- DROP TABLE IF EXISTS consumer_queue_metrics;
-- DROP INDEX IF EXISTS idx_projection_replay_runs_in_flight;
-- DROP INDEX IF EXISTS idx_projection_replay_runs_projection;
-- DROP TABLE IF EXISTS projection_replay_runs;
-- DROP TRIGGER IF EXISTS trg_contract_event_mappings_set_updated_at
--     ON contract_event_mappings;
-- DROP INDEX IF EXISTS idx_contract_event_mappings_unknown;
-- DROP INDEX IF EXISTS idx_contract_event_mappings_lookup;
-- DROP TABLE IF EXISTS contract_event_mappings;
-- DROP TRIGGER IF EXISTS trg_contract_deployments_set_updated_at
--     ON contract_deployments;
-- DROP INDEX IF EXISTS idx_contract_deployments_lookup;
-- DROP INDEX IF EXISTS uq_contract_deployments_active_env;
-- DROP TABLE IF EXISTS contract_deployments;
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