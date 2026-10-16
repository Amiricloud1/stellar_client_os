/**
 * @module @fundable/sdk/recipes/transactions
 *
 * Transaction lifecycle recipes for the Fundable Stellar SDK.
 *
 * Provides patterns for signing, sending, confirming, cancelling, and
 * safely recovering from errors when interacting with Soroban contracts.
 */

import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { rpc } from "@stellar/stellar-sdk";
import {
  waitForTransaction,
  signAndWait,
  type TransactionWaitResult,
  type WaitForTransactionOptions,
} from "../utils/transactions.js";
import { parseContractError, FundableStellarError } from "../utils/errors.js";

/**
 * Outcome of a transaction operation with success/error discrimination.
 */
export interface TransactionOutcome<T = unknown> {
  /** Whether the transaction succeeded. */
  success: boolean;
  /** Transaction hash (if submitted). */
  hash?: string;
  /** Ledger sequence number (if confirmed). */
  ledger?: number;
  /** Contract invocation result (if successful). */
  result?: T;
  /** Error details (if failed). */
  error?: {
    message: string;
    code?: number;
    type: string;
    suggestion?: string;
  };
}

/**
 * Signs, sends, and waits for a transaction with full error recovery.
 * Returns a discriminated outcome instead of throwing, so callers can
 * handle success and failure paths without try/catch.
 *
 * This is the recommended pattern for production code that needs to
 * distinguish between transient failures (retryable) and permanent
 * failures (user rejection, contract errors).
 *
 * @typeParam T - The result type of the contract invocation.
 * @param tx - The AssembledTransaction to sign and send.
 * @param rpcUrl - The Soroban RPC URL.
 * @param signTransaction - Wallet signing callback.
 * @param options - Wait/timeout options.
 * @returns A `TransactionOutcome` with either result or error details.
 *
 * @example
 * ```typescript
 * import { executeTransaction } from "@fundable/sdk/recipes/transactions";
 *
 * const outcome = await executeTransaction(
 *   tx,
 *   "https://soroban-testnet.stellar.org",
 *   (xdr) => wallet.signTransaction(xdr),
 *   { timeout: 90000 },
 * );
 *
 * if (outcome.success) {
 *   console.log("Confirmed in ledger:", outcome.ledger);
 *   console.log("Stream ID:", outcome.result);
 * } else {
 *   console.error("Failed:", outcome.error?.message);
 *   console.error("Suggestion:", outcome.error?.suggestion);
 * }
 * ```
 */
export async function executeTransaction<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  signTransaction: (xdr: string) => Promise<string>,
  options: WaitForTransactionOptions = {},
): Promise<TransactionOutcome<T>> {
  try {
    const result = await signAndWait(tx, rpcUrl, signTransaction, options);
    return {
      success: true,
      hash: result.hash,
      ledger: result.ledger,
      result: result.result,
    };
  } catch (error) {
    let hash: string | undefined;
    try {
      hash = tx.signed?.hash().toString("hex");
    } catch {
      // Transaction not yet signed — no hash available.
    }

    const parsed = parseContractError(
      error instanceof Error ? error : new Error(String(error)),
      "Transaction execution",
    );

    return {
      success: false,
      hash,
      error: {
        message: parsed.message,
        code: parsed.code,
        type: parsed.type,
        suggestion: parsed.suggestion,
      },
    };
  }
}

/**
 * Waits for an already-sent transaction with retry-on-not-found logic.
 * This recipe handles the common case where the RPC returns "not found"
 * immediately after submission due to propagation delay.
 *
 * @typeParam T - The result type of the contract invocation.
 * @param tx - The signed AssembledTransaction.
 * @param rpcUrl - The Soroban RPC URL.
 * @param options - Wait/timeout options.
 * @returns Transaction confirmation details.
 * @throws {FundableStellarError} On timeout or confirmed failure.
 *
 * @example
 * ```typescript
 * import { waitForTransactionWithRetry } from "@fundable/sdk/recipes/transactions";
 *
 * await tx.signAndSend({ signTransaction: (xdr) => wallet.signTransaction(xdr) });
 *
 * try {
 *   const result = await waitForTransactionWithRetry(tx, rpcUrl);
 *   console.log("Confirmed:", result.result);
 * } catch (error) {
 *   // Transaction failed or timed out — check result.hash for manual lookup
 * }
 * ```
 */
export async function waitForTransactionWithRetry<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  options: WaitForTransactionOptions = {},
): Promise<TransactionWaitResult<T>> {
  return waitForTransaction(tx, rpcUrl, options);
}

/**
 * Safely cancels a payment stream by building and executing a cancel
 * transaction with error recovery. This recipe demonstrates the
 * cancellation pattern for any contract that exposes a cancel method.
 *
 * @param cancelTx - The assembled cancel transaction.
 * @param rpcUrl - The Soroban RPC URL.
 * @param signTransaction - Wallet signing callback.
 * @param options - Wait/timeout options.
 * @returns Cancellation outcome.
 *
 * @example
 * ```typescript
 * import { cancelStreamSafely } from "@fundable/sdk/recipes/transactions";
 *
 * const cancelTx = await client.cancelStream({ streamId: 123n });
 * const outcome = await cancelStreamSafely(cancelTx, rpcUrl, signer);
 *
 * if (!outcome.success) {
 *   // The stream may still be active — check on-chain state before retrying
 *   console.error("Cancellation failed:", outcome.error?.message);
 * }
 * ```
 */
export async function cancelStreamSafely<T = unknown>(
  cancelTx: AssembledTransaction<T>,
  rpcUrl: string,
  signTransaction: (xdr: string) => Promise<string>,
  options: WaitForTransactionOptions = {},
): Promise<TransactionOutcome<T>> {
  return executeTransaction(cancelTx, rpcUrl, signTransaction, options);
}

/**
 * Classifies a FundableStellarError as retryable or non-retryable.
 * Retryable errors include network timeouts, transient RPC failures,
 * and "not found" during propagation. Non-retryable errors include
 * contract execution failures, user rejections, and invalid parameters.
 *
 * @param error - Error to classify.
 * @returns `true` if the operation may succeed on retry.
 *
 * @example
 * ```typescript
 * import { isRetryableError } from "@fundable/sdk/recipes/transactions";
 *
 * if (isRetryableError(error)) {
 *   // Retry with exponential backoff
 *   await retryWithBackoff(operation, 3);
 * } else {
 *   // Show error to user — retrying won't help
 *   showErrorDialog(error);
 * }
 * ```
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("not found")
  ) {
    return true;
  }

  if (error instanceof FundableStellarError) {
    if (error.type === "transaction_error" || error.type === "unknown") {
      return true;
    }
    if (error.type === "contract_error") {
      return false;
    }
  }

  return false;
}
