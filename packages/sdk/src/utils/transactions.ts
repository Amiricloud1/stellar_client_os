/**
 * Transaction utilities for Fundable Stellar smart contracts.
 *
 * Provides convenience methods for waiting on AssembledTransaction confirmations
 * and handling transaction lifecycle events.
 */

import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { rpc } from "@stellar/stellar-sdk";
import {
  parseContractError,
  FundableStellarError,
  TransactionResubmissionError,
} from "./errors.js";

export { TransactionResubmissionError };

/**
 * Configuration options for waiting on a transaction
 */
export interface WaitForTransactionOptions {
  /**
   * Maximum time to wait for confirmation in milliseconds.
   * Default: 60000 (60 seconds)
   */
  timeout?: number;

  /**
   * Polling interval in milliseconds.
   * Default: 1000 (1 second)
   */
  pollInterval?: number;

  /**
   * Callback function invoked on each poll attempt
   * @param attempt - Current attempt number (1-indexed)
   * @param elapsedMs - Elapsed time in milliseconds
   */
  onPoll?: (attempt: number, elapsedMs: number) => void;
}

/**
 * Result of a successful transaction wait
 */
export interface TransactionWaitResult<T = unknown> {
  /** Transaction hash */
  hash: string;
  /** Ledger sequence number where transaction was included */
  ledger: number;
  /** Contract invocation result (if applicable) */
  result?: T;
}

/**
 * Waits for an AssembledTransaction to be confirmed on-chain.
 *
 * This is a convenience method that simplifies the developer experience by
 * automatically polling for transaction confirmation after signing and sending.
 *
 * @typeParam T - The result type of the contract invocation
 * @param tx - The AssembledTransaction to wait for
 * @param rpcUrl - The Soroban RPC URL to use for polling
 * @param options - Configuration options
 * @returns Promise resolving to transaction confirmation details
 * @throws {Error} If timeout is exceeded or transaction fails
 *
 * @example
 * ```typescript
 * import { PaymentStreamClient, waitForTransaction } from '@fundable/sdk';
 *
 * const client = new PaymentStreamClient(options);
 * const tx = await client.createStream(params);
 * await tx.signAndSend({ signTransaction: signer });
 *
 * const result = await waitForTransaction(tx, rpcUrl);
 * console.log('Stream created:', result.result); // Stream ID
 * console.log('Ledger:', result.ledger);
 * ```
 */
export async function waitForTransaction<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  options: WaitForTransactionOptions = {},
): Promise<TransactionWaitResult<T>> {
  const {
    timeout = 60000,
    pollInterval = 1000,
    onPoll,
  } = options;

  // Ensure the transaction has been sent
  const txHash = tx.signed?.hash().toString("hex");
  if (!txHash) {
    throw new Error(
      "Transaction has not been signed and sent. " +
      "Call signAndSend() first before waiting for confirmation.",
    );
  }

  const server = new rpc.Server(rpcUrl);
  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime <= timeout) {
    attempt++;
    const elapsedMs = Date.now() - startTime;

    try {
      // Invoke callback if provided
      if (onPoll) {
        onPoll(attempt, elapsedMs);
      }

      // Poll for transaction status
      const response = await server.getTransaction(txHash);

      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          hash: txHash,
          ledger: response.ledger,
          result: tx.result,
        };
      }

      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        // Parse the failed transaction result for better error messages
        const error = parseContractError(
          {
            resultXdr: response.resultXdr,
            message: `Transaction failed on ledger ${response.ledger}`,
          },
          "Transaction confirmation"
        );
        
        throw new FundableStellarError(error);
      }

      // Status is PENDING, continue polling
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (rpcError) {
      // Handle RPC errors
      if (rpcError instanceof Error) {
        if (rpcError instanceof FundableStellarError) {
          throw rpcError;
        }

        // If it's our custom error, re-throw
        if (
          rpcError.message.includes("Transaction confirmation timeout") ||
          rpcError.message.includes("Transaction failed on ledger")
        ) {
          throw rpcError;
        }

        // If it's a "not found" error, transaction may not be submitted yet
        if (rpcError.message.includes("not found")) {
          // Continue polling
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }
      }

      // For other RPC errors, re-throw with better context
      const parsedError = parseContractError(
        `Error polling transaction status: ${rpcError instanceof Error ? rpcError.message : String(rpcError)}`,
        "Transaction polling"
      );
      throw new FundableStellarError(parsedError);
    }
  }

  const timeoutError = parseContractError(
    `Transaction confirmation timeout after ${timeout}ms. Hash: ${txHash}`,
    "Transaction confirmation"
  );
  throw new FundableStellarError(timeoutError);
}

