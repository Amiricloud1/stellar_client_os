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
 * Terminal and lifecycle statuses for transaction waiting
 */
export type TransactionWaitStatus =
  | "SUCCESS"
  | "FAILED"
  | "PENDING"
  | "NOT_FOUND"
  | "EXPIRED"
  | "TIMEOUT"
  | "ABORTED";

/**
 * Enum representation of TransactionWaitStatus
 */
export const TransactionWaitStatusEnum = {
  SUCCESS: "SUCCESS" as const,
  FAILED: "FAILED" as const,
  PENDING: "PENDING" as const,
  NOT_FOUND: "NOT_FOUND" as const,
  EXPIRED: "EXPIRED" as const,
  TIMEOUT: "TIMEOUT" as const,
  ABORTED: "ABORTED" as const,
};

/**
 * A single contract effect (event or state change) observed while simulating
 * a transaction. Effects are derived from the simulation's diagnostic events
 * and are intended for display in a pre-signing review UI.
 */
export interface TransactionSimulationEffect {
  /** Contract ID that emitted the effect, if known. */
  contractId?: string;
  /** Effect topic(s), e.g. `["transfer"]`. */
  topics: string[];
  /** Human-readable summary of the effect. */
  description: string;
  /** Raw effect data (base64-encoded XDR or decoded value) when available. */
  data?: unknown;
}

/**
 * Structured summary of a simulated transaction, suitable for a review screen
 * shown before the user signs.
 */
export interface TransactionSimulationSummary {
  /** Whether the simulation succeeded. */
  success: boolean;
  /** Amount transferred or otherwise affected, as a decimal string (if any). */
  amount?: string;
  /** Asset identifier for the amount, e.g. `native` or `CODE:ISSUER`. */
  asset?: string;
  /** Destination account or contract address (if any). */
  destination?: string;
  /** Estimated total fee in stroops, as a decimal string. */
  fee?: string;
  /** Contract effects produced by the simulation. */
  effects: TransactionSimulationEffect[];
  /** Chain identity captured at simulation time (e.g. network passphrase). */
  chainId?: string;
  /** Ledger sequence the simulation was evaluated against. */
  ledger?: number;
  /** Latest ledger known to the RPC at simulation time. */
  latestLedger?: number;
  /** Error message when the simulation failed. */
  error?: string;
}

/**
 * Options for {@link simulateTransaction}.
 */
export interface SimulateTransactionOptions {
  /** Expected chain identity; if provided, mismatches are reported as errors. */
  expectedChainId?: string;
  /** Expected ledger; if provided, a stale simulation is reported as an error. */
  expectedLedger?: number;
  /** Maximum allowed ledger drift before the simulation is considered stale. */
  maxLedgerDrift?: number;
}

/**
 * Simulates an AssembledTransaction and returns a structured summary of the
 * amount, destination, fees, and contract effects, along with the chain
 * identity and ledger the simulation was evaluated against.
 *
 * This does not sign or submit anything and is safe to call with no funds.
 *
 * @typeParam T - The result type of the contract invocation
 * @param tx - The AssembledTransaction to simulate
 * @param rpcUrl - The Soroban RPC URL used to simulate
 * @param options - Simulation options
 * @returns Promise resolving to a {@link TransactionSimulationSummary}
 */
