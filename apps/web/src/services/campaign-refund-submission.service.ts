/**
 * Campaign Refund Submission Service
 * 
 * Objective 3: Submission Status & Retry Logic
 * ============================================
 * 
 * Differentiates between:
 *   - REJECTED: Server explicitly rejected the submission (e.g., invalid state, unauthorized)
 *   - TIMEOUT: Ambiguous state (request may have succeeded but we don't know)
 *   - PENDING: In progress
 *   - CONFIRMED: On-chain confirmed via transaction hash
 * 
 * Prevents retry UI from creating duplicate transfers by:
 *   - Idempotency keys on submission (detect duplicate on-chain)
 *   - Checking on-chain state before allowing retry
 *   - Tracking submission attempts separately from confirmed state
 */

export type RefundSubmissionStatusType = 
  | "PENDING" 
  | "CONFIRMED" 
  | "REJECTED" 
  | "TIMEOUT" 
  | "RETRY_ELIGIBLE";

/**
 * Submission attempt tracking
 */
export interface RefundSubmissionAttempt {
  id: string;
  campaignId: string;
  sponsorAddress: string;
  idempotencyKey: string; // Unique key to prevent duplicate transfers on-chain
  
  status: "INITIATED" | "IN_FLIGHT" | "CONFIRMED" | "REJECTED" | "TIMEOUT";
  submittedAt: Date;
  
  // Transaction info (if confirmed)
  transactionHash?: string;
  ledgerNumber?: number;
  confirmedAt?: Date;
  
  // Error info (if rejected or timed out)
  errorCode?: string;
  errorMessage?: string;
  
  // Retry tracking
  attemptNumber: number;
  maxRetries: number;
  nextRetryEligibleAt?: Date;
}

/**
 * Comprehensive submission status including retry eligibility
 */
export interface RefundSubmissionStatus {
  campaignId: string;
  sponsorAddress: string;
  currentStatus: RefundSubmissionStatusType;
  lastAttempt?: RefundSubmissionAttempt;
  allAttempts: RefundSubmissionAttempt[];
  
  // Retry eligibility
  canRetry: boolean;
  retryEligibleAt?: Date;
  retryReason?: string;
  
  // Confirmed state
  isConfirmed: boolean;
  confirmedTransactionHash?: string;
}

/**
 * On-chain check result for idempotency
 */
export interface OnChainRefundState {
  hasRefund: boolean;
  transactionHash?: string;
  ledger?: number;
  refundAmount?: bigint;
  timestamp?: Date;
}

const TIMEOUT_MS = 60_000; // 60 seconds
const MIN_RETRY_DELAY_MS = 5_000; // 5 seconds
const MAX_RETRY_DELAY_MS = 60_000; // 60 seconds
const MAX_RETRIES = 3;

export class CampaignRefundSubmissionService {
  private submissionCache = new Map<string, RefundSubmissionAttempt[]>();