/**
 * Convenience method combining signAndSend with waitForTransaction.
 *
 * Sign, send, and automatically wait for confirmation in one call.
 *
 * @typeParam T - The result type of the contract invocation
 * @param tx - The AssembledTransaction to sign and send
 * @param rpcUrl - The Soroban RPC URL
 * @param signTransaction - Callback function to sign the transaction
 * @param options - Configuration options for waiting
 * @returns Promise resolving to transaction confirmation details
 * @throws {Error} If signing, sending, or confirmation fails
 *
 * @example
 * ```typescript
 * import { PaymentStreamClient, signAndWait } from '@fundable/sdk';
 *
 * const client = new PaymentStreamClient(options);
 * const tx = await client.createStream(params);
 *
 * const result = await signAndWait(
 *   tx,
 *   rpcUrl,
 *   (xdr) => wallet.signTransaction(xdr),
 *   { timeout: 90000 }
 * );
 *
 * console.log('Stream created with ID:', result.result);
 * ```
 */
export async function signAndWait<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  signTransaction: (xdr: string) => Promise<string>,
  options: WaitForTransactionOptions = {},
): Promise<TransactionWaitResult<T>> {
  // Sign and send the transaction
  await tx.signAndSend({
    signTransaction: async (xdr: string) => ({
      signedTxXdr: await signTransaction(xdr),
    }),
  });

  // Wait for confirmation
  return waitForTransaction(tx, rpcUrl, options);
}

/**
 * Classification of a transaction's on-chain status, as observed via
 * `getTransaction`.
 *
 * - `confirmed`: The transaction succeeded on-chain. It MUST NOT be resubmitted.
 * - `failed`: The transaction was included on-chain but failed. It MUST NOT be
 *   be resubmitted (the operation was already executed and rejected).
 * - `pending`: The transaction is known to the network but not yet finalized.
 *   It MUST NOT be resubmitted; wait for it to resolve instead.
 * - `unknown`: The transaction could not be found (e.g. `NOT_FOUND`). This is
 *   the only status for which resubmission is considered safe.
 */
export type TransactionStatus = "confirmed" | "failed" | "pending" | "unknown";

/**
 * Result of classifying a transaction's status.
 */
export interface TransactionStatusResult {
  /** The transaction hash that was queried */
  hash: string;
  /** The classified status */
  status: TransactionStatus;
  /** Ledger sequence where the transaction was included (confirmed/failed only) */
  ledger?: number;
  /** Raw RPC status string, when available */
  rawStatus?: string;
}

/**
 * Options for {@link classifyTransactionStatus} and {@link resubmitTransaction}.
 */
export interface ResubmitTransactionOptions {
  /**
   * Maximum time to wait for a definitive status before giving up, in
   * milliseconds. Default: 30000 (30 seconds).
   */
  timeout?: number;

  /**
   * Polling interval in milliseconds while the status is `pending`.
   * Default: 1000 (1 second).
   */
  pollInterval?: number;

  /**
   * Callback invoked on each poll attempt.
   * @param attempt - Current attempt number (1-indexed)
   * @param elapsedMs - Elapsed time in milliseconds
   * @param status - The status observed on this attempt
   */
  onPoll?: (attempt: number, elapsedMs: number, status: TransactionStatus) => void;
}

/**
 * Queries the network for a transaction's status and classifies it.
 *
 * This performs a single `getTransaction` call (no polling) and maps the RPC
 * response to a {@link TransactionStatus}. Any RPC error (including
 * `NOT_FOUND`) is treated as `unknown`, which is the only status that permits
 * resubmission.
 *
 * @param txHash - The transaction hash (hex string)
 * @param rpcUrl - The Soroban RPC URL
 * @returns The classified status
 *
 * @example
 * ```typescript
 * const status = await classifyTransactionStatus(hash, rpcUrl);
 * if (status.status === "unknown") {
 *   // safe to resubmit
 * }
 * ```
 */
