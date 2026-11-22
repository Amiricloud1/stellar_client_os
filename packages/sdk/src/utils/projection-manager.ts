/**
 * Projection Manager - Atomic Ledger Cursor & Projection Persistence (Issue #3)
 *
 * Provides utilities for atomically updating projections alongside ledger cursors,
 * detecting gaps after process failures, and resuming without duplicates or gaps.
 *
 * Usage Pattern:
 * ```typescript
 * const manager = new ProjectionManager(dbPool);
 * await manager.updateProjectionWithCursor(
 *   'campaign-progress',
 *   campaignId,
 *   'testnet',
 *   latestLedger,
 *   projectionContent,
 *   computeHash(projectionContent),
 *   3
 * );
 * ```
 */

import { Pool, QueryResult } from 'pg';
import * as crypto from 'crypto';

/**
 * Represents the state of a projection at a specific ledger
 */
export interface ProjectionCheckpoint {
  projectionId: string;
  projectionType: string;
  resourceId: string;
  network: string;
  ledgerSequence: bigint;
  ledgerTimestamp: Date;
  checkpointHash: string;
  eventsProcessed: number;
  gapsDetected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Represents a detected gap in ledger coverage
 */
export interface LedgerGapRecord {
  gapId: string;
  detectedBy: string;
  network: string;
  expectedLedger: bigint;
  actualLedger: bigint;
  gapSize: bigint;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolutionType: string | null;
  details: Record<string, unknown> | null;
}

/**
 * Options for updating a projection
 */
export interface UpdateProjectionOptions {
  /** Number of distinct events that contributed to this projection */
  eventsProcessed?: number;
  /** Was a gap detected during projection derivation? */
  gapsDetected?: boolean;
}

/**
 * Result of resuming from a checkpoint
 */
export interface ResumeCheckpoint {
  found: boolean;
  checkpoint?: ProjectionCheckpoint;
  gapDetected: boolean;
  suggestedStartLedger: bigint;
}

/**
 * Service for managing atomic projection updates with ledger cursor consistency
 */
export class ProjectionManager {
  /**
   * @param pool PostgreSQL connection pool
   */
  constructor(private readonly pool: Pool) {}

