/**
 * Campaign Insurance Service
 *
 * Manages campaign tree loss protection, pool balances, and automatic 2-year sponsor refund claims (Issue #851).
 * 
 * Objective 1: Refund Eligibility & State
 * ========================================
 * This service now differentiates between:
 *   - Refund eligibility (whether a sponsor qualifies for a refund)
 *   - Refund request/submission state (whether the sponsor has requested a refund)
 *   - Confirmed refund transaction references (on-chain tx hash showing refund was processed)
 * 
 * The service does NOT imply that unclaimed refunds are automatic — sponsors must
 * explicitly request a refund through the UI.
 */

/**
 * Refund request/submission status
 */
export type RefundSubmissionState = 
  | "NOT_REQUESTED" 
  | "PENDING" 
  | "CONFIRMED" 
  | "FAILED" 
  | "REJECTED";

/**
 * Eligibility criteria for a refund
 */
export interface RefundEligibility {
  isEligible: boolean;
  reason: string; // Human-readable reason for eligibility or ineligibility
  failureReason?: string; // Specific reason if not eligible
}

/**
 * Confirmed on-chain refund transaction reference
 */
export interface ConfirmedRefundTransaction {
  transactionHash: string;
  ledger: number;
  timestamp: Date;
  amount: bigint;
  status: "success" | "failed";
}

/**
 * Complete refund state for a sponsor
 */
export interface RefundState {
  sponsorAddress: string;
  campaignId: number;
  contribution: bigint;
  
  // Objective 1: Eligibility vs. State
  eligibility: RefundEligibility;
  submissionState: RefundSubmissionState;
  confirmedTransaction?: ConfirmedRefundTransaction;
  
  // Timestamps
  eligibilityDeterminedAt: Date;
  submissionRequestedAt?: Date;
  lastStatusCheckAt: Date;
}

export interface InsuranceStatusReport {
  campaignId: number;
  insuranceFundedAmount: bigint;
  coverageExpiresAt: Date;
  isCovered: boolean;
  daysRemaining: number;
}

export class CampaignInsuranceService {
  static readonly TWO_YEARS_MS = 63_072_000 * 1000;

  static getCoverageStatus(campaignId: number, grossRaised: bigint, createdAt: Date, now: Date = new Date()): InsuranceStatusReport {
    const insuranceFundedAmount = (grossRaised * BigInt(100)) / BigInt(10000);
    const expiresAtMs = createdAt.getTime() + this.TWO_YEARS_MS;
    const isCovered = now.getTime() <= expiresAtMs;
    const msRemaining = Math.max(0, expiresAtMs - now.getTime());
    const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));

    return {
      campaignId,
      insuranceFundedAmount,
      coverageExpiresAt: new Date(expiresAtMs),
      isCovered,
      daysRemaining,
    };
  }

  /**
   * Objective 1: Determine if a sponsor is eligible for a refund.
   * 
   * Eligibility is based on:
   *   - Campaign failed (not successful/not claimed)
   *   - Sponsor had a contribution
   *   - Refund hasn't already been claimed
   */
  static evaluateRefundEligibility(
    campaignFailed: boolean,
    sponsorContribution: bigint,
    alreadyRefunded: boolean
  ): RefundEligibility {
    if (alreadyRefunded) {
      return {
        isEligible: false,
        reason: "Refund has already been processed",
        failureReason: "ALREADY_REFUNDED",
      };
    }

    if (!campaignFailed) {
      return {
        isEligible: false,
        reason: "Campaign did not fail — refunds only apply to failed campaigns",
        failureReason: "CAMPAIGN_NOT_FAILED",
      };
    }

    if (sponsorContribution <= 0n) {
      return {
        isEligible: false,
        reason: "No contribution found for this sponsor",
        failureReason: "NO_CONTRIBUTION",
      };
    }

    return {
      isEligible: true,
      reason: "Sponsor is eligible for a full refund of their contribution",
    };
  }

  /**
   * Objective 1: Build complete refund state for a sponsor.
   * 
   * This explicitly shows:
   *   - Whether they're eligible
   *   - Whether they've requested a refund (and what state it's in)
   *   - The confirmed on-chain transaction reference (if available)
   */
  static buildRefundState(
    sponsorAddress: string,
    campaignId: number,
    contribution: bigint,
    campaignFailed: boolean,
    alreadyRefunded: boolean,
    submissionState: RefundSubmissionState = "NOT_REQUESTED",
    confirmedTransaction?: ConfirmedRefundTransaction
  ): RefundState {
    const eligibility = this.evaluateRefundEligibility(
      campaignFailed,
      contribution,
      alreadyRefunded
    );

    return {
      sponsorAddress,
      campaignId,
      contribution,
      eligibility,
      submissionState,
      confirmedTransaction,
      eligibilityDeterminedAt: new Date(),
      lastStatusCheckAt: new Date(),
    };
  }
}
