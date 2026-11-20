/**
 * @module @fundable/sdk
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
 * The distinct phases of a transaction's lifecycle.
 *
 * - `idle` — nothing has happened yet.
 * - `awaiting_approval` — the transaction has been assembled and is waiting
 *   for the user to approve it in their wallet.
 * - `approved` — the wallet approved and signed the transaction, but it has
 *   not been submitted to the network yet.
 * - `submitted` — the signed transaction was sent to Soroban RPC and we are
 *   waiting for it to be included in a ledger.
 * - `confirmed` — the transaction was included in a ledger and succeeded.
 * - `settled` — the confirmed result has been fully applied (e.g. balances
 *   and stream state reconciled). This is the terminal success state.
 * - `failed` — the transaction failed, was rejected, or timed out.
 * - `cancelled` — the user abandoned the flow before submission.
 */
export type TransactionPhase =
  | "idle"
  | "awaiting_approval"
  | "approved"
  | "submitted"
  | "confirmed"
  | "settled"
  | "failed"
  | "cancelled";

/**
 * A single entry in a transaction's confirmation timeline.
 */
export interface TransactionTimelineEntry {
  /** The lifecycle phase this entry records. */
  phase: TransactionPhase;
  /** Unix epoch milliseconds when the phase was entered. */
  timestamp: number;
  /** Transaction hash, once known (available from `submitted` onward). */
  hash?: string;
  /** Ledger sequence number, once confirmed. */
  ledger?: number;
  /** Human-readable detail (e.g. error message for `failed`). */
  detail?: string;
}

/**
 * A persisted, reload-safe record of a transaction's lifecycle.
 *
 * The timeline is designed to be serialized (e.g. to `localStorage`) after
 * every phase transition so that a page reload can resume polling for
 * confirmation instead of losing track of an in-flight transaction.
 */
export interface TransactionTimeline {
  /** Stable identifier for this transaction flow (caller supplied). */
  id: string;
  /** Current lifecycle phase. */
  phase: TransactionPhase;
  /** Ordered history of phase transitions. */
  entries: TransactionTimelineEntry[];
  /** Transaction hash, once known. */
  hash?: string;
  /** Ledger sequence number, once confirmed. */
  ledger?: number;
  /** Whether the current phase is a terminal state. */
  terminal: boolean;
}

/**
 * Minimal persistence interface so the timeline can be stored anywhere
 * (localStorage, sessionStorage, a server, an in-memory map in tests).
 */
export interface TimelineStore {
  get(id: string): TransactionTimeline | undefined | Promise<TransactionTimeline | undefined>;
  set(timeline: TransactionTimeline): void | Promise<void>;
  delete?(id: string): void | Promise<void>;
}

const TERMINAL_PHASES: ReadonlySet<TransactionPhase> = new Set([
  "settled",
  "failed",
  "cancelled",
]);

/**
 * Returns `true` if the given phase is terminal (no further transitions).
 */
