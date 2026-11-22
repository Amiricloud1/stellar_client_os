-- Campaign sequel/franchise persistence for linking related and
-- follow-up campaigns. PostgreSQL-compatible; idempotent and lock-safe.
--
-- Sequels are directed edges (source -> target) so creators can model
-- series ("part 2 continues part 1"), prequels, spin-offs, and loose
-- universe references. Edges can be grouped into named franchises.
--
-- STAGED / LOCK-SAFE MIGRATION NOTES
-- ----------------------------------
-- This file is split into numbered stages so it can be re-run safely and so
-- each stage can be applied independently during a rolling deploy where old
-- and new application versions run side by side.
--
--   Stage 1  create tables (no data backfill, no blocking validation)
--   Stage 2  build indexes CONCURRENTLY (outside a transaction)
--   Stage 3  attach CHECK/UNIQUE constraints as NOT VALID, then validate
--   Stage 4  seed demo data (idempotent)
--
-- Compatibility with overlapping application versions:
--   * New tables are additive. Old application versions never reference
--     campaign_series / campaign_sequels, so they keep working unchanged.
--   * New application versions must tolerate the tables existing but being
--     empty, and must tolerate constraints being present-but-NOT-VALID
--     (rows written by the new version are still checked; only pre-existing
--     rows are exempt until Stage 3 validation completes).
--   * No column is dropped or renamed, so a rollback to the previous
--     application version requires no schema change.
--
-- Operational guidance:
--   * Run Stage 2 with CREATE INDEX CONCURRENTLY outside any explicit
--     transaction (psql: run each statement on its own, or use
--     `psql -f` without wrapping in BEGIN/COMMIT). CONCURRENTLY cannot run
--     inside a transaction block.
--   * If a CONCURRENTLY build is interrupted it leaves an INVALID index;
--     drop it (see rollback section) and re-run the stage. The IF NOT EXISTS
--     guard does not detect INVALID indexes, so recovery is explicit.
--   * Stage 3 validation takes only a SHARE UPDATE EXCLUSIVE lock and does
--     not block reads or writes. If validation fails, the constraint stays
--     NOT VALID; fix the offending rows and re-run the VALIDATE statement.
--
-- ROLLBACK
-- --------
-- Rollback is safe at any stage because nothing existing is mutated:
--
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_sequels_source_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_sequels_target_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_sequels_series_idx;
--   DROP TABLE IF EXISTS campaign_sequels;
--   DROP TABLE IF EXISTS campaign_series;
--
-- (Drop campaign_sequels before campaign_series because of the FK.)

-- ===========================================================================
-- Stage 1: tables (additive, no locks on existing tables beyond catalog)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS campaign_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  creator text NOT NULL,
  organization text,
  cover_image_url text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_sequels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  target_campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'SEQUEL',
  sort_order int,
  series_id uuid REFERENCES campaign_series(id) ON DELETE SET NULL,
  notes text,
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ===========================================================================
-- Stage 2: indexes (CONCURRENTLY; run outside a transaction block)
-- ===========================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sequels_source_idx
  ON campaign_sequels (source_campaign_id, relation, sort_order);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sequels_target_idx
  ON campaign_sequels (target_campaign_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_sequels_series_idx
  ON campaign_sequels (series_id);

-- ===========================================================================
-- Stage 3: constraints (NOT VALID first, then VALIDATE separately)
-- ===========================================================================
-- Adding a constraint as NOT VALID takes only a brief lock and does not scan
-- the table. VALIDATE CONSTRAINT scans without blocking reads/writes. Both
-- statements are idempotent: re-adding an existing constraint is a no-op via
-- the DO block guards, and re-validating an already-valid constraint is a
-- no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_sequels_relation_check'
      AND conrelid = 'campaign_sequels'::regclass
  ) THEN
    ALTER TABLE campaign_sequels
      ADD CONSTRAINT campaign_sequels_relation_check CHECK (
        relation IN ('SEQUEL', 'PREQUEL', 'SPINOFF', 'RELATED')
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_sequels_distinct_check'
      AND conrelid = 'campaign_sequels'::regclass
  ) THEN
    ALTER TABLE campaign_sequels
      ADD CONSTRAINT campaign_sequels_distinct_check CHECK (
        source_campaign_id <> target_campaign_id
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_sequels_unique_pair'
      AND conrelid = 'campaign_sequels'::regclass
  ) THEN
    ALTER TABLE campaign_sequels
      ADD CONSTRAINT campaign_sequels_unique_pair UNIQUE (
        source_campaign_id, target_campaign_id
      ) NOT VALID;
  END IF;
END $$;

-- Validate the constraints. Each VALIDATE is a no-op if already valid and
-- only takes SHARE UPDATE EXCLUSIVE, so it will not block reads or writes.
-- If validation fails, the constraint remains NOT VALID; fix the offending
-- rows and re-run the corresponding VALIDATE statement.
ALTER TABLE campaign_sequels
  VALIDATE CONSTRAINT campaign_sequels_relation_check;
ALTER TABLE campaign_sequels
  VALIDATE CONSTRAINT campaign_sequels_distinct_check;
ALTER TABLE campaign_sequels
  VALIDATE CONSTRAINT campaign_sequels_unique_pair;

-- ===========================================================================
-- Stage 4: seed demo data (idempotent)
-- ===========================================================================

-- Seed a default universe for the demo campaigns so the "next in series"
-- surface has content out of the box. Idempotent via ON CONFLICT / NOT EXISTS
-- so re-running the migration after a partial failure is safe.
INSERT INTO campaign_series (id, name, description, creator)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Eco Guardians',
  'Community-led conservation franchise.',
  'GD6W...X892'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO campaign_sequels (
  id, source_campaign_id, target_campaign_id, relation, sort_order, series_id, linked_by
)
SELECT
  '00000000-0000-0000-0000-000000000002',
  c1.id, c2.id, 'SEQUEL', 1, '00000000-0000-0000-0000-000000000001', 'GD6W...X892'
FROM campaigns c1, campaigns c2
WHERE c1.name = 'Save the Amazon RainForest Reserve'
  AND c2.name = 'Amazon Guardian Program'
  AND NOT EXISTS (
    SELECT 1 FROM campaign_sequels
    WHERE source_campaign_id = c1.id AND target_campaign_id = c2.id
  );