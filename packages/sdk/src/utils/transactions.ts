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
 * User-facing lifecycle phases of a transaction, from wallet approval through
 * on-chain settlement. These are distinct from the lower-level
 * {@link TransactionWaitStatus} polling statuses: a single phase may span
 * several polling statuses (e.g. `SUBMITTED` covers `PENDING` and
 * `NOT_FOUND`).
 *
 * - `AWAITING_APPROVAL` — assembled and handed to the wallet; not yet signed.
 * - `SUBMITTED` — signed and broadcast to the network; not yet confirmed.
 * - `LEDGER_CONFIRMED` — included in a ledger, but the contract result has not
 *   yet been reconciled (e.g. settlement effects still being verified).
 * - `SETTLED` — confirmed on-chain and the contract result is available.
 * - `FAILED` — rejected by the wallet, failed on-chain, or expired.
 * - `TIMED_OUT` — confirmation was not observed within the timeout window.
 *   The transaction may still settle later; reconcile with
 *   {@link rehydrateTransaction}.
 */
export type TransactionLifecyclePhase =
  | "AWAITING_APPROVAL"
  | "SUBMITTED"
  | "LEDGER_CONFIRMED"
  | "SETTLED"
  | "FAILED"
  | "TIMED_OUT";

/**
 * Enum representation of TransactionLifecyclePhase
 */
export const TransactionLifecyclePhaseEnum = {
  AWAITING_APPROVAL: "AWAITING_APPROVAL" as const,
  SUBMITTED: "SUBMITTED" as const,
  LEDGER_CONFIRMED: "LEDGER_CONFIRMED" as const,
  SETTLED: "SETTLED" as const,
  FAILED: "FAILED" as const,
  TIMED_OUT: "TIMED_OUT" as const,
};

/**
 * A single recorded lifecycle transition, suitable for persisting (e.g. to
 * localStorage) and rendering as a confirmation timeline.
 */
export interface TransactionLifecycleTransition {
  /** Lifecycle phase entered by this transition. */
  phase: TransactionLifecyclePhase;
  /** Wall-clock timestamp (ms since epoch) when the transition was observed. */
  timestamp: number;
  /** Transaction hash, when known. */
  hash?: string;
  /** Ledger sequence, when the transaction has been included in one. */
  ledger?: number;
  /** Human-readable detail (e.g. failure reason). */
  detail?: string;
}

/**
 * Serializable snapshot of a transaction's lifecycle, safe to persist and
 * restore across page reloads.
 */
export interface TransactionLifecycleSnapshot {
  /** Transaction hash, when known. */
  hash?: string;
  /** Current lifecycle phase. */
  phase: TransactionLifecyclePhase;
  /** Ordered list of transitions observed so far. */
  transitions: TransactionLifecycleTransition[];
  /** Ledger sequence, when confirmed. */
  ledger?: number;
  /** Error message when the phase is `FAILED` or `TIMED_OUT`. */
  error?: string;
}

/**
 * Options for {@link trackTransactionLifecycle}.
 */
export interface TrackTransactionLifecycleOptions<T = unknown>
  extends WaitForTransactionOptions {
  /**
   * Callback invoked on every lifecycle transition. Use this to persist the
   * snapshot so the timeline can be restored after a reload.
   */
  onTransition?: (
    transition: TransactionLifecycleTransition,
    snapshot: TransactionLifecycleSnapshot,
  ) => void;
  /**
   * Optional pre-existing snapshot (e.g. restored from storage). Its
   * transitions are preserved and the current phase is used as the starting
   * point.
   */
  initialSnapshot?: TransactionLifecycleSnapshot;
  /**
   * Optional callback invoked once the transaction is included in a ledger,
   * before settlement is reconciled. Return `false` to keep the phase at
   * `LEDGER_CONFIRMED` (e.g. while awaiting an external settlement check).
   */
  isSettled?: (result: T | undefined) => boolean | Promise<boolean>;
}
=======

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
 * Builds a lifecycle snapshot from a list of transitions.
 */
function buildSnapshot(
  transitions: TransactionLifecycleTransition[],
): TransactionLifecycleSnapshot {
  const last = transitions[transitions.length - 1];
  const snapshot: TransactionLifecycleSnapshot = {
    phase: last ? last.phase : "AWAITING_APPROVAL",
    transitions: [...transitions],
  };
  if (last?.hash) snapshot.hash = last.hash;
  if (last?.ledger !== undefined) snapshot.ledger = last.ledger;
  if (last?.detail && (last.phase === "FAILED" || last.phase === "TIMED_OUT")) {
    snapshot.error = last.detail;
  }
  return snapshot;
}

/**
 * Records a lifecycle transition, invoking the caller's `onTransition`
 * callback with the updated snapshot. Callback errors are surfaced as
 * {@link FundableStellarError}s so persistence failures are not silently
 * swallowed.
 */
