/**
 * Coverage Tracker - Track Contiguous Coverage Per Network (Issue #1)
 *
 * Monitors event indexing coverage per network, detects gaps, and provides
 * coverage status API for clients to assess data freshness.
 *
 * Usage:
 * ```typescript
 * const tracker = new CoverageTracker(dbPool, indexerId);
 * const status = await tracker.getCoverageStatus('testnet');
 * ```
 */

import { Pool } from 'pg';

/**
 * Represents a gap in indexed ledger coverage
 */
export interface LedgerGap {
  startLedger: bigint;
  endLedger: bigint;
  gapSize: bigint;
  detectedAt: Date;
  resolvedAt: Date | null;
}

/**
 * Coverage status for a network
 */
export interface CoverageStatus {
  /** Network name */
  network: string;

  /** Highest ledger indexed */
  indexedUpToLedger: bigint;

  /** Lowest ledger indexed */
  indexedFromLedger: bigint;

  /** Total contiguous coverage in ledgers */
  totalCoverageLedgers: bigint;

  /** Are all ledgers from indexedFromLedger to indexedUpToLedger covered? */
  isContiguous: boolean;

  /** Gaps detected in coverage */
  gaps: LedgerGap[];

  /** Unresolved gaps count */
  unresolvedGapsCount: number;

  /** When was coverage last updated? */
  lastUpdatedAt: Date | null;

  /** Estimated percentage of network history covered */
  estimatedCoveragePercent: number;

  /** Is indexing currently active for this network? */
  isActive: boolean;
}

/**
 * Bounded replay request
 */
export interface BoundedReplayRequest {
  /** Ledger sequence to start from */
  startLedger: bigint;

  /** Ledger sequence to end at (inclusive) */
  endLedger: bigint;

  /** Network */
  network: string;

  /** Authoritative source identifier (RPC URL, indexer ID, etc) */
  authoritativeSource: string;
}

/**
 * Bounded replay result
 */
export interface BoundedReplayResult {
  /** Request that was replayed */
  request: BoundedReplayRequest;

  /** Events that were replayed */
  eventCount: number;

  /** All events in the requested range */
  events: Array<{
    eventId: string;
    ledgerSequence: number;
    contractId: string;
    topics: string[];
  }>;

  /** Was the replay complete and contiguous? */
  isComplete: boolean;

  /** Any gaps detected during replay */
  gaps: LedgerGap[];

  /** Checksum of replayed events for verification */
  checksumSha256: string;

  /** When was the replay performed? */
  replayedAt: Date;
}

/**
 * Service for tracking and reporting event indexing coverage
 */
export class CoverageTracker {
  /**
   * @param pool PostgreSQL connection pool
   * @param indexerId ID of this indexer instance
   */
  constructor(
    private readonly pool: Pool,
    private readonly indexerId: string
  ) {}

