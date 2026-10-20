/**
 * Offramp Settlement Service — Trust Boundary Enforcement & Reconciliation Engine
 *
 * Implements deterministic settlement boundaries:
 * 1. User <-> System Boundary: Quote expiry validation and TTL enforcement.
 * 2. System <-> Bridge Boundary: Bridge confirmation tracking and timeout monitoring.
 * 3. System <-> Provider Boundary: Idempotent callback processing, duplicate callback
 *    deduplication, provider failure handling, and delayed settlement reconciliation.
 */

import {
  PayoutStatus,
  ProviderCallbackPayload,
  ReconciliationResult,
  SettlementFailureCategory,
  SettlementRecord,
  DelayedSettlementRecord,
  SETTLEMENT_CONFIG,
} from "@/types/offramp";

export class QuoteExpiredError extends Error {
  constructor(message = "Offramp quote has expired. Please refresh your quote.") {
    super(message);
    this.name = "QuoteExpiredError";
  }
}

export class InvalidSettlementStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSettlementStateError";
  }
}

export interface CreateSettlementInput {
  transactionReference: string;
  providerId: string;
  walletAddress: string;
  token: string;
  amount: number;
  fiatAmount: number;
  currency: string;
  bankCode: string;
  accountNumber: string;
  quoteExpiresAt: string;
}

export class OfframpSettlementService {
  private settlements = new Map<string, SettlementRecord>();
  private processedCallbackIds = new Set<string>();

  /**
   * Validates if a quote timestamp is expired relative to current time.
   */
  public isQuoteExpired(expiresAt: string | number | Date, now: number = Date.now()): boolean {
    if (!expiresAt) return true;
    const expiryMs = typeof expiresAt === "number" ? expiresAt : new Date(expiresAt).getTime();
    if (isNaN(expiryMs)) return true;
    return now >= expiryMs;
  }

  /**
   * Asserts that a quote has not expired. Throws QuoteExpiredError if expired.
   */
  public assertQuoteNotExpired(expiresAt: string | undefined, now: number = Date.now()): void {
    if (!expiresAt || this.isQuoteExpired(expiresAt, now)) {
      throw new QuoteExpiredError();
    }
  }

  /**
   * Creates a new settlement record with strict quote expiry boundary check.
   */
  public createSettlement(input: CreateSettlementInput, now: number = Date.now()): SettlementRecord {
    this.assertQuoteNotExpired(input.quoteExpiresAt, now);

    const record: SettlementRecord = {
      id: input.transactionReference,
      transactionReference: input.transactionReference,
      providerId: input.providerId,
      walletAddress: input.walletAddress,
      token: input.token,
      amount: input.amount,
      fiatAmount: input.fiatAmount,
      currency: input.currency,
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
      status: "pending",
      quoteExpiresAt: input.quoteExpiresAt,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      processedCallbacks: [],
    };

    this.settlements.set(input.transactionReference, record);
    return record;
  }

  /**
   * Retrieves a settlement record by transaction reference.
   */
  public getSettlement(transactionReference: string): SettlementRecord | undefined {
    return this.settlements.get(transactionReference);
  }

  /**
   * Confirms on-chain bridge transaction execution.
   */
  public confirmBridgeTransaction(
    transactionReference: string,
    bridgeTxHash: string,
    now: number = Date.now()
  ): SettlementRecord {
    const record = this.settlements.get(transactionReference);
    if (!record) {
      throw new Error(`Settlement not found: ${transactionReference}`);
    }

    if (record.status === "completed" || record.status === "failed") {
      throw new InvalidSettlementStateError(
        `Cannot confirm bridge transaction for terminal settlement state: ${record.status}`
      );
    }

    record.bridgeTxHash = bridgeTxHash;
    record.status = "confirmed";
    record.updatedAt = new Date(now).toISOString();
    return record;
  }

  /**
   * Processes a provider callback with strict idempotency and duplicate deduplication.
   * Handles duplicate callbacks, delayed settlement reconciliation, and terminal state protection.
   */
  public processProviderCallback(
    callback: ProviderCallbackPayload,
    now: number = Date.now()
  ): ReconciliationResult {
    const timestampStr = new Date(now).toISOString();
    const record = this.settlements.get(callback.transactionReference);

    if (!record) {
      return {
        transactionReference: callback.transactionReference,
        previousStatus: "pending",
        currentStatus: callback.status,
        actionTaken: "none",
        isDuplicate: false,
        auditTimestamp: timestampStr,
        notes: "Settlement record not found in registry",
      };
    }

    const previousStatus = record.status;

    // Check 1: Idempotency by callbackId
    if (this.processedCallbackIds.has(callback.callbackId) || record.processedCallbacks.includes(callback.callbackId)) {
      return {
        transactionReference: callback.transactionReference,
        previousStatus,
        currentStatus: record.status,
        actionTaken: "duplicate_ignored",
        isDuplicate: true,
        auditTimestamp: timestampStr,
        notes: `Duplicate callbackId ${callback.callbackId} detected and ignored`,
      };
    }

    // Check 2: Terminal State Protection
    // Once completed or failed, ignore redundant callbacks of the same or earlier status
    if (record.status === "completed") {
      this.processedCallbackIds.add(callback.callbackId);
      record.processedCallbacks.push(callback.callbackId);
      return {
        transactionReference: callback.transactionReference,
        previousStatus,
        currentStatus: "completed",
        actionTaken: "duplicate_ignored",
        isDuplicate: true,
        auditTimestamp: timestampStr,
        notes: "Settlement is already completed; ignoring callback",
      };
    }

    // Mark callbackId as processed
    this.processedCallbackIds.add(callback.callbackId);
    record.processedCallbacks.push(callback.callbackId);

    // Check 3: Delayed settlement reconciliation
    const wasDelayed = record.status === "delayed" || record.status === "timeout";

    // State transition
    record.status = callback.status;
    record.updatedAt = timestampStr;

    if (callback.status === "completed") {
      record.completedAt = callback.timestamp || timestampStr;
      if (wasDelayed) {
        record.reconciledAt = timestampStr;
        return {
          transactionReference: callback.transactionReference,
          previousStatus,
          currentStatus: "completed",
          actionTaken: "reconciled",
          isDuplicate: false,
          auditTimestamp: timestampStr,
          notes: "Delayed settlement successfully reconciled to completed",
        };
      }
    } else if (callback.status === "failed") {
      record.failureCategory = callback.failureCategory || "provider_rejected";
      record.failureReason = callback.message || "Provider indicated payout failure";
    }

    return {
      transactionReference: callback.transactionReference,
      previousStatus,
      currentStatus: record.status,
      actionTaken: "transitioned",
      isDuplicate: false,
      auditTimestamp: timestampStr,
      notes: `Status transitioned from ${previousStatus} to ${record.status}`,
    };
  }

