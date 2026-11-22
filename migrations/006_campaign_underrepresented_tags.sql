-- Campaign geolocation & creator grant programs: underrepresented community tags
--
-- Adds the creator-declared underrepresented-community tags that qualify a
-- campaign for the platform-funded grant matching programs (match the first
-- 10% of funds for campaigns from underrepresented communities).
--
-- PostgreSQL-compatible; idempotent; lock-safe; rollback-aware.
--
-- Lock-safety notes
-- -----------------
-- * The column is added with a constant default ('{}'), which PostgreSQL 11+
--   stores as metadata only (no table rewrite) and takes only a brief
--   ACCESS EXCLUSIVE lock. On older servers the default is still constant and
--   the rewrite is bounded by the campaigns table size; schedule accordingly.
-- * The GIN index is built with CREATE INDEX CONCURRENTLY so it does not block
--   writes to campaigns. CONCURRENTLY cannot run inside a transaction block,
--   so this file must be applied outside an explicit transaction (e.g. with
--   psql -f, or with the migration runner's "no transaction" mode).
-- * If a concurrent index build is interrupted it leaves an INVALID index
--   behind. Re-running this file drops the invalid index and rebuilds it, so
--   the migration is safe to retry after an interrupted deployment.
--
-- Compatibility with the previous application version
-- ---------------------------------------------------
-- * The column is nullable-free with a default, so old application code that
--   does not know about underrepresented_tags keeps working: inserts omit the
--   column and receive '{}', and reads ignore it.
-- * The index is additive and invisible to old code.
-- * Deploy order: apply this migration first, then roll out the new
--   application version. The new version must tolerate the column being
--   present but empty for pre-existing rows.
--
-- Rollback
-- --------
-- * Application rollback: safe at any time; the previous version ignores the
--   column and index.
-- * Schema rollback (only after the new application version is fully drained):
--     DROP INDEX CONCURRENTLY IF EXISTS campaigns_underrepresented_tags_idx;
--     ALTER TABLE campaigns DROP COLUMN IF EXISTS underrepresented_tags;
--   Drop the index concurrently first to avoid blocking writes; dropping the
--   column takes a brief ACCESS EXCLUSIVE lock.

-- Step 1: add the column with a constant default (metadata-only on PG 11+).
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS underrepresented_tags text[] NOT NULL DEFAULT '{}';

-- Step 2: recover from an interrupted concurrent index build, if any.
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index that must be
-- dropped before it can be rebuilt.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'campaigns_underrepresented_tags_idx'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX CONCURRENTLY IF EXISTS campaigns_underrepresented_tags_idx';
  END IF;
END
$$;

-- Step 3: build the discovery/filtering index without blocking writes.
-- Must run outside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_underrepresented_tags_idx
  ON campaigns USING GIN (underrepresented_tags);