export async function classifyTransactionStatus(
  txHash: string,
  rpcUrl: string,
): Promise<TransactionStatusResult> {
  const server = new rpc.Server(rpcUrl);

  try {
    const response = await server.getTransaction(txHash);

    switch (response.status) {
      case rpc.Api.GetTransactionStatus.SUCCESS:
        return {
          hash: txHash,
          status: "confirmed",
          ledger: response.ledger,
          rawStatus: response.status,
        };
      case rpc.Api.GetTransactionStatus.FAILED:
        return {
          hash: txHash,
          status: "failed",
          ledger: response.ledger,
          rawStatus: response.status,
        };
      case rpc.Api.GetTransactionStatus.NOT_FOUND:
        return { hash: txHash, status: "unknown", rawStatus: response.status };
      default:
        // Any other known status (e.g. PENDING) means the network is aware of
        // the transaction; it must not be resubmitted.
        return {
          hash: txHash,
          status: "pending",
          rawStatus: String(response.status),
        };
    }
  } catch {
    // RPC errors (network failures, "not found", etc.) are ambiguous. Treat as
    // unknown so the caller can decide, but never as confirmed.
    return { hash: txHash, status: "unknown" };
  }
}

/**
 * Safely resubmits a transaction after an ambiguous timeout.
 *
 * Before any resubmission, this function queries `getTransaction` to determine
 * the transaction's current status. It only invokes the provided `resubmit`
 * callback when the status is definitively **not** confirmed or failed — i.e.
 * when the transaction is `unknown` (not found on-chain). This prevents
 * double-spending or duplicate operations caused by blindly retrying a
 * transaction that already succeeded.
 *
 * Safe retry conditions:
 * - The transaction is `unknown` (NOT_FOUND / RPC error) → resubmit.
 *
 * Unsafe conditions (the callback is NOT invoked):
 * - `confirmed` → throws {@link TransactionResubmissionError} (already executed).
 * - `failed` → throws {@link TransactionResubmissionError} (already executed).
 * - `pending` → polls until it resolves or the timeout elapses; if it is still
 *   pending at timeout, throws {@link TransactionResubmissionError}.
 *
 * @typeParam T - The result type of the resubmitted operation
 * @param txHash - The original transaction hash (hex string)
 * @param rpcUrl - The Soroban RPC URL
 * @param resubmit - Callback that performs the actual resubmission. It is only
 *   called when it is safe to do so.
 * @param options - Timeout/poll configuration
 * @returns The value returned by `resubmit`
 * @throws {TransactionResubmissionError} If resubmission is unsafe or the
 *   status cannot be resolved within the timeout.
 *
 * @example
 * ```typescript
 * try {
 *   const result = await resubmitTransaction(
 *     hash,
 *     rpcUrl,
 *     () => client.createStream(params).then((tx) => tx.signAndSend({ signTransaction })),
 *   );
 * } catch (err) {
 *   if (err instanceof TransactionResubmissionError) {
 *     // The original transaction may already have succeeded; do not retry.
 *   }
 * }
 * ```
 */
export async function resubmitTransaction<T = unknown>(
  txHash: string,
  rpcUrl: string,
  resubmit: () => Promise<T>,
  options: ResubmitTransactionOptions = {},
): Promise<T> {
  const { timeout = 30000, pollInterval = 1000, onPoll } = options;
  const startTime = Date.now();
  let attempt = 0;

  // Poll until we get a definitive (non-pending) status or time out.
  while (true) {
    attempt++;
    const elapsedMs = Date.now() - startTime;

    const result = await classifyTransactionStatus(txHash, rpcUrl);
    if (onPoll) {
      onPoll(attempt, elapsedMs, result.status);
    }

    switch (result.status) {
      case "confirmed":
        throw new TransactionResubmissionError(
          "Transaction is already confirmed on-chain and must not be resubmitted.",
          { hash: txHash, status: result.status, ledger: result.ledger },
        );
      case "failed":
        throw new TransactionResubmissionError(
          "Transaction was included on-chain but failed and must not be resubmitted.",
          { hash: txHash, status: result.status, ledger: result.ledger },
        );
      case "unknown":
        // Safe to resubmit: the network has no record of this transaction.
        return resubmit();
      case "pending":
        if (Date.now() - startTime >= timeout) {
          throw new TransactionResubmissionError(
            `Transaction status still pending after ${timeout}ms; refusing to resubmit. Hash: ${txHash}`,
            { hash: txHash, status: result.status },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        break;
    }
  }
}
