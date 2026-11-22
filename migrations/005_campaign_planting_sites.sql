-- Campaign geolocation: GPS coordinates for planting sites (v1)
--
-- Stores the GPS coordinates of each campaign's planting site(s) and the
-- species planted there, so the global planting map can show every active
-- planting location with tree counts and a species breakdown.
--
-- PostgreSQL-compatible; idempotent; lock-safe and rollback-aware.
--
-- Lock safety
-- -----------
-- * Every statement is guarded with IF NOT EXISTS so the migration can be
--   re-run after an interrupted deployment without failing.
-- * Tables are created without any long-lived exclusive locks on existing
--   tables: the only reference to `campaigns` is a foreign key, which takes
--   a SHARE ROW EXCLUSIVE lock on `campaigns` for the duration of the
--   statement only (no table rewrite, no data backfill).
-- * Indexes are created CONCURRENTLY so writes to the new tables (and to
--   `campaigns` via the FK) are never blocked. CONCURRENTLY cannot run
--   inside a transaction block, so this file must be applied with
--   autocommit enabled (e.g. `psql -f`, or a migration runner configured
--   with `transaction: false` / `noTransaction`). If a concurrent index
--   build is interrupted it leaves an INVALID index behind; the
--   `IF NOT EXISTS` guard would then skip it, so recovery requires the
--   explicit cleanup documented below.
--
-- Compatibility
-- -------------
-- * Purely additive: new tables and indexes only. Application versions
--   that predate this migration are unaffected because they never read or
--   write these tables.
-- * Newer application versions must tolerate the tables being absent (the
--   migration not yet applied) and the indexes being absent or INVALID
--   (concurrent build in progress or interrupted). Reads should degrade to
--   an empty result set rather than erroring.
-- * Deploy order: apply this migration before rolling out code that reads
--   the planting map. Rolling back code does not require rolling back the
--   schema.
--
-- Rollback
-- --------
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_planting_species_species_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_gps_locations_geo_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS campaign_gps_locations_campaign_idx;
--   DROP TABLE IF EXISTS campaign_planting_species;
--   DROP TABLE IF EXISTS campaign_gps_locations;
--
-- Recovery from an interrupted concurrent index build
-- ---------------------------------------------------
--   REINDEX INDEX CONCURRENTLY campaign_gps_locations_campaign_idx;
--   REINDEX INDEX CONCURRENTLY campaign_gps_locations_geo_idx;
--   REINDEX INDEX CONCURRENTLY campaign_planting_species_species_idx;
-- (or DROP INDEX CONCURRENTLY <name>; and re-run this migration).

-- GPS coordinates per campaign planting site.
CREATE TABLE IF NOT EXISTS campaign_gps_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  latitude numeric(9, 6) NOT NULL
    CONSTRAINT campaign_gps_locations_latitude_check CHECK (
      latitude BETWEEN -90 AND 90
    ),
  longitude numeric(9, 6) NOT NULL
    CONSTRAINT campaign_gps_locations_longitude_check CHECK (
      longitude BETWEEN -180 AND 180
    ),
  captured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Species planted per campaign (parsed/denormalized from tree species input).
CREATE TABLE IF NOT EXISTS campaign_planting_species (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  species text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, species)
);

-- Indexes are built CONCURRENTLY (outside a transaction block) so that
-- overlapping application versions are never blocked on index creation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_gps_locations_campaign_idx
  ON campaign_gps_locations (campaign_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_gps_locations_geo_idx
  ON campaign_gps_locations (latitude, longitude);
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_planting_species_species_idx
  ON campaign_planting_species (species);