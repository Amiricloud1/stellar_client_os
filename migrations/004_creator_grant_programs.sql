-- Creator grant programs: platform-funded matching for underrepresented
-- creators. PostgreSQL-compatible; idempotent and lock-safe.
--
-- A grant_program reserves a pool funded by platform profits. A matching
-- allocation matches the first `matchPercentage`% of a qualifying campaign's
-- funds, capped per campaign (per_campaign_cap) and by the remaining pool.
--
-- STAGED / LOCK-SAFE MIGRATION
-- ----------------------------
-- This migration is split into stages so it can run while old and new
-- application versions overlap during a rolling deploy, and so an interrupted
-- deployment can be resumed or rolled back safely.
--
--   Stage 1 (this file, forward): create tables and constraints. All DDL is
--     additive and idempotent (IF NOT EXISTS / guarded constraint adds), so
--     re-running after a partial failure is safe. No existing table is
--     rewritten and no long-lived exclusive lock is taken on hot tables.
--
--   Stage 2 (this file, forward): build indexes CONCURRENTLY so writes to
--     grant_programs / grant_allocations are never blocked. CONCURRENT index
--     builds cannot run inside a transaction block; run each statement
--     separately (see docs/migrations.md). If a build is interrupted it leaves
--     an INVALID index; the guarded DROP + CREATE below recovers it.
--
--   Stage 3 (this file, forward): validate deferred constraints. Constraints
--     are added NOT VALID first (cheap, no full-table scan under lock) and then
--     VALIDATED, which only takes a SHARE UPDATE EXCLUSIVE lock.
--
-- COMPATIBILITY WITH OVERLAPPING APP VERSIONS
-- -------------------------------------------
-- * Old app versions never reference these tables, so additive creation is
--   invisible to them.
-- * New app versions tolerate the tables existing without indexes/validated
--   constraints (queries remain correct, just potentially slower) and tolerate
--   the tables being absent only if the feature flag is off. Deploy order:
--   run this migration to completion, then enable the feature flag, then roll
--   out the new app version.
-- * No column is dropped or renamed, so a rollback of the app version does not
--   require a schema rollback.
--
-- ROLLBACK
-- --------
-- See migrations/004_creator_grant_programs.down.sql. It drops objects in
-- reverse dependency order and is safe to run at any stage (including after a
-- partial forward run) because every statement is IF EXISTS.

-- ===========================================================================
-- Stage 1: tables and (NOT VALID) constraints.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS grant_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  match_percentage int NOT NULL DEFAULT 10,
  per_campaign_cap numeric(78, 0) NOT NULL DEFAULT 0,
  total_pool numeric(78, 0) NOT NULL,
  allocated numeric(78, 0) NOT NULL DEFAULT 0,
  eligibility_criteria text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add CHECK constraints NOT VALID so the ALTER does not scan the table under
-- an exclusive lock; Stage 3 validates them. Guarded so re-runs are no-ops.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'grant_programs_match_percentage_check'
      AND conrelid = 'grant_programs'::regclass
  ) THEN
    ALTER TABLE grant_programs
      ADD CONSTRAINT grant_programs_match_percentage_check
      CHECK (match_percentage BETWEEN 1 AND 50) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'grant_programs_status_check'
      AND conrelid = 'grant_programs'::regclass
  ) THEN
    ALTER TABLE grant_programs
      ADD CONSTRAINT grant_programs_status_check
      CHECK (status IN ('OPEN', 'PAUSED', 'CLOSED')) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS grant_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  base_contribution numeric(78, 0) NOT NULL,
  matched_amount numeric(78, 0) NOT NULL,
  allocated_by text NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Foreign keys added NOT VALID (no scan under lock); validated in Stage 3.
-- ON DELETE CASCADE behavior is unchanged from the original migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'grant_allocations_program_id_fkey'
      AND conrelid = 'grant_allocations'::regclass
  ) THEN
    ALTER TABLE grant_allocations
      ADD CONSTRAINT grant_allocations_program_id_fkey
      FOREIGN KEY (program_id) REFERENCES grant_programs(id) ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'grant_allocations_campaign_id_fkey'
      AND conrelid = 'grant_allocations'::regclass
  ) THEN
    ALTER TABLE grant_allocations
      ADD CONSTRAINT grant_allocations_campaign_id_fkey
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

-- ===========================================================================
-- Stage 2: indexes built CONCURRENTLY.
-- Each statement must run OUTSIDE a transaction block. A failed concurrent
-- build leaves an INVALID index; drop it first so the rebuild can succeed.
-- ===========================================================================

DROP INDEX CONCURRENTLY IF EXISTS grant_programs_status_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS grant_programs_status_idx
  ON grant_programs (status);

DROP INDEX CONCURRENTLY IF EXISTS grant_allocations_program_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS grant_allocations_program_idx
  ON grant_allocations (program_id, allocated_at DESC);

DROP INDEX CONCURRENTLY IF EXISTS grant_allocations_campaign_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS grant_allocations_campaign_idx
  ON grant_allocations (campaign_id, allocated_at DESC);

-- ===========================================================================
-- Stage 3: validate deferred constraints (SHARE UPDATE EXCLUSIVE lock only).
-- Safe to re-run: VALIDATE on an already-valid constraint is a no-op.
-- ===========================================================================

ALTER TABLE grant_programs
  VALIDATE CONSTRAINT grant_programs_match_percentage_check;
ALTER TABLE grant_programs
  VALIDATE CONSTRAINT grant_programs_status_check;
ALTER TABLE grant_allocations
  VALIDATE CONSTRAINT grant_allocations_program_id_fkey;
ALTER TABLE grant_allocations
  VALIDATE CONSTRAINT grant_allocations_campaign_id_fkey;