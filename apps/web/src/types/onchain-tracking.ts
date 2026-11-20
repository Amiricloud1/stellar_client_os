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
 * Canonical contract-event domain mappings — Issue #219
 *
 * Every supported contract event version is mapped to a canonical projection
 * (a normalized, version-independent shape consumed by the web tracking
 * services). Event versions that are not yet supported are NOT dropped: they
 * are retained verbatim as `RetainedUnknownEvent` records so operators can
 * inspect them and a later release can add a mapping without data loss.
 *
 * Compatibility guarantees:
 * - `CanonicalProjection.schemaVersion` is bumped only for breaking changes to
 *   the projection shape; additive fields do not bump it.
 * - `RetainedUnknownEvent.rawPayload` is stored unmodified and must round-trip
 *   byte-for-byte (JSON) so future mappings can replay it.
 * - Unknown events never fail the ingestion batch; they surface as an explicit
 *   `retained` state instead of being silently discarded.
 */

/** Lifecycle state of a contract event after mapping. */
export type EventMappingState = 'projected' | 'retained';

/** Canonical, version-independent projection of a supported contract event. */
export interface CanonicalProjection {
  /** Canonical event name, e.g. `campaign.milestone.reached`. */
  eventName: string;
  /** Contract event version this projection was derived from. */
  sourceVersion: string;
  /** Version of the canonical projection schema itself. */
  schemaVersion: number;
  /** Chain the event was observed on. */
  chainId: string;
  /** Contract address that emitted the event. */
  contractAddress: string;
  /** Transaction hash of the emitting transaction. */
  txHash: string;
  /** Log index within the transaction, used for deterministic ordering. */
  logIndex: number;
  /** Block number the event was included in. */
  blockNumber: number;
  /** Normalized, version-independent payload. */
  payload: Record<string, unknown>;
  /** Mapping state; always `projected` for canonical projections. */
  state: Extract<EventMappingState, 'projected'>;
}

/** An event whose version has no canonical mapping yet; retained, not dropped. */
export interface RetainedUnknownEvent {
  /** Identifier assigned at ingestion for later replay. */
  retentionId: string;
  /** Raw event name as emitted by the contract. */
  eventName: string;
  /** Raw event version as emitted by the contract. */
  sourceVersion: string;
  chainId: string;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Unmodified raw payload; must round-trip exactly. */
  rawPayload: Record<string, unknown>;
  /** Reason the event could not be mapped (e.g. `unsupported_version`). */
  reason: string;
  /** ISO timestamp of when the event was retained. */
  retainedAt: string;
  /** Mapping state; always `retained` for unknown events. */
  state: Extract<EventMappingState, 'retained'>;
}

/** Result of mapping a single contract event. */
export type EventMappingResult =
  | { state: 'projected'; projection: CanonicalProjection }
  | { state: 'retained'; retained: RetainedUnknownEvent };

/** Result of mapping a batch of contract events. */
export interface EventMappingBatchResult {
  projections: CanonicalProjection[];
  retained: RetainedUnknownEvent[];
  /** True when at least one event was retained for later replay. */
  hasRetained: boolean;
}
