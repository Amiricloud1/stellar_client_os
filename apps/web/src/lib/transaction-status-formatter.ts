/**
 * Transaction Status Formatter - Unified API Response Format (Issue #4)
 *
 * Standardizes transaction status responses across all API endpoints
 * to use canonical transaction states and error taxonomy.
 *
 * Usage:
 * ```typescript
 * const formatter = new TransactionStatusFormatter();
 * const apiResponse = formatter.formatResponse(legacyTransaction, 'offramp');
 * res.json(apiResponse);
 * ```
 */

import {
  CanonicalTransactionState,
  CanonicalTransactionStatus,
  TransactionErrorCategory,
  LedgerBinding,
  createTransactionStatus,
  describeState,
  toLegacyState,
} from '@fundable/sdk';

/**
 * Standardized API response for transaction status queries
 */
export interface ApiTransactionStatusResponse {
  /** The canonical transaction status */
  transaction: CanonicalTransactionStatus;

  /** API response metadata */
  meta: {
    /** API version that produced this response */
    apiVersion: string;

    /** ISO 8601 timestamp of when this status was fetched */
    fetchedAt: string;

    /** Network this transaction is on */
    network: string;

    /** User-friendly state description */
    stateDescription: string;

    /** Whether the transaction is still changing state */
    isTerminal: boolean;

    /** Suggested polling interval (ms) for PENDING states */
    suggestedPollIntervalMs?: number;
  };

  /** Legacy domain-specific state (for backward compatibility) */
  legacyState?: string;

  /** Warnings or additional info */
  warnings?: string[];
}

/**
 * Standardized error response for transaction status queries
 */
export interface ApiTransactionErrorResponse {
  error: {
    code: string;
    message: string;
    category: TransactionErrorCategory;
    suggestion?: string;
  };

  meta: {
    apiVersion: string;
    fetchedAt: string;
    requestId?: string;
  };
}

/**
 * Service for formatting transaction responses consistently across the API
 */
export class TransactionStatusFormatter {
  private readonly apiVersion = '1.0.0';

  /**
   * Format a transaction object from any domain into canonical response
   *
   * @param transaction Transaction object (structure varies by domain)
   * @param domain Domain context (offramp, sponsorship, campaign, etc)
   * @returns Standardized API response
   */
  formatResponse(
    transaction: any,
    domain: string
  ): ApiTransactionStatusResponse {
    const canonical = this.toCanonical(transaction, domain);

    return {
      transaction: canonical,
      meta: {
        apiVersion: this.apiVersion,
        fetchedAt: new Date().toISOString(),
        network: canonical.network,
        stateDescription: describeState(canonical.state),
        isTerminal: canonical.state === CanonicalTransactionState.CONFIRMED ||
                    canonical.state === CanonicalTransactionState.FAILED,
        suggestedPollIntervalMs: this.suggestedPollInterval(canonical.state),
      },
      legacyState: toLegacyState(canonical.state, domain),
    };
  }

