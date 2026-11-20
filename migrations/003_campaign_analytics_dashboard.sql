-- Campaign analytics persistence for the creator analytics dashboard.
-- PostgreSQL-compatible; idempotent.
--
-- Vertex metrics (views/contributions/refunds) already live in
-- campaign_status_history / campaign_sponsors. These tables add the daily
-- funding trend, traffic-source attribution, and conversion funnel steps
-- needed to render the full creator dashboard.

CREATE TABLE IF NOT EXISTS campaign_traffic_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  source text NOT NULL
    CONSTRAINT campaign_traffic_sources_source_check CHECK (
      source IN ('direct', 'search', 'social', 'referral', 'newsletter')
    ),
  viewer_id text NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS campaign_traffic_sources_campaign_idx
  ON campaign_traffic_sources (campaign_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS campaign_traffic_sources_source_idx
  ON campaign_traffic_sources (source, viewed_at DESC);

CREATE TABLE IF NOT EXISTS campaign_funnel_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  stage text NOT NULL
    CONSTRAINT campaign_funnel_steps_stage_check CHECK (
      stage IN ('view', 'click_sponsor', 'contribute', 'confirm')
    ),
  viewer_id text NOT NULL,
  stepped_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS campaign_funnel_steps_campaign_idx
  ON campaign_funnel_steps (campaign_id, stage, stepped_at DESC);

CREATE TABLE IF NOT EXISTS campaign_daily_analytics (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  day date NOT NULL,
  contributions int NOT NULL DEFAULT 0,
  funded_amount numeric(78, 0) NOT NULL DEFAULT 0,
  views int NOT NULL DEFAULT 0,
  unique_viewers int NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);

-- ---------------------------------------------------------------------------
-- Incremental aggregate versioning & reconciliation (issue #227)
-- ---------------------------------------------------------------------------
--
-- Incremental aggregates are rebuilt deterministically from the event log.
-- Each aggregate row records the version of the aggregate logic that produced
-- it (`aggregate_version`), the highest event id folded in
-- (`last_processed_event_id`), when it was last compared against a full
-- recomputation (`last_reconciled_at`), and whether that comparison found a
-- mismatch (`drift_detected`).
--
-- Compatibility notes:
--   * All new columns are nullable/defaulted so existing readers keep working.
--   * Rows written before this migration have aggregate_version = 1 and
--     last_processed_event_id = NULL, meaning "not yet reconciled". They are
--     treated as stale and will be rebuilt by the reconciler.
--   * Bump AGGREGATE_VERSION in the application whenever aggregate logic
--     changes; rows with an older version are rebuilt on next reconciliation.
--
-- Reconciliation runbook:
--   1. Run the reconciler (full recomputation) for the affected campaign(s).
--   2. Rows where drift_detected = true are overwritten with the recomputed
--      totals and drift_detected is reset to false.
--   3. If drift persists across runs, halt incremental processing for that
--      campaign (see campaign_aggregate_reconciliation_state) and alert.
--   4. Recovery: after the root cause is fixed, bump aggregate_version and
--      re-run the reconciler; incremental processing resumes once a clean
--      reconciliation pass completes.

ALTER TABLE campaign_daily_analytics
  ADD COLUMN IF NOT EXISTS aggregate_version int NOT NULL DEFAULT 1;
ALTER TABLE campaign_daily_analytics
  ADD COLUMN IF NOT EXISTS last_processed_event_id bigint;
ALTER TABLE campaign_daily_analytics
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;
ALTER TABLE campaign_daily_analytics
  ADD COLUMN IF NOT EXISTS drift_detected boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS campaign_daily_analytics_drift_idx
  ON campaign_daily_analytics (campaign_id)
  WHERE drift_detected;

CREATE INDEX IF NOT EXISTS campaign_daily_analytics_version_idx
  ON campaign_daily_analytics (aggregate_version);

-- Per-campaign reconciliation state. Makes failure/recovery explicit to
-- operators: `status` is 'ok' while incremental processing is healthy,
-- 'drift' when a mismatch was detected, and 'halted' when incremental
-- processing has been stopped pending manual recovery.
CREATE TABLE IF NOT EXISTS campaign_aggregate_reconciliation_state (
  campaign_id uuid PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  aggregate_version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'ok'
    CONSTRAINT campaign_aggregate_reconciliation_state_status_check CHECK (
      status IN ('ok', 'drift', 'halted')
    ),
  last_reconciled_at timestamptz,
  last_processed_event_id bigint,
  drift_details jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS campaign_aggregate_reconciliation_state_status_idx
  ON campaign_aggregate_reconciliation_state (status)
  WHERE status <> 'ok';