  /**
   * Get coverage status for a network
   *
   * @param network Network name
   * @returns Coverage status
   */
  async getCoverageStatus(network: string): Promise<CoverageStatus> {
    const client = await this.pool.connect();
    try {
      // Get cursor state
      const cursorResult = await client.query(
        `SELECT last_ledger, ledger_range_start, ledger_range_end, gap_detected, updated_at
         FROM cdc_cursors 
         WHERE indexer_id = $1 AND network = $2`,
        [this.indexerId, network]
      );

      if (cursorResult.rows.length === 0) {
        // No coverage yet
        return {
          network,
          indexedUpToLedger: BigInt(0),
          indexedFromLedger: BigInt(0),
          totalCoverageLedgers: BigInt(0),
          isContiguous: false,
          gaps: [],
          unresolvedGapsCount: 0,
          lastUpdatedAt: null,
          estimatedCoveragePercent: 0,
          isActive: false,
        };
      }

      const cursor = cursorResult.rows[0];
      const lastLedger = BigInt(cursor.last_ledger);
      const rangeStart = BigInt(cursor.ledger_range_start);
      const rangeEnd = BigInt(cursor.ledger_range_end);

      // Get gaps
      const gapResult = await client.query(
        `SELECT expected_ledger, actual_ledger, gap_size, detected_at, resolved_at
         FROM ledger_gap_audit
         WHERE network = $1 AND detected_by = 'cdc-indexer'
         ORDER BY expected_ledger DESC`,
        [network]
      );

      const gaps: LedgerGap[] = gapResult.rows.map((row) => ({
        startLedger: BigInt(row.expected_ledger),
        endLedger: BigInt(row.actual_ledger),
        gapSize: BigInt(row.gap_size),
        detectedAt: new Date(row.detected_at),
        resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
      }));

      const unresolvedGapsCount = gaps.filter((g) => !g.resolvedAt).length;

      // Check contiguity: are there any unresolved gaps?
      const isContiguous = unresolvedGapsCount === 0;

      // Calculate total coverage
      let totalCoverage = BigInt(0);
      if (isContiguous && lastLedger >= rangeStart) {
        totalCoverage = lastLedger - rangeStart + BigInt(1);
      }

      // Estimate coverage percentage (vs a reasonable max ledger number)
      // Assume mainnet is around 50 million ledgers, testnet cycling
      const maxEstimatedLedger = network === 'mainnet' ? BigInt(50000000) : BigInt(10000000);
      const estimatedCoveragePercent = maxEstimatedLedger > BigInt(0)
        ? Number((totalCoverage * BigInt(100)) / maxEstimatedLedger)
        : 0;

      return {
        network,
        indexedUpToLedger: lastLedger,
        indexedFromLedger: rangeStart,
        totalCoverageLedgers: totalCoverage,
        isContiguous,
        gaps,
        unresolvedGapsCount,
        lastUpdatedAt: cursor.updated_at ? new Date(cursor.updated_at) : null,
        estimatedCoveragePercent: Math.min(100, Math.max(0, estimatedCoveragePercent)),
        isActive: cursor.gap_detected === false,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Check if a ledger range is covered
   *
   * @param network Network name
   * @param startLedger Start of range (inclusive)
   * @param endLedger End of range (inclusive)
   * @returns true if range is fully covered and contiguous
   */
  async isCoverageContinuous(
    network: string,
    startLedger: bigint,
    endLedger: bigint
  ): Promise<boolean> {
    const status = await this.getCoverageStatus(network);

    // Check basic bounds
    if (startLedger < status.indexedFromLedger || endLedger > status.indexedUpToLedger) {
      return false;
    }

    // Check for gaps in the requested range
    for (const gap of status.gaps) {
      if (gap.resolvedAt === null) {
        // Unresolved gap; check if it overlaps the requested range
        if (gap.startLedger <= endLedger && gap.endLedger >= startLedger) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Perform a bounded, idempotent replay of events from an authoritative source
   *
   * @param request Replay request with bounds and authoritative source
   * @returns Replay result with events and verification checksum
   */
  async performBoundedReplay(request: BoundedReplayRequest): Promise<BoundedReplayResult> {
    const client = await this.pool.connect();
    try {
      // Fetch events in the requested range
      const eventResult = await client.query(
        `SELECT event_id, ledger_sequence, contract_id, topics
         FROM stream_events
         WHERE network = $1 AND ledger_sequence >= $2 AND ledger_sequence <= $3
         ORDER BY ledger_sequence ASC, event_id ASC`,
        [request.network, request.startLedger.toString(), request.endLedger.toString()]
      );

      const events = eventResult.rows.map((row) => ({
        eventId: row.event_id,
        ledgerSequence: parseInt(row.ledger_sequence, 10),
        contractId: row.contract_id,
        topics: row.topics || [],
      }));

      // Check for gaps in the range
      const gaps: LedgerGap[] = [];
      let prevLedger: bigint | null = null;

      for (const event of events) {
        const currentLedger = BigInt(event.ledgerSequence);
        if (prevLedger !== null && currentLedger > prevLedger + BigInt(1)) {
          gaps.push({
            startLedger: prevLedger + BigInt(1),
            endLedger: currentLedger - BigInt(1),
            gapSize: currentLedger - prevLedger - BigInt(1),
            detectedAt: new Date(),
            resolvedAt: null,
          });
        }
        prevLedger = currentLedger;
      }

      // Compute checksum
      const crypto = require('crypto');
      const checksumContent = events.map((e) => `${e.eventId}:${e.ledgerSequence}`).join('|');
      const checksumSha256 = crypto.createHash('sha256').update(checksumContent).digest('hex');

      const isComplete = gaps.length === 0;

      // Record authoritative source in audit trail
      if (isComplete) {
        await client.query(
          `INSERT INTO ledger_gap_audit (detected_by, network, expected_ledger, actual_ledger, details)
           VALUES ('bounded-replay', $1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [
            request.network,
            request.startLedger.toString(),
            request.endLedger.toString(),
            JSON.stringify({
              authoritativeSource: request.authoritativeSource,
              eventCount: events.length,
              checksumSha256,
              replayedAt: new Date().toISOString(),
            }),
          ]
        );
      }

      return {
        request,
        eventCount: events.length,
        events,
        isComplete,
        gaps,
        checksumSha256,
        replayedAt: new Date(),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get coverage comparison across networks
   *
   * @param networks Network names to compare
   * @returns Coverage status for each network
   */
  async compareNetworkCoverage(networks: string[]): Promise<Map<string, CoverageStatus>> {
    const results = new Map<string, CoverageStatus>();

    for (const network of networks) {
      const status = await this.getCoverageStatus(network);
      results.set(network, status);
    }

    return results;
  }

  /**
   * Alert if coverage falls behind (e.g., > 1 hour stale on mainnet)
   *
   * @param network Network name
   * @param maxStaleMs Maximum staleness in milliseconds
   * @returns Alert message if coverage is stale, undefined otherwise
   */
  async checkCoverageStaleness(network: string, maxStaleMs = 3600000): Promise<string | undefined> {
    const status = await this.getCoverageStatus(network);

    if (!status.lastUpdatedAt) {
      return `Coverage for ${network} has never been updated`;
    }

    const staleMs = Date.now() - status.lastUpdatedAt.getTime();
    if (staleMs > maxStaleMs) {
      const staleMinutes = Math.floor(staleMs / 60000);
      return `Coverage for ${network} is stale (last update ${staleMinutes} minutes ago)`;
    }

    return undefined;
  }

  /**
   * Get human-readable coverage report
   *
   * @param network Network name
   * @returns Formatted report
   */
  async getCoverageReport(network: string): Promise<string> {
    const status = await this.getCoverageStatus(network);

    const lines = [
      `Coverage Report for ${network}`,
      `================================`,
      `Indexed from ledger: ${status.indexedFromLedger}`,
      `Indexed up to ledger: ${status.indexedUpToLedger}`,
      `Total coverage: ${status.totalCoverageLedgers} ledgers`,
      `Contiguous: ${status.isContiguous ? 'Yes' : 'No'}`,
      `Estimated coverage: ${status.estimatedCoveragePercent}%`,
      `Active indexing: ${status.isActive ? 'Yes' : 'No'}`,
      `Last updated: ${status.lastUpdatedAt?.toISOString() || 'Never'}`,
    ];

    if (status.gaps.length > 0) {
      lines.push('');
      lines.push('Detected Gaps:');
      for (const gap of status.gaps) {
        const resolved = gap.resolvedAt
          ? ` (resolved at ${gap.resolvedAt.toISOString()})`
          : ' (UNRESOLVED)';
        lines.push(`  - Ledgers ${gap.startLedger}-${gap.endLedger} (size: ${gap.gapSize})${resolved}`);
      }
    }

    return lines.join('\n');
  }
}
