-- Migration: Atomic Projections and Ledger Cursors (Issue #3)
-- Purpose: Enable atomic writes of ledger cursors with projections to prevent
--          gaps and duplicates after process failure, and track which ledger
--          sequence each projection was derived from.

-- ===== Phase 1: Projection Ledger State Table =====
-- Tracks which operations have been applied and at which ledger sequence
-- Each projection can checkpoint its derivation point atomically

CREATE TABLE IF NOT EXISTS projection_ledger_state (
  -- Primary identifier
  projection_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Projection identity
  projection_type VARCHAR(64) NOT NULL,
  -- Examples: 'campaign-progress', 'event-aggregation', 'sponsorship-reconciliation'
  
  resource_id VARCHAR(256) NOT NULL,
  -- The entity being projected (campaign_id, stream_id, etc)
  
  network VARCHAR(64) NOT NULL,
  -- Network where ledger events came from (testnet, mainnet, futurenet)
  -- Maps to NetworkPassphrase like 'Test SDF Network ; September 2015'

  -- Ledger provenance
  ledger_sequence BIGINT NOT NULL,
  -- Last ledger sequence that contributed to this projection state
  -- Used to detect gaps after resume: next fetch should start at ledger_sequence + 1
  
  ledger_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  -- Consensus timestamp of the ledger that created this projection state
  -- Enables recency checks and temporal ordering
  
  checkpoint_hash VARCHAR(256) NOT NULL,
  -- Cryptographic hash (SHA-256) of the projection content at this ledger
  -- Used to detect corruption after crash (no guarantees, but helps verify integrity)
  -- Format: hex-encoded SHA-256 digest
  
  -- Metadata
  events_processed INTEGER NOT NULL DEFAULT 0,
  -- Count of distinct events that contributed to this projection
  
  gaps_detected BOOLEAN NOT NULL DEFAULT FALSE,
  -- Flag: were gaps detected during replay? Used for alerting.
  -- If TRUE, projection may be incomplete and should be rebuilt from authoritative source.
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Indexes for common queries
  CONSTRAINT projection_ledger_state_pkey PRIMARY KEY (projection_id),
  CONSTRAINT projection_type_resource_network_uq UNIQUE (projection_type, resource_id, network),
  -- One canonical projection state per (type, resource, network) combination
  
  CHECK (projection_type IS NOT NULL AND projection_type != ''),
  CHECK (resource_id IS NOT NULL AND resource_id != ''),
  CHECK (network IS NOT NULL AND network != ''),
  CHECK (ledger_sequence >= 0),
  CHECK (checkpoint_hash IS NOT NULL AND LENGTH(checkpoint_hash) = 64)
  -- SHA-256 hex is exactly 64 chars
);

CREATE INDEX IF NOT EXISTS idx_projection_ledger_state_resource_network 
  ON projection_ledger_state(resource_id, network, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_projection_ledger_state_type_network 
  ON projection_ledger_state(projection_type, network, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_projection_ledger_state_gaps_detected 
  ON projection_ledger_state(network, gaps_detected)
  WHERE gaps_detected = TRUE;
-- Index to quickly find projections with detected gaps for alerting

-- ===== Phase 2: Projection Content Table =====
-- Stores versioned snapshot of projection content tied to ledger state
-- Allows recovery/auditing of projection history

CREATE TABLE IF NOT EXISTS projection_snapshots (
  -- Primary identifier
  snapshot_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Reference to projection state
  projection_id UUID NOT NULL REFERENCES projection_ledger_state(projection_id) ON DELETE CASCADE,
  
  -- Snapshot content (JSONB for efficient queries if needed)
  content JSONB NOT NULL,
  
  -- Metadata
  content_hash VARCHAR(256) NOT NULL,
  -- SHA-256 of content, must match projection_ledger_state.checkpoint_hash
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT projection_snapshots_pkey PRIMARY KEY (snapshot_id),
  CONSTRAINT projection_id_unique_latest UNIQUE (projection_id)
  -- Only one snapshot per projection at any time (replace on new checkpoint)
);

CREATE INDEX IF NOT EXISTS idx_projection_snapshots_projection_id
  ON projection_snapshots(projection_id);

-- ===== Phase 3: Extend CDC Cursors for Per-Network Coverage =====
-- Enhance cdc_cursors to track coverage per network and detect gaps

ALTER TABLE IF EXISTS cdc_cursors
  ADD COLUMN IF NOT EXISTS network VARCHAR(64) DEFAULT 'mainnet',
  ADD COLUMN IF NOT EXISTS ledger_range_start BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ledger_range_end BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gap_detected BOOLEAN DEFAULT FALSE;

-- Drop old primary key if it exists (single-column)
ALTER TABLE IF EXISTS cdc_cursors DROP CONSTRAINT IF EXISTS cdc_cursors_pkey CASCADE;

-- Add new composite primary key
ALTER TABLE IF EXISTS cdc_cursors
  ADD PRIMARY KEY (indexer_id, network);

-- Add check constraint for ledger ranges
ALTER TABLE IF EXISTS cdc_cursors
  ADD CONSTRAINT cdc_cursors_ledger_range_check 
    CHECK (ledger_range_end >= ledger_range_start);

-- Add constraint for network names
ALTER TABLE IF EXISTS cdc_cursors
  ADD CONSTRAINT cdc_cursors_network_check 
    CHECK (network IS NOT NULL AND network != '');

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cdc_cursors_network_updated
  ON cdc_cursors(network, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cdc_cursors_gap_detected
  ON cdc_cursors(network, gap_detected)
  WHERE gap_detected = TRUE;

-- ===== Phase 4: Ledger Gap Detection Log =====
-- Audit trail of gaps detected during indexing/projection
-- Used for forensics and triggering re-indexing

CREATE TABLE IF NOT EXISTS ledger_gap_audit (
  -- Primary identifier
  gap_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Which indexer/projection detected the gap
  detected_by VARCHAR(128) NOT NULL,
  -- Examples: 'cdc-indexer', 'campaign-progress-cache', 'event-aggregator'
  
  network VARCHAR(64) NOT NULL,
  
  -- Gap specification
  expected_ledger BIGINT NOT NULL,
  -- Ledger we expected to see next
  
  actual_ledger BIGINT NOT NULL,
  -- First ledger actually received after gap
  
  gap_size BIGINT NOT NULL GENERATED ALWAYS AS (actual_ledger - expected_ledger) STORED,
  
  -- Metadata
  detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE,
  -- Set when gap is filled via re-indexing
  
  resolution_type VARCHAR(64),
  -- 'reindex', 'skip', 'snapshot', or NULL if unresolved
  
  details JSONB,
  -- Additional context (error messages, affected resources, etc)
  
  CONSTRAINT ledger_gap_audit_pkey PRIMARY KEY (gap_id),
  CHECK (expected_ledger >= 0),
  CHECK (actual_ledger >= 0),
  CHECK (actual_ledger > expected_ledger)
);

CREATE INDEX IF NOT EXISTS idx_ledger_gap_audit_network_resolved
  ON ledger_gap_audit(network, resolved_at)
  WHERE resolved_at IS NULL;
-- Find unresolved gaps for alerting

CREATE INDEX IF NOT EXISTS idx_ledger_gap_audit_detected_by_network
  ON ledger_gap_audit(detected_by, network, detected_at DESC);

-- ===== Phase 5: Trigger to Auto-Update Projection Ledger State =====
-- Automatically update the updated_at timestamp when projection state changes

CREATE OR REPLACE FUNCTION update_projection_ledger_state_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_projection_ledger_state_timestamp 
  ON projection_ledger_state;

CREATE TRIGGER trigger_update_projection_ledger_state_timestamp
BEFORE UPDATE ON projection_ledger_state
FOR EACH ROW
EXECUTE FUNCTION update_projection_ledger_state_timestamp();

-- ===== Phase 6: Helper Functions for Atomic Projection Updates =====

-- Function: Record a projection state checkpoint atomically
-- This should be called in the same transaction as the projection update
CREATE OR REPLACE FUNCTION record_projection_checkpoint(
  p_projection_type VARCHAR,
  p_resource_id VARCHAR,
  p_network VARCHAR,
  p_ledger_sequence BIGINT,
  p_ledger_timestamp TIMESTAMP WITH TIME ZONE,
  p_checkpoint_hash VARCHAR,
  p_content JSONB,
  p_events_processed INTEGER DEFAULT 0,
  p_gaps_detected BOOLEAN DEFAULT FALSE
)
RETURNS UUID AS $$
DECLARE
  v_projection_id UUID;
BEGIN
  -- Upsert projection ledger state
  INSERT INTO projection_ledger_state (
    projection_type,
    resource_id,
    network,
    ledger_sequence,
    ledger_timestamp,
    checkpoint_hash,
    events_processed,
    gaps_detected,
    created_at,
    updated_at
  )
  VALUES (
    p_projection_type,
    p_resource_id,
    p_network,
    p_ledger_sequence,
    p_ledger_timestamp,
    p_checkpoint_hash,
    p_events_processed,
    p_gaps_detected,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (projection_type, resource_id, network)
  DO UPDATE SET
    ledger_sequence = EXCLUDED.ledger_sequence,
    ledger_timestamp = EXCLUDED.ledger_timestamp,
    checkpoint_hash = EXCLUDED.checkpoint_hash,
    events_processed = EXCLUDED.events_processed,
    gaps_detected = EXCLUDED.gaps_detected,
    updated_at = CURRENT_TIMESTAMP
  RETURNING projection_id INTO v_projection_id;
  
  -- Upsert projection snapshot
  INSERT INTO projection_snapshots (
    projection_id,
    content,
    content_hash,
    created_at
  )
  VALUES (
    v_projection_id,
    p_content,
    p_checkpoint_hash,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (projection_id)
  DO UPDATE SET
    content = EXCLUDED.content,
    content_hash = EXCLUDED.content_hash,
    created_at = CURRENT_TIMESTAMP;
  
  RETURN v_projection_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Detect and record ledger gaps
CREATE OR REPLACE FUNCTION detect_and_record_gap(
  p_detected_by VARCHAR,
  p_network VARCHAR,
  p_expected_ledger BIGINT,
  p_actual_ledger BIGINT,
  p_details JSONB DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_gap_id UUID;
BEGIN
  IF p_actual_ledger <= p_expected_ledger THEN
    RAISE EXCEPTION 'actual_ledger must be greater than expected_ledger';
  END IF;
  
  INSERT INTO ledger_gap_audit (
    detected_by,
    network,
    expected_ledger,
    actual_ledger,
    detected_at,
    details
  )
  VALUES (
    p_detected_by,
    p_network,
    p_expected_ledger,
    p_actual_ledger,
    CURRENT_TIMESTAMP,
    p_details
  )
  RETURNING gap_id INTO v_gap_id;
  
  -- Mark projection states with this network as having gaps
  UPDATE projection_ledger_state
  SET gaps_detected = TRUE, updated_at = CURRENT_TIMESTAMP
  WHERE network = p_network AND gaps_detected = FALSE;
  
  -- Mark CDC cursor with gap detection flag
  UPDATE cdc_cursors
  SET gap_detected = TRUE, updated_at = CURRENT_TIMESTAMP
  WHERE network = p_network AND gap_detected = FALSE;
  
  RETURN v_gap_id;
END;
$$ LANGUAGE plpgsql;

-- ===== Phase 7: Cleanup for Missing Columns in cdc_cursors =====
-- If cdc_cursors doesn't exist yet, create it with the new schema

CREATE TABLE IF NOT EXISTS cdc_cursors (
  indexer_id VARCHAR(128) NOT NULL,
  network VARCHAR(64) NOT NULL DEFAULT 'mainnet',
  last_ledger BIGINT NOT NULL,
  ledger_range_start BIGINT NOT NULL DEFAULT 0,
  ledger_range_end BIGINT NOT NULL DEFAULT 0,
  gap_detected BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  PRIMARY KEY (indexer_id, network),
  CHECK (network IS NOT NULL AND network != ''),
  CHECK (ledger_range_end >= ledger_range_start)
);

-- Grant permissions (adjust roles as needed for your deployment)
-- GRANT SELECT, INSERT, UPDATE ON projection_ledger_state TO app_role;
-- GRANT SELECT, INSERT ON projection_snapshots TO app_role;
-- GRANT SELECT, INSERT, UPDATE ON cdc_cursors TO app_role;
-- GRANT SELECT, INSERT ON ledger_gap_audit TO app_role;

-- ===== Documentation / Usage Notes =====
--
-- ATOMIC PROJECTION UPDATE PATTERN:
--
-- BEGIN TRANSACTION;
--
-- -- Update your derived state (campaign progress, event aggregation, etc)
-- UPDATE campaigns SET progress = NEW_VALUE WHERE id = campaign_id;
--
-- -- Record checkpoint atomically in same transaction
-- SELECT record_projection_checkpoint(
--   'campaign-progress',
--   campaign_id,
--   'testnet',
--   latest_ledger_sequence,
--   latest_ledger_timestamp,
--   compute_hash(NEW_VALUE),
--   jsonb_build_object('progress', NEW_VALUE),
--   1
-- );
--
-- COMMIT;
--
-- ON RESUME AFTER CRASH:
--
-- 1. SELECT ledger_sequence FROM projection_ledger_state 
--    WHERE projection_type = ? AND resource_id = ? AND network = ?;
-- 2. If found, start next fetch at ledger_sequence + 1
-- 3. If received_ledger > expected_ledger + 1, call detect_and_record_gap()
-- 4. Rebuild projections for any rows where gaps_detected = TRUE
--