export async function simulateTransaction<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  options: SimulateTransactionOptions = {},
): Promise<TransactionSimulationSummary> {
  const { expectedChainId, expectedLedger, maxLedgerDrift = 0 } = options;
  const server = new rpc.Server(rpcUrl);

  const summary: TransactionSimulationSummary = {
    success: false,
    effects: [],
  };

  try {
    const simulation = await server.simulateTransaction(tx.built);

    summary.latestLedger = simulation.latestLedger;
    summary.ledger = simulation.latestLedger;

    // Capture chain identity from the network passphrase when available.
    const network = await server.getNetwork();
    summary.chainId = network.passphrase;

    if (expectedChainId && summary.chainId !== expectedChainId) {
      summary.error =
        `Chain identity mismatch: expected ${expectedChainId}, ` +
        `got ${summary.chainId}`;
      return summary;
    }

    if (
      expectedLedger !== undefined &&
      summary.ledger !== undefined &&
      Math.abs(summary.ledger - expectedLedger) > maxLedgerDrift
    ) {
      summary.error =
        `Stale simulation: evaluated at ledger ${summary.ledger}, ` +
        `expected ${expectedLedger} (±${maxLedgerDrift})`;
      return summary;
    }

    if (rpc.Api.isSimulationError(simulation)) {
      summary.error = simulation.error;
      return summary;
    }

    summary.success = true;

    // Estimate fee from the simulation's min resource fee plus inclusion fee.
    const minResourceFee = simulation.minResourceFee;
    if (minResourceFee !== undefined && minResourceFee !== null) {
      summary.fee = String(minResourceFee);
    }

    // Derive contract effects from diagnostic events.
    const events = simulation.events ?? [];
    for (const event of events) {
      const topics = (event.topic ?? []).map((t) => String(t));
      const effect: TransactionSimulationEffect = {
        topics,
        description: topics.length > 0 ? topics.join(":") : "event",
      };
      if (event.contractId) {
        effect.contractId = String(event.contractId);
      }
      if (event.data !== undefined) {
        effect.data = event.data;
      }
      summary.effects.push(effect);
    }

    return summary;
  } catch (simulationError) {
    const parsedError = parseContractError(
      `Error simulating transaction: ${
        simulationError instanceof Error
          ? simulationError.message
          : String(simulationError)
      }`,
      "Transaction simulation",
    );
    summary.error = parsedError.message;
    return summary;
  }
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
   * Optional AbortSignal to cancel waiting.
   */
  signal?: AbortSignal;

  /**
   * Whether to throw an error on non-success outcomes (FAILED, TIMEOUT, EXPIRED, ABORTED).
   * When false, resolves with a typed TransactionWaitResult containing the status and error details.
   * Default: true
   */
  throwOnFailure?: boolean;

  /**
   * Callback function invoked on each poll attempt.
   * @param attempt - Current attempt number (1-indexed)
   * @param elapsedMs - Elapsed time in milliseconds
   */
  onPoll?: (attempt: number, elapsedMs: number) => void;

  /**
   * Optional callback function invoked when transaction status transitions.
   * @param status - Transaction wait status
   */
  onStatusChange?: (status: TransactionWaitStatus) => void;
}

/**
 * Result of a transaction wait operation
 */
export interface TransactionWaitResult<T = unknown> {
  /** Transaction hash */
  hash: string;
  /** Ledger sequence number where transaction was included (if confirmed) */
  ledger?: number;
  /** Contract invocation result (if applicable) */
  result?: T;
  /** Status of the transaction wait operation */
  status: TransactionWaitStatus;
  /** Error message or details if non-successful */
  error?: string;
  /** Raw resultXdr or response details if available */
  resultXdr?: string;
}

/**
 * Helper to sleep with AbortSignal cancellation support
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error(signal.reason ? String(signal.reason) : "Transaction wait aborted");
      err.name = "AbortError";
      return reject(err);
    }

    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      const err = new Error(signal?.reason ? String(signal.reason) : "Transaction wait aborted");
      err.name = "AbortError";
      reject(err);
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Waits for an AssembledTransaction to be confirmed on-chain.
 *
 * This is a convenience method that simplifies the developer experience by
 * automatically polling for transaction confirmation after signing and sending.
 * Supports status tracking, AbortSignal cancellation, and typed results.
 *
 * @typeParam T - The result type of the contract invocation
 * @param tx - The AssembledTransaction to wait for
 * @param rpcUrl - The Soroban RPC URL to use for polling
 * @param options - Configuration options
 * @returns Promise resolving to transaction confirmation details
 * @throws {FundableStellarError | Error} If timeout is exceeded, aborted, or transaction fails (when throwOnFailure is true)
 */