export function isTerminalPhase(phase: TransactionPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Creates a fresh timeline in the `idle` phase.
 */
export function createTimeline(id: string, now: number = Date.now()): TransactionTimeline {
  return {
    id,
    phase: "idle",
    entries: [{ phase: "idle", timestamp: now }],
    terminal: false,
  };
}

/**
 * Advances a timeline to a new phase, appending a timeline entry and
 * updating the terminal flag. Returns a new object; the input is not mutated.
 *
 * @throws {FundableStellarError} If the transition leaves a terminal phase.
 */
export function advanceTimeline(
  timeline: TransactionTimeline,
  phase: TransactionPhase,
  extra: { hash?: string; ledger?: number; detail?: string; now?: number } = {},
): TransactionTimeline {
  if (timeline.terminal) {
    throw new FundableStellarError(
      `Cannot transition transaction "${timeline.id}" from terminal phase "${timeline.phase}" to "${phase}"`,
      { type: "transaction_error" },
    );
  }

  const timestamp = extra.now ?? Date.now();
  const hash = extra.hash ?? timeline.hash;
  const ledger = extra.ledger ?? timeline.ledger;

  const entry: TransactionTimelineEntry = { phase, timestamp };
  if (hash !== undefined) entry.hash = hash;
  if (ledger !== undefined) entry.ledger = ledger;
  if (extra.detail !== undefined) entry.detail = extra.detail;

  return {
    id: timeline.id,
    phase,
    entries: [...timeline.entries, entry],
    hash,
    ledger,
    terminal: isTerminalPhase(phase),
  };
}

/**
 * An in-memory {@link TimelineStore} useful for tests and non-persistent flows.
 */
export class MemoryTimelineStore implements TimelineStore {
  private readonly map = new Map<string, TransactionTimeline>();

  get(id: string): TransactionTimeline | undefined {
    return this.map.get(id);
  }

  set(timeline: TransactionTimeline): void {
    this.map.set(timeline.id, timeline);
  }

  delete(id: string): void {
    this.map.delete(id);
  }
}

/**
 * Options for {@link executeTransactionWithTimeline}.
 */
export interface ExecuteWithTimelineOptions<T = unknown> extends WaitForTransactionOptions {
  /** Stable identifier for this transaction flow. */
  id: string;
  /** Where to persist the timeline after each phase transition. */
  store: TimelineStore;
  /** Optional callback invoked after each persisted transition (e.g. to update UI). */
  onPhase?: (timeline: TransactionTimeline) => void;
  /**
   * Optional hook invoked after ledger confirmation to reconcile off-chain
   * state (e.g. refetch balances). Its resolution moves the timeline to
   * `settled`; a rejection moves it to `failed`.
   */
  settle?: (result: TransactionWaitResult<T>) => Promise<void> | void;
}

/**
 * Executes a transaction while recording a persisted confirmation timeline.
 *
 * Unlike {@link executeTransaction}, this variant distinguishes wallet
 * approval, submission, ledger confirmation, and settlement, and persists
 * each transition so a reload can recover via {@link resumeTransactionTimeline}.
 *
 * @returns The final timeline (terminal phase `settled` or `failed`).
 */
export async function executeTransactionWithTimeline<T = unknown>(
  tx: AssembledTransaction<T>,
  rpcUrl: string,
  signTransaction: (xdr: string) => Promise<string>,
  options: ExecuteWithTimelineOptions<T>,
): Promise<TransactionTimeline> {
  const { id, store, onPhase, settle, ...waitOptions } = options;

  const persist = async (timeline: TransactionTimeline): Promise<TransactionTimeline> => {
    await store.set(timeline);
    onPhase?.(timeline);
    return timeline;
  };

  let timeline = await persist(advanceTimeline(createTimeline(id), "awaiting_approval"));

  let signedXdr: string;
  try {
    signedXdr = await signTransaction(tx.toXDR());
  } catch (error) {
    const parsed = parseContractError(
      error instanceof Error ? error : new Error(String(error)),
      "Wallet approval",
    );
    return persist(advanceTimeline(timeline, "failed", { detail: parsed.message }));
  }

  timeline = await persist(advanceTimeline(timeline, "approved"));

  let hash: string | undefined;
  try {
    hash = Buffer.from(tx.signed?.hash() ?? []).toString("hex") || undefined;
  } catch {
    hash = undefined;
  }

  timeline = await persist(advanceTimeline(timeline, "submitted", { hash }));

  let result: TransactionWaitResult<T>;
  try {
    result = await signAndWait(tx, rpcUrl, async () => signedXdr, waitOptions);
  } catch (error) {
    const parsed = parseContractError(
      error instanceof Error ? error : new Error(String(error)),
      "Transaction execution",
    );
    return persist(
      advanceTimeline(timeline, "failed", {
        hash: timeline.hash,
        detail: parsed.message,
      }),
    );
  }

  timeline = await persist(
    advanceTimeline(timeline, "confirmed", { hash: result.hash, ledger: result.ledger }),
  );

  if (settle) {
    try {
      await settle(result);
    } catch (error) {
      const parsed = parseContractError(
        error instanceof Error ? error : new Error(String(error)),
        "Settlement",
      );
      return persist(advanceTimeline(timeline, "failed", { detail: parsed.message }));
    }
  }

  return persist(advanceTimeline(timeline, "settled"));
}

/**
 * Recovers an in-flight transaction timeline after a reload.
 *
 * If the persisted timeline is already terminal it is returned unchanged.
 * If it was `submitted` (or later but not terminal), this resumes polling
 * Soroban RPC for the recorded hash and advances the timeline to
 * `confirmed`/`settled` or `failed`. If the timeline never reached
 * `submitted`, it is marked `cancelled` because the signed transaction was
 * never broadcast and cannot be recovered.
 *
 * @param id - The transaction flow identifier.
 * @param store - The store the timeline was persisted to.
 * @param rpcUrl - The Soroban RPC URL.
 * @param options - Wait/timeout options plus optional `settle` hook.
 * @returns The recovered timeline.
 */
export async function resumeTransactionTimeline<T = unknown>(
  id: string,
  store: TimelineStore,
  rpcUrl: string,
  options: WaitForTransactionOptions & {
    settle?: (result: TransactionWaitResult<T>) => Promise<void> | void;
    onPhase?: (timeline: TransactionTimeline) => void;
  } = {},
): Promise<TransactionTimeline> {
  const { settle, onPhase, ...waitOptions } = options;

  const persist = async (timeline: TransactionTimeline): Promise<TransactionTimeline> => {
    await store.set(timeline);
    onPhase?.(timeline);
    return timeline;
  };

  const existing = await store.get(id);
  if (!existing) {
    throw new FundableStellarError(`No persisted timeline found for transaction "${id}"`, {
      type: "transaction_error",
    });
  }

  if (existing.terminal) {
    return existing;
  }

  if (!existing.hash || (existing.phase !== "submitted" && existing.phase !== "confirmed")) {
    return persist(
      advanceTimeline(existing, "cancelled", {
        detail: "Transaction was never submitted; cannot recover after reload.",
      }),
    );
  }

  const server = new rpc.Server(rpcUrl);
  let result: TransactionWaitResult<T>;
  try {
    result = await waitForTransactionByHash<T>(server, existing.hash, waitOptions);
  } catch (error) {
    const parsed = parseContractError(
      error instanceof Error ? error : new Error(String(error)),
      "Transaction recovery",
    );
    return persist(advanceTimeline(existing, "failed", { detail: parsed.message }));
  }

  let timeline =
    existing.phase === "confirmed"
      ? existing
      : await persist(
          advanceTimeline(existing, "confirmed", {
            hash: result.hash,
            ledger: result.ledger,
          }),
        );

  if (settle) {
    try {
      await settle(result);
    } catch (error) {
      const parsed = parseContractError(
        error instanceof Error ? error : new Error(String(error)),
        "Settlement",
      );
      return persist(advanceTimeline(timeline, "failed", { detail: parsed.message }));
    }
  }

  return persist(advanceTimeline(timeline, "settled"));
}

/**
 * Polls Soroban RPC for a transaction by hash until it is confirmed or the
 * timeout elapses. Used by {@link resumeTransactionTimeline}.
 */
async function waitForTransactionByHash<T = unknown>(
  server: rpc.Server,
  hash: string,
  options: WaitForTransactionOptions = {},
): Promise<TransactionWaitResult<T>> {
  const timeout = options.timeout ?? 60_000;
  const interval = options.pollInterval ?? 1_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const response = await server.getTransaction(hash);

    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash,
        ledger: response.ledger,
        result: response.returnValue as unknown as T,
      };
    }

    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new FundableStellarError(`Transaction ${hash} failed on-chain`, {
        type: "transaction_error",
      });
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new FundableStellarError(`Timed out waiting for transaction ${hash}`, {
    type: "transaction_error",
  });
}

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
 * import { executeTransaction } from "@fundable/sdk";
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
      hash = tx.signed ? Buffer.from(tx.signed.hash()).toString("hex") : undefined;
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
 * import { waitForTransactionWithRetry } from "@fundable/sdk";
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
 * import { cancelStreamSafely } from "@fundable/sdk";
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
 * import { isRetryableError } from "@fundable/sdk";
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
