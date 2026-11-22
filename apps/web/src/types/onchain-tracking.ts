/**
 * Types for On-Chain Campaign Tracking & NFT Certificates — Issue #785
 */

export interface OnChainMilestone {
  id: string;
  campaignId: string;
  milestonePercentage: number; // 25, 50, 75, 100
  title: string;
  description: string;
  targetAmount: string;
  achievedAmount: string;
  txHash: string;
  blockTimestamp: number;
  verifiedOnChain: boolean;
}

export interface NFTCertificate {
  certificateId: string;
  campaignId: string;
  campaignTitle: string;
  creatorAddress: string;
  recipientAddress?: string;
  fundingGoal: string;
  totalRaised: string;
  issuedAt: string;
  txHash: string;
  metadataUri: string;
  assetCode: string;
  verified: boolean;
  /** Environmental impact recorded in the certificate metadata. */
  impact?: EnvironmentalImpact;
}

export interface EnvironmentalImpact {
  trees: number;
  co2OffsetTons: number;
  sponsorCount: number;
  completedAt: string;
}

export interface RecordMilestoneInput {
  campaignId: string;
  milestonePercentage: number;
  title: string;
  description: string;
  achievedAmount: string;
  targetAmount: string;
}

export interface MintCertificateInput {
  campaignId: string;
  campaignTitle: string;
  creatorAddress: string;
  fundingGoal: string;
  totalRaised: string;
  recipientAddress?: string;
  impact?: EnvironmentalImpact;
}

export interface CertificateVerification {
  certificateId: string;
  isValid: boolean;
  onChainTxHash: string;
  verifiedAt: string;
  campaignDetails: {
    campaignId: string;
    campaignTitle: string;
    totalRaised: string;
  };
}

/**
 * Partition ingestion by network and deployment — Issue #217
 *
 * Each (network, deploymentId) pair is an independent ingestion partition with
 * its own cursor, backfill state, and health. A stalled or failing partition
 * must never block ingestion for other partitions.
 */

export type IngestionNetwork = 'mainnet' | 'testnet' | 'futurenet' | 'local';

/** Lifecycle state of a single ingestion partition. */
export type PartitionStatus =
  | 'idle'
  | 'syncing'
  | 'backfilling'
  | 'degraded'
  | 'stalled'
  | 'failed'
  | 'paused';

/** Health snapshot for a partition, surfaced to operators. */
export interface PartitionHealth {
  status: PartitionStatus;
  /** Ledger sequence of the last successfully ingested ledger. */
  lastIngestedLedger: number;
  /** Latest ledger known to the network at the time of the snapshot. */
  latestKnownLedger: number;
  /** Ledgers behind the chain head; 0 when fully caught up. */
  lagLedgers: number;
  /** Consecutive ingestion failures since the last success. */
  consecutiveFailures: number;
  /** ISO timestamp of the last successful ingestion, if any. */
  lastSuccessAt?: string;
  /** ISO timestamp of the most recent failure, if any. */
  lastFailureAt?: string;
  /** Human-readable reason for the current degraded/stalled/failed state. */
  reason?: string;
  /** ISO timestamp when the health snapshot was computed. */
  updatedAt: string;
}

/** Durable ingestion cursor for a single partition. */
export interface PartitionCursor {
  network: IngestionNetwork;
  deploymentId: string;
  /** Next ledger sequence to ingest. */
  nextLedger: number;
  /** Last ledger sequence that was fully processed. */
  lastProcessedLedger: number;
  /** Cursor for an in-progress backfill, if one is running. */
  backfill?: {
    fromLedger: number;
    toLedger: number;
    nextLedger: number;
    startedAt: string;
  };
  /** Optimistic-concurrency token; must match on write to avoid clobbering. */
  version: number;
  updatedAt: string;
}

/** A single, isolated ingestion partition keyed by network + deployment. */
export interface IngestionPartition {
  network: IngestionNetwork;
  deploymentId: string;
  /** Stable identifier, e.g. `${network}:${deploymentId}`. */
  partitionKey: string;
  cursor: PartitionCursor;
  health: PartitionHealth;
  /** Whether this partition is enabled for ingestion. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