export async function waitForTransaction<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  options: WaitForTransactionOptions = {},
): Promise<TransactionWaitResult<T>> {
  const {
    timeout = 60000,
    pollInterval = 1000,
    signal,
    throwOnFailure = true,
    onPoll,
    onStatusChange,
  } = options;

  // Ensure the transaction has been sent
  const txHash = tx?.signed?.hash ? tx.signed.hash().toString("hex") : undefined;
  if (!txHash) {
    throw new TransactionError(
      "wallet",
      "Transaction has not been signed and sent. " +
        "Call signAndSend() first before waiting for confirmation.",
      { retryable: true },
    );
  }

  // Check cancellation before initiating polling
  if (signal?.aborted) {
    const errorMsg = signal.reason ? String(signal.reason) : "Transaction wait aborted";
    if (!throwOnFailure) {
      return {
        hash: txHash,
        status: "ABORTED",
        error: errorMsg,
      };
    }
    const abortErr = new Error(errorMsg);
    abortErr.name = "AbortError";
    throw abortErr;
  }

  const safePollInterval = Math.max(10, pollInterval);
  const server = new rpc.Server(rpcUrl);
  const startTime = Date.now();
  let attempt = 0;
  let lastReportedStatus: TransactionWaitStatus | null = null;

  const notifyStatus = (status: TransactionWaitStatus) => {
    if (status !== lastReportedStatus) {
      lastReportedStatus = status;
      if (onStatusChange) {
        try {
          onStatusChange(status);
        } catch (cbErr) {
          const parsedError = parseContractError(
            `Error in onStatusChange callback: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
            "Transaction status callback",
          );
          throw new FundableStellarError(parsedError);
        }
      }
    }
  };

  while (Date.now() - startTime <= timeout) {
    attempt++;
    const elapsedMs = Date.now() - startTime;

    if (signal?.aborted) {
      notifyStatus("ABORTED");
      const errorMsg = signal.reason ? String(signal.reason) : "Transaction wait aborted";
      if (!throwOnFailure) {
        return {
          hash: txHash,
          status: "ABORTED",
          error: errorMsg,
        };
      }
      const abortErr = new Error(errorMsg);
      abortErr.name = "AbortError";
      throw abortErr;
    }

    try {
      // Invoke onPoll callback if provided
      if (onPoll) {
        try {
          onPoll(attempt, elapsedMs);
        } catch (cbErr) {
          const parsedError = parseContractError(
            `Error in onPoll callback: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
            "Transaction polling callback",
          );
          throw new FundableStellarError(parsedError);
        }
      }

      // Poll for transaction status
      const response = await server.getTransaction(txHash);
      const respStatus = response?.status as string | undefined;

      if (respStatus === rpc.Api.GetTransactionStatus.SUCCESS) {
        notifyStatus("SUCCESS");
        return {
          hash: txHash,
          ledger: response.ledger,
          result: tx.result,
          status: "SUCCESS",
        };
      }

      if (respStatus === rpc.Api.GetTransactionStatus.FAILED) {
        notifyStatus("FAILED");
        const parsedError = parseContractError(
          {
            resultXdr: response.resultXdr,
            message: `Transaction failed on ledger ${response.ledger}`,
          },
          "Transaction confirmation",
        );

        if (!throwOnFailure) {
          return {
            hash: txHash,
            ledger: response.ledger,
            status: "FAILED",
            error: parsedError.message,
            resultXdr: response.resultXdr ? String(response.resultXdr) : undefined,
          };
        }

        throw new FundableStellarError(parsedError);
      }

      if (respStatus === "EXPIRED") {
        notifyStatus("EXPIRED");
        const errorMsg = `Transaction expired: ${txHash}`;
        if (!throwOnFailure) {
          return {
            hash: txHash,
            status: "EXPIRED",
            error: errorMsg,
          };
        }
        const parsedError = parseContractError(errorMsg, "Transaction confirmation");
        throw new FundableStellarError(parsedError);
      }

      if (respStatus === (rpc.Api.GetTransactionStatus as any).NOT_FOUND || respStatus === "NOT_FOUND") {
        notifyStatus("NOT_FOUND");
      } else {
        notifyStatus("PENDING");
      }

      // Status is PENDING or NOT_FOUND, sleep until next poll interval
      await sleep(safePollInterval, signal);
    } catch (rpcError) {
      if (rpcError instanceof Error && rpcError.name === "AbortError") {
        notifyStatus("ABORTED");
        if (!throwOnFailure) {
          return {
            hash: txHash,
            status: "ABORTED",
            error: rpcError.message,
          };
        }
        throw rpcError;
      }

      // Re-throw library errors directly
      if (rpcError instanceof FundableStellarError) {
        throw rpcError;
      }

      if (rpcError instanceof Error) {
        // If it's a re-thrown error, keep it
        if (
          rpcError.message.includes("Transaction confirmation timeout") ||
          rpcError.message.includes("Transaction failed on ledger") ||
          rpcError.message.includes("Transaction expired")
        ) {
          throw rpcError;
        }

        // If it's a "not found" error, transaction may not be indexed yet
        if (rpcError.message.toLowerCase().includes("not found")) {
          notifyStatus("NOT_FOUND");
          await sleep(safePollInterval, signal);
          continue;
        }
      }

      // For other RPC errors, re-throw with context
      const parsedError = parseContractError(
        `Error polling transaction status: ${rpcError instanceof Error ? rpcError.message : String(rpcError)}`,
        "Transaction polling",
      );
      throw new TransactionError("rpc", parsedError.message, {
        hash: txHash,
        retryable: true,
        cause: rpcError,
      });
    }
  }

  notifyStatus("TIMEOUT");
  const timeoutMsg = `Transaction confirmation timeout after ${timeout}ms. Hash: ${txHash}`;
  if (!throwOnFailure) {
    return {
      hash: txHash,
      status: "TIMEOUT",
      error: timeoutMsg,
    };
  }

  const timeoutError = parseContractError(timeoutMsg, "Transaction confirmation");
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

