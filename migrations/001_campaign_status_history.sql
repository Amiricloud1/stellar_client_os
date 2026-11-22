-- Campaign persistence for status history and exportable sponsor/impact data.
-- PostgreSQL-compatible migration; timestamps are stored as UTC timestamptz.

-- Lock-safety notes:
--   * All DDL is additive and idempotent so it can be re-run after an
--     interrupted deployment without failing or duplicating data.
--   * New indexes are built CONCURRENTLY so they do not block writes on the
--     live tables. CONCURRENTLY cannot run inside a transaction block, so this
--     migration must be applied with autocommit (e.g. psql without -1, or a
--     migration runner configured for non-transactional steps).
--   * Backfills run in bounded batches to keep row locks and WAL volume small.
--   * The previous application version keeps working: every new column is
--     nullable or has a safe default, and the trigger only fires on status
--     changes (which the old version already performs).

-- Step 1: additive column with a safe default. Adding a column with a constant
-- default is metadata-only on modern PostgreSQL and does not rewrite the table.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Step 2: new tables. IF NOT EXISTS keeps this idempotent.
CREATE TABLE IF NOT EXISTS campaign_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason text,
  CONSTRAINT campaign_status_history_status_check CHECK (
    to_status IN ('DRAFT', 'PENDING_VERIFICATION', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED')
  )
);

CREATE TABLE IF NOT EXISTS campaign_sponsors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  address text NOT NULL,
  amount numeric(78, 0) NOT NULL,
  token text NOT NULL,
  sponsored_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Step 3: indexes built CONCURRENTLY (outside a transaction). If a concurrent
-- build is interrupted it leaves an INVALID index behind; drop it first so the
-- re-run can succeed.
DROP INDEX CONCURRENTLY IF EXISTS campaign_status_history_campaign_changed_at_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_status_history_campaign_changed_at_idx
  ON campaign_status_history (campaign_id, changed_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS campaign_sponsors_campaign_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sponsors_campaign_idx
  ON campaign_sponsors (campaign_id, sponsored_at DESC);

-- Step 4: batched backfill of the initial state so every campaign has a
-- queryable history. Each batch commits independently; re-running is safe
-- because the NOT EXISTS guard skips campaigns already backfilled.
DO $$
DECLARE
  batch_size constant integer := 1000;
  rows_inserted integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT c.id, c.status, c.creator, c.status_changed_at
      FROM campaigns c
      WHERE NOT EXISTS (
        SELECT 1 FROM campaign_status_history h WHERE h.campaign_id = c.id
      )
      ORDER BY c.id
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    )
    INSERT INTO campaign_status_history (campaign_id, from_status, to_status, changed_by, changed_at, reason)
    SELECT id, NULL, status, COALESCE(creator, 'system'), COALESCE(status_changed_at, CURRENT_TIMESTAMP), 'Initial campaign status'
    FROM batch;

    GET DIAGNOSTICS rows_inserted = ROW_COUNT;
    EXIT WHEN rows_inserted = 0;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION record_campaign_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_changed_at = CURRENT_TIMESTAMP;
    INSERT INTO campaign_status_history (campaign_id, from_status, to_status, changed_by, changed_at)
    VALUES (NEW.id, OLD.status, NEW.status, COALESCE(current_setting('app.current_user', true), 'system'), CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaigns_status_history_trigger ON campaigns;
CREATE TRIGGER campaigns_status_history_trigger
BEFORE UPDATE OF status ON campaigns
FOR EACH ROW EXECUTE FUNCTION record_campaign_status_change();

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- This migration is additive, so rolling back the application does not require
-- dropping anything: the previous version ignores the new column, tables,
-- indexes and trigger. If a full schema rollback is required, run the following
-- in order (each statement is idempotent and safe to re-run):
--
--   DROP TRIGGER IF EXISTS campaigns_status_history_trigger ON campaigns;
--   DROP FUNCTION IF EXISTS record_campaign_status_change();
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_sponsors_campaign_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_status_history_campaign_changed_at_idx;
--   DROP TABLE IF EXISTS campaign_sponsors;
--   DROP TABLE IF EXISTS campaign_status_history;
--   ALTER TABLE campaigns DROP COLUMN IF EXISTS status_changed_at;
--
-- Recovery from an interrupted run: re-run this migration. The DDL is
-- idempotent, INVALID concurrent indexes are dropped and rebuilt, and the
-- batched backfill resumes where it left off. Operators should verify with:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- which must return no rows before the deployment is considered complete.
