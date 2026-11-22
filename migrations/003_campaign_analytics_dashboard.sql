-- Campaign analytics persistence for the creator analytics dashboard.
-- PostgreSQL-compatible; idempotent and lock-safe.
--
-- Vertex metrics (views/contributions/refunds) already live in
-- campaign_status_history / campaign_sponsors. These tables add the daily
-- funding trend, traffic-source attribution, and conversion funnel steps
-- needed to render the full creator dashboard.
--
-- Lock-safety / rollback notes
-- ----------------------------
-- * Every statement is idempotent (IF NOT EXISTS) so an interrupted run can be
--   re-executed from the top without manual cleanup.
-- * Indexes are built with CREATE INDEX CONCURRENTLY so writers are not blocked
--   while the index is populated. CONCURRENTLY cannot run inside a transaction
--   block: run this file with autocommit (psql without -1, or one statement per
--   transaction in the migration runner). If a CONCURRENTLY build is
--   interrupted it leaves an INVALID index behind; the recovery step below
--   drops and rebuilds it.
-- * New columns are added additively with defaults so older application
--   versions that do not reference them keep working during a rolling deploy.
-- * Rollback: see the "Rollback" section at the bottom of this file. Dropping
--   the analytics tables is safe because no other table references them and
--   the dashboard degrades to empty metrics rather than erroring.

-- ---------------------------------------------------------------------------
-- Stage 1: tables (additive, no locks on existing tables beyond catalog writes)
-- ---------------------------------------------------------------------------

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
-- Stage 2: additive columns with defaults (safe for overlapping app versions)
-- ---------------------------------------------------------------------------
-- Added in a later revision of the dashboard. Older app versions ignore these
-- columns; newer versions read them. Defaults keep existing rows valid without
-- a table rewrite on modern PostgreSQL (constant defaults are metadata-only).

ALTER TABLE campaign_daily_analytics
  ADD COLUMN IF NOT EXISTS refunds int NOT NULL DEFAULT 0;
ALTER TABLE campaign_daily_analytics
  ADD COLUMN IF NOT EXISTS unique_contributors int NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Stage 3: indexes (CONCURRENTLY, outside any transaction block)
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_traffic_sources_campaign_idx
  ON campaign_traffic_sources (campaign_id, viewed_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_traffic_sources_source_idx
  ON campaign_traffic_sources (source, viewed_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_funnel_steps_campaign_idx
  ON campaign_funnel_steps (campaign_id, stage, stepped_at DESC);

-- ---------------------------------------------------------------------------
-- Interrupted-deployment recovery
-- ---------------------------------------------------------------------------
-- If a CONCURRENTLY index build was interrupted it may exist in an INVALID
-- state. Detect and repair before re-running the migration:
--
--   SELECT c.relname
--     FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE NOT i.indisvalid;
--
-- For each invalid index, drop it and let the CREATE INDEX CONCURRENTLY
-- statements above rebuild it:
--
--   DROP INDEX CONCURRENTLY IF EXISTS <invalid_index_name>;
--
-- Re-running this file is safe: tables and columns use IF NOT EXISTS and the
-- index builds are idempotent.

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- To roll back this migration (e.g. after a failed deploy), run:
--
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_funnel_steps_campaign_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_traffic_sources_source_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_traffic_sources_campaign_idx;
--   DROP TABLE IF EXISTS campaign_daily_analytics;
--   DROP TABLE IF EXISTS campaign_funnel_steps;
--   DROP TABLE IF EXISTS campaign_traffic_sources;
--
-- Dropping the tables cascades to their indexes and is safe because nothing
-- else references them. The dashboard renders empty metrics until the
-- migration is re-applied.
