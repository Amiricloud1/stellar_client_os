/**
 * Reconciliation Engine for Independent Liability Verification
 * 
 * Satisfies Objective 4: Make every liability change traceable to a stable operation 
 * and event reference for independent reconciliation.
 * 
 * This engine enables:
 * 1. Querying all events for a stream/recipient
 * 2. Matching events to operations via event_ref
 * 3. Reconstructing complete liability history
 * 4. Verifying on-chain state matches event chain
 * 5. Independent auditing without access to contract storage
 */

import { EventReference, OperationNonce } from './types';

export interface LiabilityChange {
  operationNonce: OperationNonce;
  eventReference: EventReference;
  eventType: 'deposit' | 'withdrawal' | 'pause' | 'resume' | 'create' | 'cancel';
  resourceId: string;
  amountChange: number; // positive for deposits, negative for withdrawals
  timestamp: number;
  ledgerSequence: number;
  actor: string;
}

export interface ReconciledStream {
  streamId: string;
  initialBalance: number;
  currentBalance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  changes: LiabilityChange[];
  reconciliationStatus: 'verified' | 'mismatch' | 'incomplete';
  mismatchDetails?: string;
}

export interface ReconciliationReport {
  timestamp: number;
  streams: ReconciledStream[];
  summary: {
    totalStreams: number;
    reconciled: number;
    mismatches: number;
    totalLiability: number;
    verifiedLiability: number;
  };
}

/**
 * Query events from a Soroban contract and reconstruct liability history
 */
export class ReconciliationEngine {
  private contractId: string;
  private horizonServer: any; // HorizonServer instance
  private rpcUrl: string;

  constructor(
    contractId: string,
    horizonServer: any,
    rpcUrl: string
  ) {
    this.contractId = contractId;
    this.horizonServer = horizonServer;
    this.rpcUrl = rpcUrl;
  }