function recordTransition<T>(
  transitions: TransactionLifecycleTransition[],
  transition: TransactionLifecycleTransition,
  onTransition?: TrackTransactionLifecycleOptions<T>["onTransition"],
): TransactionLifecycleSnapshot {
  transitions.push(transition);
  const snapshot = buildSnapshot(transitions);
  if (onTransition) {
    try {
      onTransition(transition, snapshot);
    } catch (cbErr) {
      const parsedError = parseContractError(
        `Error in onTransition callback: ${
          cbErr instanceof Error ? cbErr.message : String(cbErr)
        }`,
        "Transaction lifecycle callback",
      );
      throw new FundableStellarError(parsedError);
    }
  }
  return snapshot;
}

/**
 * Signs, sends, and tracks a transaction through its full lifecycle:
 * wallet approval, submission, ledger confirmation, and settlement.
 *
 * Every transition is reported through `onTransition` with a serializable
 * {@link TransactionLifecycleSnapshot}, so callers can persist the timeline
 * and restore it after a reload via {@link rehydrateTransaction}.
 *
 * Failure and timeout states are explicit: wallet rejection and on-chain
 * failure surface as `FAILED`, and an unconfirmed transaction surfaces as
 * `TIMED_OUT` (the transaction may still settle later).
 *
 * @typeParam T - The result type of the contract invocation
 * @param tx - The AssembledTransaction to sign and send
 * @param rpcUrl - The Soroban RPC URL
 * @param signTransaction - Callback function to sign the transaction
 * @param options - Lifecycle tracking options
 * @returns Promise resolving to the final lifecycle snapshot
 * @throws {FundableStellarError | Error} If signing, sending, or confirmation fails
 */
export async function trackTransactionLifecycle<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  signTransaction: (xdr: string) => Promise<string>,
  options: TrackTransactionLifecycleOptions<T> = {},
): Promise<TransactionLifecycleSnapshot> {
  const { onTransition, initialSnapshot, isSettled, ...waitOptions } = options;
  const transitions: TransactionLifecycleTransition[] = initialSnapshot
    ? [...initialSnapshot.transitions]
    : [];

  const emit = (transition: TransactionLifecycleTransition) =>
    recordTransition(transitions, transition, onTransition);

  // 1. Wallet approval.
  emit({ phase: "AWAITING_APPROVAL", timestamp: Date.now() });

  try {
    await tx.signAndSend({
      signTransaction: async (xdr: string) => ({
        signedTxXdr: await signTransaction(xdr),
      }),
    });
  } catch (error) {
    const classified = classifyTransactionError(error);
    emit({
      phase: "FAILED",
      timestamp: Date.now(),
      detail: classified.message,
    });
    throw classified;
  }

  // 2. Submitted to the network.
  const hash = tx?.signed?.hash ? tx.signed.hash().toString("hex") : undefined;
  emit({ phase: "SUBMITTED", timestamp: Date.now(), hash });

  // 3. Ledger confirmation and 4. settlement.
  let waitResult: TransactionWaitResult<T>;
  try {
    waitResult = await waitForTransaction(tx, rpcUrl, {
      ...waitOptions,
      throwOnFailure: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ phase: "FAILED", timestamp: Date.now(), hash, detail: message });
    throw error;
  }

  if (waitResult.status === "SUCCESS") {
    emit({
      phase: "LEDGER_CONFIRMED",
      timestamp: Date.now(),
      hash: waitResult.hash,
      ledger: waitResult.ledger,
    });

    let settled = true;
    if (isSettled) {
      try {
        settled = await isSettled(waitResult.result);
      } catch (settleErr) {
        const message =
          settleErr instanceof Error ? settleErr.message : String(settleErr);
        emit({
          phase: "FAILED",
          timestamp: Date.now(),
          hash: waitResult.hash,
          ledger: waitResult.ledger,
          detail: `Settlement check failed: ${message}`,
        });
        throw settleErr;
      }
    }

    if (settled) {
      return emit({
        phase: "SETTLED",
        timestamp: Date.now(),
        hash: waitResult.hash,
        ledger: waitResult.ledger,
      });
    }

    return buildSnapshot(transitions);
  }

  if (waitResult.status === "TIMEOUT") {
    return emit({
      phase: "TIMED_OUT",
      timestamp: Date.now(),
      hash: waitResult.hash,
      detail: waitResult.error,
    });
  }

  // FAILED, EXPIRED, ABORTED, or any other terminal non-success status.
  return emit({
    phase: "FAILED",
    timestamp: Date.now(),
    hash: waitResult.hash,
    ledger: waitResult.ledger,
    detail: waitResult.error ?? `Transaction ${waitResult.status}`,
  });
}

/**
 * Options for {@link rehydrateTransaction}.
 */
export interface RehydrateTransactionOptions<T = unknown> {
  /**
   * Callback invoked with the reconciled snapshot. Use this to update
   * persisted state after a reload.
   */
  onTransition?: TrackTransactionLifecycleOptions<T>["onTransition"];
  /**
   * Optional settlement check, as in {@link trackTransactionLifecycle}.
   */
  isSettled?: (result: T | undefined) => boolean | Promise<boolean>;
}