  /**
   * Compute SHA-256 hash of projection content
   * @param content The projection content to hash
   * @returns hex-encoded SHA-256 digest (64 chars)
   */
  static computeHash(content: unknown): string {
    const json = typeof content === 'string' ? content : JSON.stringify(content);
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Atomically update a projection and record its ledger checkpoint
   *
   * This function:
   * 1. Updates the derived state (campaign progress, aggregation, etc)
   * 2. Records the checkpoint (ledger provenance, hash) in the same transaction
   * 3. Ensures cursor and projection always stay in sync
   *
   * @param projectionType Type of projection (e.g., 'campaign-progress')
   * @param resourceId ID of the resource being projected (campaign_id, stream_id, etc)
   * @param network Network name (testnet, mainnet, futurenet)
   * @param ledgerSequence Ledger sequence that contributed to this projection
   * @param ledgerTimestamp Consensus timestamp of the ledger
   * @param projectionContent The derived state object
   * @param contentHash SHA-256 hash of projectionContent (use computeHash() helper)
   * @param options Additional options
   * @returns ProjectionCheckpoint that was recorded
   * @throws Error if DB operation fails
   */
  async updateProjectionWithCursor(
    projectionType: string,
    resourceId: string,
    network: string,
    ledgerSequence: bigint,
    projectionContent: unknown,
    contentHash: string,
    options: UpdateProjectionOptions = {}
  ): Promise<ProjectionCheckpoint> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Call the database function that handles atomic upsert
      const result = await client.query(
        `SELECT record_projection_checkpoint(
          $1::VARCHAR, $2::VARCHAR, $3::VARCHAR, $4::BIGINT, 
          $5::TIMESTAMP WITH TIME ZONE, $6::VARCHAR, $7::JSONB,
          $8::INTEGER, $9::BOOLEAN
        ) as projection_id`,
        [
          projectionType,
          resourceId,
          network,
          ledgerSequence.toString(),
          new Date(),
          contentHash,
          projectionContent,
          options.eventsProcessed ?? 0,
          options.gapsDetected ?? false,
        ]
      );

      if (result.rows.length === 0) {
        throw new Error('Failed to record projection checkpoint');
      }

      const projectionId = result.rows[0].projection_id;

      // Fetch the recorded checkpoint to return
      const checkpointResult = await client.query(
        `SELECT * FROM projection_ledger_state WHERE projection_id = $1`,
        [projectionId]
      );

      if (checkpointResult.rows.length === 0) {
        throw new Error('Checkpoint not found after recording');
      }

      await client.query('COMMIT');

      return this.mapCheckpointRow(checkpointResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Detect and record a gap in ledger sequence
   *
   * @param detectedBy Component that detected the gap (e.g., 'cdc-indexer')
   * @param network Network name
   * @param expectedLedger The ledger sequence we expected to see
   * @param actualLedger The first ledger actually received
   * @param details Optional additional context (JSON object)
   * @returns The gap record
   */
  async recordLedgerGap(
    detectedBy: string,
    network: string,
    expectedLedger: bigint,
    actualLedger: bigint,
    details?: Record<string, unknown>
  ): Promise<LedgerGapRecord> {
    const result = await this.pool.query(
      `SELECT detect_and_record_gap($1, $2, $3, $4, $5) as gap_id`,
      [
        detectedBy,
        network,
        expectedLedger.toString(),
        actualLedger.toString(),
        details ? JSON.stringify(details) : null,
      ]
    );

    if (result.rows.length === 0) {
      throw new Error('Failed to record gap');
    }

    const gapId = result.rows[0].gap_id;
    return this.fetchGapRecord(gapId);
  }

  /**
   * Resume a projection from the last known checkpoint
   *
   * @param projectionType Type of projection
   * @param resourceId ID of the resource
   * @param network Network name
   * @returns ResumeCheckpoint with suggested start ledger
   */
  async resumeFromCheckpoint(
    projectionType: string,
    resourceId: string,
    network: string
  ): Promise<ResumeCheckpoint> {
    const result = await this.pool.query(
      `SELECT * FROM projection_ledger_state 
       WHERE projection_type = $1 AND resource_id = $2 AND network = $3`,
      [projectionType, resourceId, network]
    );

    if (result.rows.length === 0) {
      // No checkpoint found; start from beginning
      return {
        found: false,
        gapDetected: false,
        suggestedStartLedger: BigInt(0),
      };
    }

    const checkpoint = this.mapCheckpointRow(result.rows[0]);

    return {
      found: true,
      checkpoint,
      gapDetected: checkpoint.gapsDetected,
      suggestedStartLedger: checkpoint.ledgerSequence + BigInt(1),
    };
  }

  /**
   * Check for unresolved gaps and rebuild affected projections
   *
   * @param network Network to check
   * @returns Array of projections with detected gaps
   */
  async findGappedProjections(network: string): Promise<ProjectionCheckpoint[]> {
    const result = await this.pool.query(
      `SELECT * FROM projection_ledger_state 
       WHERE network = $1 AND gaps_detected = TRUE
       ORDER BY updated_at DESC`,
      [network]
    );

    return result.rows.map((row) => this.mapCheckpointRow(row));
  }

  /**
   * Mark a gap as resolved
   *
   * @param gapId ID of the gap record
   * @param resolutionType How the gap was resolved (e.g., 'reindex')
   */
  async resolveGap(gapId: string, resolutionType: string): Promise<void> {
    await this.pool.query(
      `UPDATE ledger_gap_audit 
       SET resolved_at = CURRENT_TIMESTAMP, resolution_type = $2
       WHERE gap_id = $1`,
      [gapId, resolutionType]
    );
  }

  /**
   * Get CDC cursor state for a network
   *
   * @param indexerId ID of the indexer instance
   * @param network Network name
   * @returns Current cursor state or null if not found
   */
  async getCdcCursor(
    indexerId: string,
    network: string
  ): Promise<{
    lastLedger: bigint;
    ledgerRangeStart: bigint;
    ledgerRangeEnd: bigint;
    gapDetected: boolean;
  } | null> {
    const result = await this.pool.query(
      `SELECT last_ledger, ledger_range_start, ledger_range_end, gap_detected
       FROM cdc_cursors 
       WHERE indexer_id = $1 AND network = $2`,
      [indexerId, network]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      lastLedger: BigInt(row.last_ledger),
      ledgerRangeStart: BigInt(row.ledger_range_start),
      ledgerRangeEnd: BigInt(row.ledger_range_end),
      gapDetected: row.gap_detected,
    };
  }

  /**
   * Update CDC cursor state (typically after processing a batch of events)
   *
   * @param indexerId ID of the indexer instance
   * @param network Network name
   * @param lastLedger Latest ledger processed
   * @param ledgerRangeEnd Upper bound of the range (if known)
   */
  async setCdcCursor(
    indexerId: string,
    network: string,
    lastLedger: bigint,
    ledgerRangeEnd?: bigint
  ): Promise<void> {
    const rangeEnd = ledgerRangeEnd ?? lastLedger;
    await this.pool.query(
      `INSERT INTO cdc_cursors (indexer_id, network, last_ledger, ledger_range_start, ledger_range_end, gap_detected)
       VALUES ($1, $2, $3, $4, $5, FALSE)
       ON CONFLICT (indexer_id, network)
       DO UPDATE SET 
         last_ledger = EXCLUDED.last_ledger,
         ledger_range_end = EXCLUDED.ledger_range_end,
         updated_at = CURRENT_TIMESTAMP`,
      [indexerId, network, lastLedger.toString(), '0', rangeEnd.toString()]
    );
  }

  /**
   * Detect gap at resume time
   *
   * @param indexerId ID of the indexer
   * @param network Network name
   * @param nextLedgerReceived The first ledger received after resuming
   * @param details Optional context
   */
  async detectGapAtResume(
    indexerId: string,
    network: string,
    nextLedgerReceived: bigint,
    details?: Record<string, unknown>
  ): Promise<LedgerGapRecord | null> {
    const cursor = await this.getCdcCursor(indexerId, network);
    if (!cursor) {
      return null; // No prior cursor; starting fresh
    }

    const expectedNextLedger = cursor.lastLedger + BigInt(1);
    if (nextLedgerReceived > expectedNextLedger) {
      return this.recordLedgerGap('cdc-indexer', network, expectedNextLedger, nextLedgerReceived, details);
    }

    return null; // No gap detected
  }

  /**
   * Get coverage statistics for a network
   *
   * @param network Network name
   * @returns Coverage stats
   */
  async getCoverageStats(network: string): Promise<{
    projectionCount: number;
    gappedProjections: number;
    totalGapsDetected: number;
    unresolvedGaps: number;
    lastUpdateTime: Date | null;
  }> {
    const projectionResult = await this.pool.query(
      `SELECT COUNT(*) as count, COUNT(CASE WHEN gaps_detected THEN 1 END) as gapped_count,
              MAX(updated_at) as last_update
       FROM projection_ledger_state 
       WHERE network = $1`,
      [network]
    );

    const gapResult = await this.pool.query(
      `SELECT COUNT(*) as total, COUNT(CASE WHEN resolved_at IS NULL THEN 1 END) as unresolved
       FROM ledger_gap_audit 
       WHERE network = $1`,
      [network]
    );

    const projStats = projectionResult.rows[0];
    const gapStats = gapResult.rows[0];

    return {
      projectionCount: parseInt(projStats.count, 10),
      gappedProjections: parseInt(projStats.gapped_count, 10),
      totalGapsDetected: parseInt(gapStats.total, 10),
      unresolvedGaps: parseInt(gapStats.unresolved, 10),
      lastUpdateTime: projStats.last_update ? new Date(projStats.last_update) : null,
    };
  }

  // Helper methods

  private mapCheckpointRow(row: any): ProjectionCheckpoint {
    return {
      projectionId: row.projection_id,
      projectionType: row.projection_type,
      resourceId: row.resource_id,
      network: row.network,
      ledgerSequence: BigInt(row.ledger_sequence),
      ledgerTimestamp: new Date(row.ledger_timestamp),
      checkpointHash: row.checkpoint_hash,
      eventsProcessed: row.events_processed,
      gapsDetected: row.gaps_detected,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private async fetchGapRecord(gapId: string): Promise<LedgerGapRecord> {
    const result = await this.pool.query(`SELECT * FROM ledger_gap_audit WHERE gap_id = $1`, [gapId]);

    if (result.rows.length === 0) {
      throw new Error(`Gap record not found: ${gapId}`);
    }

    const row = result.rows[0];
    return {
      gapId: row.gap_id,
      detectedBy: row.detected_by,
      network: row.network,
      expectedLedger: BigInt(row.expected_ledger),
      actualLedger: BigInt(row.actual_ledger),
      gapSize: BigInt(row.gap_size),
      detectedAt: new Date(row.detected_at),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
      resolutionType: row.resolution_type,
      details: row.details,
    };
  }
}

/**
 * Utility function to validate a projection checkpoint hash
 *
 * @param content The content to validate
 * @param expectedHash The expected hash (from database)
 * @returns true if hashes match
 */
export function validateCheckpointHash(content: unknown, expectedHash: string): boolean {
  const computed = ProjectionManager.computeHash(content);
  return computed === expectedHash;
}

/**
 * Utility to create a debug report for gap resolution
 *
 * @param gap The gap record
 * @returns Human-readable report
 */
export function formatGapReport(gap: LedgerGapRecord): string {
  const lines = [
    `Gap ID: ${gap.gapId}`,
    `Detected by: ${gap.detectedBy}`,
    `Network: ${gap.network}`,
    `Expected ledger: ${gap.expectedLedger}`,
    `First received: ${gap.actualLedger}`,
    `Gap size: ${gap.gapSize} ledgers`,
    `Detected at: ${gap.detectedAt.toISOString()}`,
    `Status: ${gap.resolvedAt ? `Resolved at ${gap.resolvedAt.toISOString()} (${gap.resolutionType})` : 'UNRESOLVED'}`,
  ];

  if (gap.details) {
    lines.push(`Details: ${JSON.stringify(gap.details, null, 2)}`);
  }

  return lines.join('\n');
}