  /**
   * Initiate a refund submission with an idempotency key.
   * 
   * The idempotency key allows the on-chain contract to detect and reject
   * duplicate transfers even if the client retries the request.
   */
  initiateSubmission(
    campaignId: string,
    sponsorAddress: string
  ): RefundSubmissionAttempt {
    const idempotencyKey = `refund-${campaignId}-${sponsorAddress}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const cacheKey = `${campaignId}:${sponsorAddress}`;
    
    const attempt: RefundSubmissionAttempt = {
      id: `attempt-${Date.now()}`,
      campaignId,
      sponsorAddress,
      idempotencyKey,
      status: "INITIATED",
      submittedAt: new Date(),
      attemptNumber: 1,
      maxRetries: MAX_RETRIES,
    };

    const attempts = this.submissionCache.get(cacheKey) || [];
    attempts.push(attempt);
    this.submissionCache.set(cacheKey, attempts);

    return attempt;
  }

  /**
   * Mark a submission as confirmed on-chain.
   * 
   * This should only be called after verifying the transaction hash
   * on-chain via an RPC call.
   */
  confirmSubmission(
    idempotencyKey: string,
    transactionHash: string,
    ledgerNumber: number
  ): void {
    for (const attempts of this.submissionCache.values()) {
      const attempt = attempts.find((a) => a.idempotencyKey === idempotencyKey);
      if (attempt) {
        attempt.status = "CONFIRMED";
        attempt.transactionHash = transactionHash;
        attempt.ledgerNumber = ledgerNumber;
        attempt.confirmedAt = new Date();
        break;
      }
    }
  }

  /**
   * Mark a submission as explicitly rejected by the server.
   * 
   * REJECTED means the server rejected the request before sending to chain,
   * so no transfer was initiated.
   */
  rejectSubmission(
    idempotencyKey: string,
    errorCode: string,
    errorMessage: string
  ): void {
    for (const attempts of this.submissionCache.values()) {
      const attempt = attempts.find((a) => a.idempotencyKey === idempotencyKey);
      if (attempt) {
        attempt.status = "REJECTED";
        attempt.errorCode = errorCode;
        attempt.errorMessage = errorMessage;
        break;
      }
    }
  }

  /**
   * Mark a submission as timed out (ambiguous state).
   * 
   * TIMEOUT means we didn't get a response within the timeout window,
   * so we don't know if the transfer succeeded or not.
   */
  timeoutSubmission(idempotencyKey: string): void {
    for (const attempts of this.submissionCache.values()) {
      const attempt = attempts.find((a) => a.idempotencyKey === idempotencyKey);
      if (attempt) {
        attempt.status = "TIMEOUT";
        // Calculate exponential backoff for retry
        const delayMs = Math.min(
          MIN_RETRY_DELAY_MS * Math.pow(2, attempt.attemptNumber - 1),
          MAX_RETRY_DELAY_MS
        );
        attempt.nextRetryEligibleAt = new Date(Date.now() + delayMs);
        break;
      }
    }
  }

  /**
   * Check if we can retry a failed or timed-out submission.
   * 
   * Returns false if:
   *   - Already confirmed
   *   - Max retries exceeded
   *   - Not enough time has passed for backoff
   */
  canRetrySubmission(
    campaignId: string,
    sponsorAddress: string,
    onChainState?: OnChainRefundState
  ): { canRetry: boolean; reason?: string } {
    const cacheKey = `${campaignId}:${sponsorAddress}`;
    const attempts = this.submissionCache.get(cacheKey) || [];

    if (attempts.length === 0) {
      return { canRetry: true };
    }

    const lastAttempt = attempts[attempts.length - 1];

    // If already confirmed, don't retry
    if (lastAttempt.status === "CONFIRMED") {
      return { canRetry: false, reason: "Refund already confirmed on-chain" };
    }

    // If explicitly rejected, don't retry
    if (lastAttempt.status === "REJECTED") {
      return { canRetry: false, reason: `Server rejected: ${lastAttempt.errorMessage}` };
    }

    // Check max retries
    if (lastAttempt.attemptNumber >= lastAttempt.maxRetries) {
      return { canRetry: false, reason: "Maximum retry attempts exceeded" };
    }

    // If timeout, check backoff delay
    if (lastAttempt.status === "TIMEOUT" && lastAttempt.nextRetryEligibleAt) {
      if (Date.now() < lastAttempt.nextRetryEligibleAt.getTime()) {
        const waitMs = lastAttempt.nextRetryEligibleAt.getTime() - Date.now();
        return { canRetry: false, reason: `Retry eligible in ${Math.ceil(waitMs / 1000)} seconds` };
      }
    }

    // If we have on-chain state indicating a refund exists, don't retry
    if (onChainState?.hasRefund) {
      return { canRetry: false, reason: "Refund already exists on-chain" };
    }

    return { canRetry: true };
  }

  /**
   * Create a retry attempt for a failed or timed-out submission.
   * 
   * Returns a new submission attempt with incremented attemptNumber.
   * Does NOT automatically confirm — the caller must handle the response.
   */
  createRetryAttempt(
    campaignId: string,
    sponsorAddress: string
  ): RefundSubmissionAttempt | null {
    const cacheKey = `${campaignId}:${sponsorAddress}`;
    const attempts = this.submissionCache.get(cacheKey) || [];

    if (attempts.length === 0) {
      return null;
    }

    const lastAttempt = attempts[attempts.length - 1];

    // Verify we can retry
    const { canRetry, reason } = this.canRetrySubmission(campaignId, sponsorAddress);
    if (!canRetry) {
      console.warn(`Cannot retry: ${reason}`);
      return null;
    }

    // Create new attempt with same idempotency key
    const newAttempt: RefundSubmissionAttempt = {
      id: `attempt-${Date.now()}`,
      campaignId,
      sponsorAddress,
      idempotencyKey: lastAttempt.idempotencyKey, // Reuse key for idempotency
      status: "INITIATED",
      submittedAt: new Date(),
      attemptNumber: lastAttempt.attemptNumber + 1,
      maxRetries: lastAttempt.maxRetries,
    };

    attempts.push(newAttempt);
    this.submissionCache.set(cacheKey, attempts);

    return newAttempt;
  }

  /**
   * Get the complete submission status for a sponsor.
   */
  getSubmissionStatus(
    campaignId: string,
    sponsorAddress: string
  ): RefundSubmissionStatus {
    const cacheKey = `${campaignId}:${sponsorAddress}`;
    const allAttempts = this.submissionCache.get(cacheKey) || [];

    const lastAttempt = allAttempts.length > 0 
      ? allAttempts[allAttempts.length - 1]
      : undefined;

    let currentStatus: RefundSubmissionStatus;
    let canRetry = false;
    let retryEligibleAt: Date | undefined;
    let retryReason: string | undefined;

    if (!lastAttempt) {
      currentStatus = "PENDING";
    } else if (lastAttempt.status === "CONFIRMED") {
      currentStatus = "CONFIRMED";
    } else if (lastAttempt.status === "REJECTED") {
      currentStatus = "REJECTED";
    } else if (lastAttempt.status === "TIMEOUT") {
      currentStatus = "TIMEOUT";
      const retryCheck = this.canRetrySubmission(campaignId, sponsorAddress);
      canRetry = retryCheck.canRetry;
      retryReason = retryCheck.reason;
      retryEligibleAt = lastAttempt.nextRetryEligibleAt;
    } else {
      currentStatus = "PENDING";
    }

    return {
      campaignId,
      sponsorAddress,
      currentStatus,
      lastAttempt,
      allAttempts,
      canRetry,
      retryEligibleAt,
      retryReason,
      isConfirmed: lastAttempt?.status === "CONFIRMED",
      confirmedTransactionHash: lastAttempt?.transactionHash,
    };
  }
}

export const refundSubmissionService = new CampaignRefundSubmissionService();
