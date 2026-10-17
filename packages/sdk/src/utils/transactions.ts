/**
 * Transaction utilities for Fundable Stellar smart contracts.
 *
 * Provides convenience methods for waiting on AssembledTransaction confirmations
 * and handling transaction lifecycle events.
 */

import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { rpc } from "@stellar/stellar-sdk";
import { parseContractError, FundableStellarError } from "./errors.js";

/**
 * Classification of a transaction failure, used by callers (e.g. the web
 * layer) to decide on a safe recovery action.
 *
 * - `simulation`: the transaction failed during simulation (e.g. invalid
 *   arguments, insufficient balance detected pre-flight). Safe to fix the
 *   form and retry; nothing was submitted on-chain.
 * - `contract`: the transaction was included on-chain but the contract
 *   invocation failed (e.g. `require_auth` failure, custom contract error).
 *   Retrying the same payload will fail again; the caller should surface the
 *   contract error and let the user adjust inputs.
 * - `rpc`: the RPC node could not be reached, returned an unexpected error,
 *   or the transaction could not be confirmed in time. The transaction may or
 *   may not have landed; the caller should offer a reconnect / network switch
 *   and re-check the transaction hash before retrying.
 * - `wallet`: signing or submission through the wallet failed (user rejected,
 *   wallet disconnected, wrong network). The caller should prompt the user to
 *   reconnect or switch networks and retry.
 * - `unknown`: unclassified failure.
 */
export type TransactionErrorKind =
  | "simulation"
  | "contract"
  | "rpc"
  | "wallet"
  | "unknown";

/**
 * Error thrown by transaction helpers, carrying a classification so callers
 * can map it to a safe recovery action.
 */
export class TransactionError extends FundableStellarError {
  /** Classification of the failure */
  readonly kind: TransactionErrorKind;
  /** Transaction hash, when known */
  readonly hash?: string;
  /** Whether retrying the same operation may succeed without user changes */
  readonly retryable: boolean;

  constructor(
    kind: TransactionErrorKind,
    message: string,
    options: { hash?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "TransactionError";
    this.kind = kind;
    this.hash = options.hash;
    this.retryable = options.retryable ?? kind === "rpc" || kind === "wallet";
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Classifies an arbitrary error thrown during a transaction flow.
 *
 * Exposed so the web layer can map errors from `signAndSend` (which is called
 * directly in some flows) to the same safe actions as `waitForTransaction`.
 */
export function classifyTransactionError(
  error: unknown,
  context: { hash?: string } = {},
): TransactionError {
  if (error instanceof TransactionError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Wallet-level failures: user rejection, disconnection, wrong network.
  if (
    lower.includes("user rejected") ||
    lower.includes("user declined") ||
    lower.includes("rejected by user") ||
    lower.includes("denied by user") ||
    lower.includes("wallet not connected") ||
    lower.includes("wallet is not connected") ||
    lower.includes("disconnected") ||
    lower.includes("wrong network") ||
    lower.includes("network mismatch")
  ) {
    return new TransactionError("wallet", message, {
      hash: context.hash,
      retryable: true,
      cause: error,
    });
  }

  // Simulation failures (pre-flight). Nothing was submitted.
  if (
    lower.includes("simulation") ||
    lower.includes("simulate") ||
    lower.includes("hostfunction") ||
    lower.includes("transaction simulation failed")
  ) {
    return new TransactionError("simulation", message, {
      hash: context.hash,
      retryable: false,
      cause: error,
    });
  }

  // Contract failures (on-chain invocation error).
  if (
    lower.includes("transaction failed on ledger") ||
    lower.includes("contract error") ||
    lower.includes("require_auth") ||
    lower.includes("unreachablecode")
  ) {
    return new TransactionError("contract", message, {
      hash: context.hash,
      retryable: false,
      cause: error,
    });
  }

  // RPC / network / timeout failures.
  if (
    lower.includes("timeout") ||
    lower.includes("not found") ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("rpc") ||
    lower.includes("polling")
  ) {
    return new TransactionError("rpc", message, {
      hash: context.hash,
      retryable: true,
      cause: error,
    });
  }

  return new TransactionError("unknown", message, {
    hash: context.hash,
    retryable: false,
    cause: error,
  });
}

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
    throw new TransactionError(
      "wallet",
      "Transaction has not been signed and sent. " +
        "Call signAndSend() first before waiting for confirmation.",
      { retryable: true },
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

        throw new TransactionError("contract", error.message, {
          hash: txHash,
          retryable: false,
          cause: error,
        });
      }

      // Status is PENDING, continue polling
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (rpcError) {
      // Re-throw classified errors (e.g. contract failures) unchanged.
      if (rpcError instanceof TransactionError) {
        throw rpcError;
      }

      const message =
        rpcError instanceof Error ? rpcError.message : String(rpcError);

      // If it's a "not found" error, transaction may not be submitted yet
      if (message.includes("not found")) {
        // Continue polling
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }

      // For other RPC errors, re-throw with classification so callers can
      // offer reconnect / network switch actions.
      const parsedError = parseContractError(
        `Error polling transaction status: ${message}`,
        "Transaction polling",
      );
      throw new TransactionError("rpc", parsedError.message, {
        hash: txHash,
        retryable: true,
        cause: rpcError,
      });
    }
  }

  const timeoutError = parseContractError(
    `Transaction confirmation timeout after ${timeout}ms. Hash: ${txHash}`,
    "Transaction confirmation",
  );
  throw new TransactionError("rpc", timeoutError.message, {
    hash: txHash,
    retryable: true,
    cause: timeoutError,
  });
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
  try {
    await tx.signAndSend({
      signTransaction: async (xdr: string) => ({
        signedTxXdr: await signTransaction(xdr),
      }),
    });
  } catch (error) {
    // Classify signing / submission failures (wallet, simulation, RPC) so the
    // caller can map them to a safe recovery action.
    throw classifyTransactionError(error);
  }

  // Wait for confirmation
  return waitForTransaction(tx, rpcUrl, options);
}