  /**
   * Evaluates if a settlement is delayed or timed out based on SLA thresholds.
   */
  public checkSettlementTimeout(
    transactionReference: string,
    now: number = Date.now()
  ): { isDelayed: boolean; isTimedOut: boolean; status: PayoutStatus } {
    const record = this.settlements.get(transactionReference);
    if (!record) {
      throw new Error(`Settlement not found: ${transactionReference}`);
    }

    if (record.status === "completed" || record.status === "failed" || record.status === "expired") {
      return { isDelayed: false, isTimedOut: false, status: record.status };
    }

    const createdMs = new Date(record.createdAt).getTime();
    const elapsed = now - createdMs;

    const isTimedOut = elapsed >= SETTLEMENT_CONFIG.BRIDGE_TIMEOUT_MS;
    const isDelayed = elapsed >= SETTLEMENT_CONFIG.DELAYED_SETTLEMENT_THRESHOLD_MS;

    if (isTimedOut && record.status !== "timeout") {
      record.status = "timeout";
      record.failureCategory = "system_timeout";
      record.failureReason = `Settlement exceeded maximum timeout threshold (${SETTLEMENT_CONFIG.BRIDGE_TIMEOUT_MS}ms)`;
      record.updatedAt = new Date(now).toISOString();
    } else if (isDelayed && record.status !== "delayed" && record.status !== "timeout") {
      record.status = "delayed";
      record.updatedAt = new Date(now).toISOString();
    }

    return { isDelayed, isTimedOut, status: record.status };
  }

  /**
   * Reconciles a delayed or timed-out settlement against an authoritative provider check.
   */
  public async reconcileSettlement(
    transactionReference: string,
    providerLookup: () => Promise<{ status: PayoutStatus; failureCategory?: SettlementFailureCategory; message?: string }>,
    now: number = Date.now()
  ): Promise<ReconciliationResult> {
    const record = this.settlements.get(transactionReference);
    if (!record) {
      throw new Error(`Settlement not found: ${transactionReference}`);
    }

    const previousStatus = record.status;
    const lookupResult = await providerLookup();
    const timestampStr = new Date(now).toISOString();

    record.status = lookupResult.status;
    record.updatedAt = timestampStr;
    record.reconciledAt = timestampStr;

    if (lookupResult.status === "completed") {
      record.completedAt = timestampStr;
    } else if (lookupResult.status === "failed") {
      record.failureCategory = lookupResult.failureCategory || "provider_rejected";
      record.failureReason = lookupResult.message || "Reconciliation discovered provider failure";
    }

    return {
      transactionReference,
      previousStatus,
      currentStatus: record.status,
      actionTaken: "reconciled",
      isDuplicate: false,
      auditTimestamp: timestampStr,
      notes: `Reconciled via provider lookup: ${previousStatus} -> ${record.status}`,
    };
  }

  /**
   * Lists all settlements currently in delayed or timeout status.
   */
  public listDelayedSettlements(now: number = Date.now()): DelayedSettlementRecord[] {
    const results: DelayedSettlementRecord[] = [];

    for (const record of this.settlements.values()) {
      const createdMs = new Date(record.createdAt).getTime();
      const elapsed = now - createdMs;

      if (
        record.status === "delayed" ||
        record.status === "timeout" ||
        (elapsed >= SETTLEMENT_CONFIG.DELAYED_SETTLEMENT_THRESHOLD_MS &&
          record.status !== "completed" &&
          record.status !== "failed" &&
          record.status !== "expired")
      ) {
        results.push({
          transactionReference: record.transactionReference,
          providerId: record.providerId,
          status: record.status,
          createdAt: record.createdAt,
          delayedDurationMs: elapsed,
          attemptCount: record.processedCallbacks.length,
          lastReconciledAt: record.reconciledAt,
        });
      }
    }

    return results;
  }

  /**
   * Resets in-memory storage (for testing).
   */
  public clear(): void {
    this.settlements.clear();
    this.processedCallbackIds.clear();
  }
}

export const offrampSettlementService = new OfframpSettlementService();