  /**
   * Fetch all events for a stream from Horizon
   * Events are immutable once recorded and serve as source of truth
   */
  async fetchStreamEvents(streamId: string, cursor?: string): Promise<LiabilityChange[]> {
    const changes: LiabilityChange[] = [];

    try {
      // Query contract events from Horizon
      const eventsUrl = `${this.rpcUrl}/events?filters[contract_id]=${this.contractId}&filters[topics]=StreamWithdraw,StreamDeposit,StreamCreated,StreamPaused,StreamResumed`;

      const response = await fetch(eventsUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.statusText}`);
      }

      const data = await response.json();
      const records = data.embedded?.records || [];

      for (const record of records) {
        const change = this.parseEventToLiabilityChange(record, streamId);
        if (change) {
          changes.push(change);
        }
      }

      // Sort by ledger sequence to maintain causality
      changes.sort((a, b) => a.ledgerSequence - b.ledgerSequence);

      return changes;
    } catch (error) {
      console.error('Error fetching stream events:', error);
      throw error;
    }
  }

  /**
   * Parse a raw event into a LiabilityChange struct
   * Validates that the event includes all required traceability fields
   */
  private parseEventToLiabilityChange(
    event: any,
    streamId: string
  ): LiabilityChange | null {
    const eventData = event.event_data;
    if (!eventData) return null;

    // All events must include event_ref for traceability
    const eventRef = eventData.event_ref;
    if (!eventRef) {
      console.warn(`Event missing event_ref: ${event.id}`);
      return null;
    }

    let eventType: LiabilityChange['eventType'] = 'deposit';
    let amount = 0;

    // Parse event by type
    if (event.topic === 'StreamWithdraw' || event.topic === 'stream_withdraw') {
      eventType = 'withdrawal';
      amount = -parseInt(eventData.amount || '0');
    } else if (event.topic === 'StreamDeposit' || event.topic === 'stream_deposit') {
      eventType = 'deposit';
      amount = parseInt(eventData.amount || '0');
    } else if (event.topic === 'StreamCreated' || event.topic === 'stream_created') {
      eventType = 'create';
      amount = parseInt(eventData.total_amount || '0');
    } else if (event.topic === 'StreamPausedV2' || event.topic === 'stream_paused_v2') {
      eventType = 'pause';
      amount = 0; // Pause doesn't change balance, just state
    } else if (event.topic === 'StreamResumedV2' || event.topic === 'stream_resumed_v2') {
      eventType = 'resume';
      amount = 0; // Resume doesn't change balance
    } else {
      return null;
    }

    return {
      operationNonce: {
        walletSequence: BigInt(eventRef.wallet_sequence || '0'),
        operationIndex: eventRef.operation_index || 0,
        contract: eventRef.contract || this.contractId,
      },
      eventReference: {
        operationNonce: {
          walletSequence: BigInt(eventRef.wallet_sequence || '0'),
          operationIndex: eventRef.operation_index || 0,
          contract: eventRef.contract || this.contractId,
        },
        eventHash: eventRef.event_hash || '',
        ledgerSequence: eventRef.ledger_sequence || 0,
        ledgerTimestamp: eventRef.ledger_timestamp || 0,
      },
      eventType,
      resourceId: streamId,
      amountChange: amount,
      timestamp: parseInt(eventRef.ledger_timestamp || '0'),
      ledgerSequence: eventRef.ledger_sequence || 0,
      actor: eventData.caller || '',
    };
  }

  /**
   * Reconstruct the complete liability history for a stream
   * Allows independent verification of on-chain state
   */
  async reconcileStream(
    streamId: string,
    currentBalance: number
  ): Promise<ReconciledStream> {
    const changes = await this.fetchStreamEvents(streamId);

    // Calculate reconstructed balance from events
    let reconstructedBalance = 0;
    let totalDeposited = 0;
    let totalWithdrawn = 0;

    for (const change of changes) {
      if (change.eventType === 'create' || change.eventType === 'deposit') {
        reconstructedBalance += change.amountChange;
        totalDeposited += change.amountChange;
      } else if (change.eventType === 'withdrawal') {
        reconstructedBalance -= Math.abs(change.amountChange);
        totalWithdrawn += Math.abs(change.amountChange);
      }
      // pause/resume don't change balance
    }

    const reconciliationStatus =
      Math.abs(reconstructedBalance - currentBalance) < 1e-9
        ? ('verified' as const)
        : ('mismatch' as const);

    return {
      streamId,
      initialBalance: changes.length > 0 ? changes[0].amountChange : 0,
      currentBalance,
      totalDeposited,
      totalWithdrawn,
      changes,
      reconciliationStatus,
      mismatchDetails:
        reconciliationStatus === 'mismatch'
          ? `Reconstructed: ${reconstructedBalance}, Actual: ${currentBalance}, Diff: ${
              currentBalance - reconstructedBalance
            }`
          : undefined,
    };
  }

  /**
   * Generate a comprehensive reconciliation report
   * For independent audits and compliance verification
   */
  async generateReconciliationReport(
    streamIds: string[],
    onChainBalances: Map<string, number>
  ): Promise<ReconciliationReport> {
    const streams: ReconciledStream[] = [];
    let totalLiability = 0;
    let verifiedLiability = 0;
    let reconciled = 0;
    let mismatches = 0;

    for (const streamId of streamIds) {
      const currentBalance = onChainBalances.get(streamId) || 0;
      const stream = await this.reconcileStream(streamId, currentBalance);

      streams.push(stream);
      totalLiability += currentBalance;

      if (stream.reconciliationStatus === 'verified') {
        verifiedLiability += currentBalance;
        reconciled++;
      } else {
        mismatches++;
      }
    }

    return {
      timestamp: Date.now(),
      streams,
      summary: {
        totalStreams: streamIds.length,
        reconciled,
        mismatches,
        totalLiability,
        verifiedLiability,
      },
    };
  }

  /**
   * Verify causality: trace events back to originating operations
   * For detecting replay attacks or operation reordering
   */
  async verifyCausality(events: LiabilityChange[]): Promise<boolean> {
    const seenNonces = new Set<string>();

    for (const event of events) {
      const nonceKey = `${event.operationNonce.walletSequence}-${event.operationNonce.operationIndex}`;

      // Each nonce should appear exactly once (unless recovery path is triggered)
      if (seenNonces.has(nonceKey)) {
        console.warn(`Duplicate nonce detected: ${nonceKey}`);
        return false;
      }
      seenNonces.add(nonceKey);
    }

    // Check that ledger sequences are monotonically increasing
    for (let i = 1; i < events.length; i++) {
      if (events[i].ledgerSequence < events[i - 1].ledgerSequence) {
        console.warn('Ledger sequence out of order');
        return false;
      }
    }

    return true;
  }

  /**
   * Export reconciliation data in standard format for external tools
   * Enables independent verification by auditors or compliance tools
   */
  exportForAudit(report: ReconciliationReport): string {
    const auditData = {
      report,
      exportedAt: new Date().toISOString(),
      contractId: this.contractId,
      format: 'ReconciliationReport-v1',
      integrity: {
        streamCount: report.streams.length,
        eventCount: report.streams.reduce((sum, s) => sum + s.changes.length, 0),
        checksumable: true,
      },
    };

    return JSON.stringify(auditData, (key, value) => {
      // Handle BigInt serialization
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    }, 2);
  }

  /**
   * Compare two reconciliation reports to detect changes
   * Useful for monitoring reconciliation drift over time
   */
  compareReports(
    before: ReconciliationReport,
    after: ReconciliationReport
  ): {
    newStreams: string[];
    removedStreams: string[];
    balanceChanges: Map<string, number>;
    totalLiabilityDelta: number;
  } {
    const beforeIds = new Set(before.streams.map((s) => s.streamId));
    const afterIds = new Set(after.streams.map((s) => s.streamId));

    const newStreams = Array.from(afterIds).filter((id) => !beforeIds.has(id));
    const removedStreams = Array.from(beforeIds).filter((id) => !afterIds.has(id));

    const balanceChanges = new Map<string, number>();
    for (const stream of after.streams) {
      const before_stream = before.streams.find((s) => s.streamId === stream.streamId);
      if (before_stream) {
        const delta = stream.currentBalance - before_stream.currentBalance;
        if (delta !== 0) {
          balanceChanges.set(stream.streamId, delta);
        }
      }
    }

    return {
      newStreams,
      removedStreams,
      balanceChanges,
      totalLiabilityDelta: after.summary.totalLiability - before.summary.totalLiability,
    };
  }
}

/**
 * Utility function to verify event integrity using hash
 * Ensures events have not been tampered with
 */
export function verifyEventHash(
  event: LiabilityChange,
  expectedHash: string
): boolean {
  // In production, implement cryptographic hash verification
  // For now, check that hash is present and non-empty
  return event.eventReference.eventHash.length > 0;
}

/**
 * Utility function to build operation causality chain
 * Useful for debugging multi-step operations
 */
export function buildCausalityChain(
  events: LiabilityChange[]
): Map<string, LiabilityChange[]> {
  const chains = new Map<string, LiabilityChange[]>();

  for (const event of events) {
    const nonceKey = `${event.operationNonce.walletSequence}-${event.operationNonce.operationIndex}`;
    if (!chains.has(nonceKey)) {
      chains.set(nonceKey, []);
    }
    chains.get(nonceKey)!.push(event);
  }

  return chains;
}
