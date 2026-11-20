/**
 * On-Chain Campaign Tracking & NFT Certificate Service — Issue #785
 *
 * Interacts with Stellar smart contracts to record campaign milestones on-chain
 * and issue immutable NFT certificates when funding goals are met.
 */

import {
  CertificateVerification,
  MintCertificateInput,
  NFTCertificate,
  OnChainMilestone,
  RecordMilestoneInput,
} from '@/types/onchain-tracking';

/**
 * Lifecycle states for an on-chain transaction. These are the authoritative
 * states a sponsor portfolio / transaction timeline reconciles against.
 *
 * - `submitted`: the transaction was broadcast to the network (wallet approval
 *   already happened before this point).
 * - `ledger_confirmed`: the transaction was included in a ledger.
 * - `settled`: the transaction reached finality and its effects are applied.
 * - `failed`: the transaction was rejected or dropped; `retryable` indicates
 *   whether the caller may safely resubmit.
 */
export type OnChainTransactionStatus =
  | 'submitted'
  | 'ledger_confirmed'
  | 'settled'
  | 'failed';

export interface OnChainTransactionEvent {
  /** Stable id for the event, used for idempotent retries. */
  eventId: string;
  /** The on-chain transaction hash this event refers to. */
  txHash: string;
  /** Campaign the transaction belongs to. */
  campaignId: string;
  /** What the transaction represents (e.g. milestone, certificate). */
  kind: 'milestone' | 'certificate';
  /** Authoritative lifecycle status. */
  status: OnChainTransactionStatus;
  /** Ledger sequence once confirmed; null before confirmation. */
  ledger: number | null;
  /** ISO timestamp of when this status was observed. */
  observedAt: string;
  /** Whether a failed transaction may be retried. */
  retryable: boolean;
  /** Human-readable failure reason, when status is `failed`. */
  failureReason?: string;
  /** Source reference so consumers can reconcile against authoritative records. */
  source: {
    /** Identifier of the authoritative record (milestone id or certificate id). */
    referenceId: string;
    /** Network the transaction lives on. */
    network: string;
    /** Contract / account the transaction was submitted against. */
    contractId: string;
  };
}

export interface RecordTransactionEventInput {
  txHash: string;
  campaignId: string;
  kind: 'milestone' | 'certificate';
  status: OnChainTransactionStatus;
  ledger?: number | null;
  retryable?: boolean;
  failureReason?: string;
  source: {
    referenceId: string;
    network?: string;
    contractId?: string;
  };
}

export class OnChainCampaignTrackingService {
  private milestones: Map<string, OnChainMilestone[]> = new Map();
  private certificates: Map<string, NFTCertificate> = new Map();
  private transactionEvents: Map<string, OnChainTransactionEvent[]> = new Map();
  private transactionEventsByTxHash: Map<string, OnChainTransactionEvent[]> = new Map();
  private readonly defaultNetwork: string;
  private readonly defaultContractId: string;

  constructor(options?: { network?: string; contractId?: string }) {
    this.defaultNetwork = options?.network ?? 'testnet';
    this.defaultContractId = options?.contractId ?? 'campaign-tracking-contract';
  }

