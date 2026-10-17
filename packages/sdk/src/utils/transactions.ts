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