  /**
   * Format an error response consistently
   */
  formatError(
    message: string,
    category: TransactionErrorCategory,
    code: string = 'transaction_error',
    suggestion?: string
  ): ApiTransactionErrorResponse {
    return {
      error: {
        code,
        message,
        category,
        suggestion,
      },
      meta: {
        apiVersion: this.apiVersion,
        fetchedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Convert domain-specific transaction to canonical format
   */
  private toCanonical(transaction: any, domain: string): CanonicalTransactionStatus {
    switch (domain) {
      case 'offramp':
        return this.fromOfframpTransaction(transaction);
      case 'sponsorship':
        return this.fromSponsorshipTransaction(transaction);
      case 'campaign':
        return this.fromCampaignTransaction(transaction);
      case 'payment-stream':
        return this.fromPaymentStreamTransaction(transaction);
      default:
        return this.fromGenericTransaction(transaction);
    }
  }

  /**
   * Convert offramp transaction to canonical
   */
  private fromOfframpTransaction(tx: any): CanonicalTransactionStatus {
    let state: CanonicalTransactionState;
    let failureCategory: TransactionErrorCategory | undefined;

    switch (tx.status) {
      case 'pending':
        state = CanonicalTransactionState.PREPARING;
        break;
      case 'processing':
        state = CanonicalTransactionState.PENDING;
        break;
      case 'completed':
        state = CanonicalTransactionState.CONFIRMED;
        break;
      case 'failed':
        state = CanonicalTransactionState.FAILED;
        failureCategory = this.categorizeOfframpFailure(tx);
        break;
      case 'expired':
        state = CanonicalTransactionState.FAILED;
        failureCategory = TransactionErrorCategory.EXPIRED;
        break;
      default:
        state = CanonicalTransactionState.PREPARING;
    }

    const ledgerBinding = tx.ledgerSequence
      ? {
          ledgerSequence: tx.ledgerSequence,
          ledgerTimestamp: new Date(tx.ledgerTimestamp || Date.now()),
          txIndex: tx.txIndex,
        }
      : undefined;

    return {
      id: tx.id || tx.transactionHash,
      state,
      network: tx.network || 'testnet',
      updatedAt: new Date(tx.updatedAt || Date.now()),
      ledgerBinding,
      failureCategory,
      failureMessage: tx.errorMessage,
      recoverySuggestion: this.suggestOfframpRecovery(tx),
      pendingDurationMs: state === CanonicalTransactionState.PENDING
        ? Date.now() - new Date(tx.createdAt || Date.now()).getTime()
        : undefined,
      operationType: 'offramp-withdrawal',
      idempotencyKey: tx.idempotencyKey,
    };
  }

  /**
   * Convert sponsorship transaction to canonical
   */
  private fromSponsorshipTransaction(tx: any): CanonicalTransactionStatus {
    let state: CanonicalTransactionState;

    switch (tx.state) {
      case 'draft':
        state = CanonicalTransactionState.PREPARING;
        break;
      case 'submitted':
        state = CanonicalTransactionState.PENDING;
        break;
      case 'confirmed':
        state = CanonicalTransactionState.CONFIRMED;
        break;
      case 'rejected':
        state = CanonicalTransactionState.FAILED;
        break;
      default:
        state = CanonicalTransactionState.PREPARING;
    }

    const ledgerBinding = tx.ledgerSequence
      ? {
          ledgerSequence: tx.ledgerSequence,
          ledgerTimestamp: new Date(tx.ledgerTimestamp || Date.now()),
        }
      : undefined;

    return {
      id: tx.id,
      state,
      network: tx.network || 'testnet',
      updatedAt: new Date(tx.updatedAt || Date.now()),
      ledgerBinding,
      failureMessage: tx.rejectionReason,
      operationType: 'sponsorship-submission',
    };
  }

  /**
   * Convert campaign transaction to canonical
   */
  private fromCampaignTransaction(tx: any): CanonicalTransactionStatus {
    let state: CanonicalTransactionState;

    switch (tx.state) {
      case 'draft':
        state = CanonicalTransactionState.PREPARING;
        break;
      case 'pending':
        state = CanonicalTransactionState.PENDING;
        break;
      case 'confirmed':
      case 'completed':
        state = CanonicalTransactionState.CONFIRMED;
        break;
      case 'failed':
      case 'cancelled':
        state = CanonicalTransactionState.FAILED;
        break;
      default:
        state = CanonicalTransactionState.PREPARING;
    }

    const ledgerBinding = tx.ledgerSequence
      ? {
          ledgerSequence: tx.ledgerSequence,
          ledgerTimestamp: new Date(tx.ledgerTimestamp || Date.now()),
        }
      : undefined;

    return {
      id: tx.id,
      state,
      network: tx.network || 'testnet',
      updatedAt: new Date(tx.updatedAt || Date.now()),
      ledgerBinding,
      failureMessage: tx.cancelReason,
      operationType: 'campaign-milestone-payout',
    };
  }

  /**
   * Convert payment-stream transaction to canonical
   */
  private fromPaymentStreamTransaction(tx: any): CanonicalTransactionStatus {
    let state: CanonicalTransactionState;

    switch (tx.status) {
      case 'draft':
        state = CanonicalTransactionState.PREPARING;
        break;
      case 'active':
      case 'pending':
        state = CanonicalTransactionState.PENDING;
        break;
      case 'claimed':
      case 'completed':
        state = CanonicalTransactionState.CONFIRMED;
        break;
      case 'failed':
      case 'cancelled':
        state = CanonicalTransactionState.FAILED;
        break;
      default:
        state = CanonicalTransactionState.PREPARING;
    }

    const ledgerBinding = tx.ledgerSequence
      ? {
          ledgerSequence: tx.ledgerSequence,
          ledgerTimestamp: new Date(tx.ledgerTimestamp || Date.now()),
        }
      : undefined;

    return {
      id: tx.id,
      state,
      network: tx.network || 'testnet',
      updatedAt: new Date(tx.updatedAt || Date.now()),
      ledgerBinding,
      failureMessage: tx.errorMessage,
      operationType: 'payment-stream',
    };
  }

  /**
   * Generic transaction converter for unknown domains
   */
  private fromGenericTransaction(tx: any): CanonicalTransactionStatus {
    let state: CanonicalTransactionState = CanonicalTransactionState.PENDING;

    // Try to infer state from common field names
    if (tx.state) {
      switch (tx.state.toLowerCase()) {
        case 'pending':
        case 'submitted':
        case 'processing':
          state = CanonicalTransactionState.PENDING;
          break;
        case 'confirmed':
        case 'completed':
        case 'success':
          state = CanonicalTransactionState.CONFIRMED;
          break;
        case 'failed':
        case 'rejected':
        case 'expired':
          state = CanonicalTransactionState.FAILED;
          break;
        default:
          state = CanonicalTransactionState.PREPARING;
      }
    }

    const ledgerBinding = tx.ledgerSequence
      ? {
          ledgerSequence: tx.ledgerSequence,
          ledgerTimestamp: new Date(tx.ledgerTimestamp || Date.now()),
        }
      : undefined;

    return {
      id: tx.id || tx.txId || tx.hash,
      state,
      network: tx.network || 'testnet',
      updatedAt: new Date(tx.updatedAt || tx.lastUpdated || Date.now()),
      ledgerBinding,
      failureMessage: tx.errorMessage || tx.error,
    };
  }

  /**
   * Categorize offramp failure reason
   */
  private categorizeOfframpFailure(tx: any): TransactionErrorCategory {
    if (!tx.errorMessage) {
      return TransactionErrorCategory.UNKNOWN;
    }

    const msg = tx.errorMessage.toLowerCase();

    if (msg.includes('rejected') || msg.includes('failed')) {
      return TransactionErrorCategory.REJECTED;
    }
    if (msg.includes('invalid') || msg.includes('malformed')) {
      return TransactionErrorCategory.INVALID;
    }
    if (msg.includes('network') || msg.includes('connection')) {
      return TransactionErrorCategory.NETWORK;
    }
    if (msg.includes('expired') || msg.includes('timeout')) {
      return TransactionErrorCategory.EXPIRED;
    }

    return TransactionErrorCategory.UNKNOWN;
  }

  /**
   * Suggest recovery action for offramp failure
   */
  private suggestOfframpRecovery(tx: any): string | undefined {
    if (tx.status !== 'failed') {
      return undefined;
    }

    if (tx.errorMessage?.includes('fee')) {
      return 'Increase the withdrawal fee and retry';
    }
    if (tx.errorMessage?.includes('balance')) {
      return 'Ensure sufficient balance in source account';
    }
    if (tx.errorMessage?.includes('auth')) {
      return 'Check that you have authorization on the destination account';
    }

    return undefined;
  }

  /**
   * Suggest polling interval based on state
   */
  private suggestedPollInterval(state: CanonicalTransactionState): number | undefined {
    switch (state) {
      case CanonicalTransactionState.PREPARING:
        return undefined; // Not submitted yet
      case CanonicalTransactionState.PENDING:
        return 3000; // Poll every 3 seconds
      default:
        return undefined; // Terminal states; stop polling
    }
  }
}