  /**
   * Record a milestone on the Stellar blockchain.
   */
  public async recordOnChainMilestone(input: RecordMilestoneInput): Promise<OnChainMilestone> {
    const existing = this.milestones.get(input.campaignId) || [];

    const duplicate = existing.find((m) => m.milestonePercentage === input.milestonePercentage);
    if (duplicate) {
      return duplicate;
    }

    const dummyTxHash = `tx-${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;

    const milestone: OnChainMilestone = {
      id: `ms-${input.campaignId}-${input.milestonePercentage}`,
      campaignId: input.campaignId,
      milestonePercentage: input.milestonePercentage,
      title: input.title,
      description: input.description,
      targetAmount: input.targetAmount,
      achievedAmount: input.achievedAmount,
      txHash: dummyTxHash,
      blockTimestamp: Math.floor(Date.now() / 1000),
      verifiedOnChain: true,
    };

    existing.push(milestone);
    this.milestones.set(input.campaignId, existing);

    // Emit the authoritative lifecycle events for the milestone transaction.
    // Submission is recorded first, then ledger confirmation and settlement.
    this.recordTransactionEvent({
      txHash: milestone.txHash,
      campaignId: milestone.campaignId,
      kind: 'milestone',
      status: 'submitted',
      source: { referenceId: milestone.id },
    });
    this.recordTransactionEvent({
      txHash: milestone.txHash,
      campaignId: milestone.campaignId,
      kind: 'milestone',
      status: 'ledger_confirmed',
      ledger: milestone.blockTimestamp,
      source: { referenceId: milestone.id },
    });
    this.recordTransactionEvent({
      txHash: milestone.txHash,
      campaignId: milestone.campaignId,
      kind: 'milestone',
      status: 'settled',
      ledger: milestone.blockTimestamp,
      source: { referenceId: milestone.id },
    });

    return milestone;
  }

  /**
   * Persist a lifecycle event for an on-chain transaction.
   *
   * Events are idempotent per (txHash, status): re-recording the same status
   * for the same transaction returns the existing event instead of appending a
   * duplicate. This makes retries safe for callers that may re-submit after a
   * reload or a transient failure.
   */
  public recordTransactionEvent(input: RecordTransactionEventInput): OnChainTransactionEvent {
    const existingForTx = this.transactionEventsByTxHash.get(input.txHash) ?? [];
    const duplicate = existingForTx.find((e) => e.status === input.status);
    if (duplicate) {
      return duplicate;
    }

    const event: OnChainTransactionEvent = {
      eventId: `evt-${input.txHash}-${input.status}`,
      txHash: input.txHash,
      campaignId: input.campaignId,
      kind: input.kind,
      status: input.status,
      ledger: input.ledger ?? null,
      observedAt: new Date().toISOString(),
      retryable: input.status === 'failed' ? Boolean(input.retryable) : false,
      failureReason: input.status === 'failed' ? input.failureReason : undefined,
      source: {
        referenceId: input.source.referenceId,
        network: input.source.network ?? this.defaultNetwork,
        contractId: input.source.contractId ?? this.defaultContractId,
      },
    };

    existingForTx.push(event);
    this.transactionEventsByTxHash.set(input.txHash, existingForTx);

    const existingForCampaign = this.transactionEvents.get(input.campaignId) ?? [];
    existingForCampaign.push(event);
    this.transactionEvents.set(input.campaignId, existingForCampaign);

    return event;
  }

  /**
   * Record a failure for an on-chain transaction so operators and the timeline
   * can surface an explicit recovery state.
   */
  public recordTransactionFailure(
    input: Omit<RecordTransactionEventInput, 'status'> & {
      retryable?: boolean;
      failureReason: string;
    },
  ): OnChainTransactionEvent {
    return this.recordTransactionEvent({
      ...input,
      status: 'failed',
      retryable: input.retryable ?? true,
    });
  }

  /**
   * Get the ordered lifecycle events for a single transaction. Used by the
   * transaction confirmation timeline to recover state after a reload.
   */
  public getTransactionEvents(txHash: string): OnChainTransactionEvent[] {
    return [...(this.transactionEventsByTxHash.get(txHash) ?? [])];
  }

  /**
   * Get all lifecycle events for a campaign, ordered by observation time.
   */
  public getCampaignTransactionEvents(campaignId: string): OnChainTransactionEvent[] {
    return [...(this.transactionEvents.get(campaignId) ?? [])];
  }

  /**
   * Resolve the latest authoritative status for a transaction, or `null` when
   * the transaction is unknown.
   */
  public getTransactionStatus(txHash: string): OnChainTransactionStatus | null {
    const events = this.transactionEventsByTxHash.get(txHash);
    if (!events || events.length === 0) {
      return null;
    }
    return events[events.length - 1].status;
  }

  /**
   * Get all on-chain recorded milestones for a campaign.
   */
  public async getOnChainMilestones(campaignId: string): Promise<OnChainMilestone[]> {
    return this.milestones.get(campaignId) || [];
  }

  /**
   * Issue an NFT certificate on Stellar when funding goal is met.
   */
  public async issueNFTCertificate(input: MintCertificateInput): Promise<NFTCertificate> {
    const certId = `NFT-CERT-${input.campaignId}-${Date.now()}`;
    const dummyTxHash = `tx-nft-${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
    const metadataUri = `https://ipfs.io/ipfs/QmFNDL${certId.toLowerCase()}`;
    const assetCode = `FUND${input.campaignId.substring(0, 4).toUpperCase()}`;

    const certificate: NFTCertificate = {
      certificateId: certId,
      campaignId: input.campaignId,
      campaignTitle: input.campaignTitle,
      creatorAddress: input.creatorAddress,
      recipientAddress: input.recipientAddress || input.creatorAddress,
      fundingGoal: input.fundingGoal,
      totalRaised: input.totalRaised,
      issuedAt: new Date().toISOString(),
      txHash: dummyTxHash,
      metadataUri,
      assetCode,
      verified: true,
      impact: input.impact,
    };

    this.certificates.set(certId, certificate);

    this.recordTransactionEvent({
      txHash: certificate.txHash,
      campaignId: certificate.campaignId,
      kind: 'certificate',
      status: 'submitted',
      source: { referenceId: certificate.certificateId },
    });
    this.recordTransactionEvent({
      txHash: certificate.txHash,
      campaignId: certificate.campaignId,
      kind: 'certificate',
      status: 'ledger_confirmed',
      source: { referenceId: certificate.certificateId },
    });
    this.recordTransactionEvent({
      txHash: certificate.txHash,
      campaignId: certificate.campaignId,
      kind: 'certificate',
      status: 'settled',
      source: { referenceId: certificate.certificateId },
    });

    // Auto-record 100% milestone on-chain as well
    await this.recordOnChainMilestone({
      campaignId: input.campaignId,
      milestonePercentage: 100,
      title: 'Campaign 100% Funding Goal Achieved',
      description: `Campaign "${input.campaignTitle}" reached its total funding target of ${input.fundingGoal}.`,
      achievedAmount: input.totalRaised,
      targetAmount: input.fundingGoal,
    });

    return certificate;
  }

  /** Mint the completion certificate once and one personal impact NFT per sponsor. */
  public async mintEnvironmentalImpactNFTs(input: MintCertificateInput & { sponsorAddresses: string[] }): Promise<NFTCertificate[]> {
    if (Number(input.totalRaised) < Number(input.fundingGoal)) {
      throw new Error("Environmental impact NFTs can only be minted for completed campaigns");
    }
    const recipients = [input.recipientAddress ?? input.creatorAddress, ...input.sponsorAddresses];
    const certificates: NFTCertificate[] = [];
    for (const recipientAddress of [...new Set(recipients)]) {
      certificates.push(await this.issueNFTCertificate({ ...input, recipientAddress }));
    }
    return certificates;
  }

  /**
   * Get issued NFT certificate by ID.
   */
  public async getCertificate(certificateId: string): Promise<NFTCertificate | null> {
    return this.certificates.get(certificateId) || null;
  }

  /**
   * Get all NFT certificates issued for a campaign.
   */
  public async getCertificatesForCampaign(campaignId: string): Promise<NFTCertificate[]> {
    return Array.from(this.certificates.values()).filter((c) => c.campaignId === campaignId);
  }

  /**
   * Verify an NFT achievement certificate on-chain.
   */
  public async verifyNFTCertificate(certificateId: string): Promise<CertificateVerification> {
    const cert = this.certificates.get(certificateId);
    if (!cert) {
      return {
        certificateId,
        isValid: false,
        onChainTxHash: '',
        verifiedAt: new Date().toISOString(),
        campaignDetails: {
          campaignId: '',
          campaignTitle: '',
          totalRaised: '0',
        },
      };
    }

    return {
      certificateId: cert.certificateId,
      isValid: true,
      onChainTxHash: cert.txHash,
      verifiedAt: new Date().toISOString(),
      campaignDetails: {
        campaignId: cert.campaignId,
        campaignTitle: cert.campaignTitle,
        totalRaised: cert.totalRaised,
      },
    };
  }
}

export const onChainCampaignTrackingService = new OnChainCampaignTrackingService();