/**
 * Reconciles a persisted lifecycle snapshot against the network after a
 * reload.
 *
 * Given a transaction hash (from the snapshot or supplied explicitly), this
 * queries Soroban RPC and advances the snapshot to the authoritative phase:
 * `SETTLED` if the transaction succeeded, `FAILED` if it failed or expired,
 * and otherwise leaves it in its current in-flight phase (`SUBMITTED` or
 * `LEDGER_CONFIRMED`). This makes recovery after a reload explicit rather
 * than relying on stale local state.
 *
 * @typeParam T - The result type of the contract invocation
 * @param snapshot - The persisted snapshot to reconcile
 * @param rpcUrl - The Soroban RPC URL
 * @param options - Reconciliation options
 * @returns Promise resolving to the reconciled snapshot
 */
export async function rehydrateTransaction<T = unknown>(
  snapshot: TransactionLifecycleSnapshot,
  rpcUrl: string,
  options: RehydrateTransactionOptions<T> = {},
): Promise<TransactionLifecycleSnapshot> {
  const { onTransition, isSettled } = options;
  const transitions: TransactionLifecycleTransition[] = [
    ...snapshot.transitions,
  ];
  const emit = (transition: TransactionLifecycleTransition) =>
    recordTransition(transitions, transition, onTransition);

  const hash = snapshot.hash;
  if (!hash) {
    // Nothing to reconcile against the network yet.
    return buildSnapshot(transitions);
  }

  const server = new rpc.Server(rpcUrl);
  let response: rpc.Api.GetTransactionResponse;
  try {
    response = await server.getTransaction(hash);
  } catch (error) {
    // Transient RPC failure: keep the current phase so the caller can retry.
    return buildSnapshot(transitions);
  }

  const respStatus = response?.status as string | undefined;

  if (respStatus === rpc.Api.GetTransactionStatus.SUCCESS) {
    const ledger = response.ledger;
    const alreadyConfirmed = transitions.some(
      (t) => t.phase === "LEDGER_CONFIRMED" || t.phase === "SETTLED",
    );
    if (!alreadyConfirmed) {
      emit({ phase: "LEDGER_CONFIRMED", timestamp: Date.now(), hash, ledger });
    }

    let settled = true;
    if (isSettled) {
      try {
        settled = await isSettled(undefined);
      } catch (settleErr) {
        const message =
          settleErr instanceof Error ? settleErr.message : String(settleErr);
        return emit({
          phase: "FAILED",
          timestamp: Date.now(),
          hash,
          ledger,
          detail: `Settlement check failed: ${message}`,
        });
      }
    }

    if (!settled) {
      return buildSnapshot(transitions);
    }

    return emit({ phase: "SETTLED", timestamp: Date.now(), hash, ledger });
  }

  if (respStatus === rpc.Api.GetTransactionStatus.FAILED) {
    const parsedError = parseContractError(
      {
        resultXdr: response.resultXdr,
        message: `Transaction failed on ledger ${response.ledger}`,
      },
      "Transaction confirmation",
    );
    return emit({
      phase: "FAILED",
      timestamp: Date.now(),
      hash,
      ledger: response.ledger,
      detail: parsedError.message,
    });
  }

  if (respStatus === "EXPIRED") {
    return emit({
      phase: "FAILED",
      timestamp: Date.now(),
      hash,
      detail: `Transaction expired: ${hash}`,
    });
  }

  // NOT_FOUND / PENDING: still in flight. If we previously timed out, keep the
  // explicit TIMED_OUT phase so the UI can show that recovery is pending.
  if (snapshot.phase === "TIMED_OUT") {
    return buildSnapshot(transitions);
  }

  const inFlight = transitions.some((t) => t.phase === "SUBMITTED");
  if (!inFlight) {
    return emit({ phase: "SUBMITTED", timestamp: Date.now(), hash });
  }

  return buildSnapshot(transitions);
}

/**
 * Convenience method combining signAndSend with waitForTransaction.
=======
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

/**
 * Classifies a signing / submission error into a typed
 * {@link FundableStellarError} so callers can map it to a recovery action.
 */
function classifyTransactionError(error: unknown): Error {
  if (error instanceof FundableStellarError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("reject") || lower.includes("denied") || lower.includes("cancel")) {
    return new TransactionError("wallet", message, {
      retryable: true,
      cause: error,
    });
  }
  if (lower.includes("simulation")) {
    return new TransactionError("simulation", message, {
      retryable: false,
      cause: error,
    });
  }
  if (lower.includes("timeout") || lower.includes("network")) {
    return new TransactionError("rpc", message, {
      retryable: true,
      cause: error,
    });
  }
  return new TransactionError("rpc", message, {
    retryable: true,
    cause: error,
  });
}

/**
 * Error type carrying a classified transaction failure category.
 */
export class TransactionError extends FundableStellarError {
  /** Failure category: wallet, simulation, or rpc. */
  readonly category: "wallet" | "simulation" | "rpc";
  /** Transaction hash, when known. */
  readonly hash?: string;
  /** Whether the operation may be safely retried. */
  readonly retryable: boolean;

  constructor(
    category: "wallet" | "simulation" | "rpc",
    message: string,
    options: { hash?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TransactionError";
    this.category = category;
    this.hash = options.hash;
    this.retryable = options.retryable ?? false;
  }
}

