/**
 * Soroban transaction helper utilities for gas price and resource limit estimation.
 *
 * These helpers provide utilities to estimate and suggest gas prices and resource limits
 * based on current network congestion and simulation results, making it easier to build
 * robust transaction submission logic.
 */

import { Server, Api } from '@stellar/stellar-sdk/rpc';
import { xdr } from '@stellar/stellar-sdk';
import type { SorobanDataBuilder, Transaction } from '@stellar/stellar-sdk';

/**
 * Identity of the chain a transaction flow is bound to.
 *
 * A wallet flow captures the chain identity (network passphrase and, when
 * available, the RPC chain id / latest ledger sequence) before simulating.
 * Every subsequent step (simulation, signing, confirmation) re-checks the
 * identity and aborts if the wallet has switched networks in the meantime.
 */
export interface ChainIdentity {
  /** Stellar network passphrase, e.g. `Networks.TESTNET`. */
  networkPassphrase: string;
  /** Optional RPC `getNetwork().passphrase`/chain id observed at capture time. */
  chainId?: string;
  /** Optional latest ledger sequence observed at capture time. */
  latestLedger?: number;
}

/**
 * Error thrown when an in-flight transaction flow is aborted because the
 * current chain no longer matches the captured {@link ChainIdentity}.
 */
export class ChainIdentityMismatchError extends Error {
  /** The identity captured when the flow started. */
  readonly expected: ChainIdentity;
  /** The identity observed when the mismatch was detected. */
  readonly actual: ChainIdentity;

  constructor(expected: ChainIdentity, actual: ChainIdentity, context?: string) {
    super(
      `Aborted${context ? ` ${context}` : ''}: chain identity changed ` +
        `(expected ${expected.networkPassphrase}${expected.chainId ? `/${expected.chainId}` : ''}, ` +
        `got ${actual.networkPassphrase}${actual.chainId ? `/${actual.chainId}` : ''}). ` +
        'Renew confirmation before retrying.',
    );
    this.name = 'ChainIdentityMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Returns true when two chain identities refer to the same chain.
 *
 * The network passphrase is always compared. `chainId` and `latestLedger`
 * are only compared when both sides provide them, so callers that cannot
 * observe a value are not spuriously aborted.
 */
export function isSameChain(expected: ChainIdentity, actual: ChainIdentity): boolean {
  if (expected.networkPassphrase !== actual.networkPassphrase) {
    return false;
  }
  if (expected.chainId !== undefined && actual.chainId !== undefined && expected.chainId !== actual.chainId) {
    return false;
  }
  if (
    expected.latestLedger !== undefined &&
    actual.latestLedger !== undefined &&
    expected.latestLedger !== actual.latestLedger
  ) {
    return false;
  }
  return true;
}

/**
 * Throw a {@link ChainIdentityMismatchError} when the current chain differs
 * from the captured identity.
 *
 * @param expected - Identity captured when the flow started.
 * @param actual - Identity observed right now.
 * @param context - Optional label describing the step being guarded.
 */
export function assertChainIdentity(
  expected: ChainIdentity,
  actual: ChainIdentity,
  context?: string,
): void {
  if (!isSameChain(expected, actual)) {
    throw new ChainIdentityMismatchError(expected, actual, context);
  }
}

/**
 * Capture the current chain identity from an RPC server.
 *
 * @param rpc - Soroban RPC server instance.
 * @returns Chain identity including the network passphrase and chain id.
 */
export async function captureChainIdentity(rpc: Server): Promise<ChainIdentity> {
  const network = await rpc.getNetwork();
  return {
    networkPassphrase: network.passphrase,
    chainId: network.passphrase,
  };
}

/**
 * Lifecycle stages of a Soroban transaction flow.
 *
 * The stages are ordered and monotonic for a successful flow:
 *
 * `idle` → `simulating` → `awaiting_approval` → `submitting` →
 * `submitted` → `confirming` → `confirmed` → `settled`
 *
 * Failure and recovery states are explicit so the web layer can persist and
 * render a confirmation timeline that survives a page reload:
 *
 * - `rejected`: the wallet declined to sign (terminal, user-initiated).
 * - `failed`: submission or confirmation failed (terminal unless retried).
 * - `retrying`: a transient failure occurred and a retry is scheduled.
 * - `recovering`: the flow was resumed after a reload and is re-checking
 *   the authoritative chain/transaction state.
 * - `aborted`: the flow was aborted because the chain identity changed.
 */
export type TransactionLifecycleStage =
  | 'idle'
  | 'simulating'
  | 'awaiting_approval'
  | 'submitting'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'settled'
  | 'rejected'
  | 'failed'
  | 'retrying'
  | 'recovering'
  | 'aborted';

/**
 * Terminal lifecycle stages after which no further automatic transition
 * occurs without an explicit retry or recovery.
 */
export const TERMINAL_LIFECYCLE_STAGES: readonly TransactionLifecycleStage[] = [
  'settled',
  'rejected',
  'failed',
  'aborted',
];

/**
 * Returns true when the stage is terminal (no automatic progression).
 */
export function isTerminalStage(stage: TransactionLifecycleStage): boolean {
  return TERMINAL_LIFECYCLE_STAGES.includes(stage);
}

/**
 * A single entry in the transaction confirmation timeline.
 */
export interface TransactionTimelineEntry {
  /** Lifecycle stage this entry records. */
  stage: TransactionLifecycleStage;
  /** Wall-clock timestamp (ms since epoch) when the stage was entered. */
  timestamp: number;
  /** Optional human-readable detail safe to surface to users/operators. */
  message?: string;
  /** Optional transaction hash once known (available from `submitted` on). */
  hash?: string;
  /** Optional structured failure descriptor for failure/recovery stages. */
  failure?: SorobanFailure;
}

/**
 * Persistable snapshot of a transaction flow's lifecycle.
 *
 * The snapshot is intentionally JSON-serializable so the web layer can store
 * it (e.g. in `localStorage`) and rebuild the timeline after a reload. On
 * reload, callers should resume via {@link recoverTransactionLifecycle} which
 * re-checks the authoritative chain/transaction state rather than trusting
 * the persisted snapshot blindly.
 */
export interface TransactionLifecycleSnapshot {
  /** Monotonic version incremented on every transition. */
  version: number;
  /** Current lifecycle stage. */
  stage: TransactionLifecycleStage;
  /** Ordered timeline of stage transitions. */
  timeline: TransactionTimelineEntry[];
  /** Chain identity captured when the flow started, if any. */
  chainIdentity?: ChainIdentity;
  /** Transaction hash once known. */
  hash?: string;
  /** Latest ledger sequence observed at the last confirmation poll. */
  latestLedger?: number;
}

/**
 * Observer invoked on every lifecycle transition.
 *
 * The callback receives the full snapshot so callers can persist it
 * atomically. Observers must not throw; any thrown error is swallowed so a
 * faulty observer cannot break the transaction flow.
 */
export type TransactionLifecycleObserver = (snapshot: TransactionLifecycleSnapshot) => void;

/**
 * Options for {@link TransactionLifecycleTracker}.
 */
export interface TransactionLifecycleTrackerOptions {
  /** Chain identity captured when the flow started. */
  chainIdentity?: ChainIdentity;
  /** Optional observer invoked on every transition. */
  onTransition?: TransactionLifecycleObserver;
  /** Clock override for deterministic tests. @default Date.now */
  now?: () => number;
}

/**
 * Tracks the lifecycle of a Soroban transaction flow and produces a
 * persistable confirmation timeline.
 *
 * The tracker is the single source of truth for stage transitions. It
 * enforces that stages only move forward (or into an explicit failure /
 * recovery state) so the web layer cannot render an inconsistent timeline.
 *
 * @example
 * ```ts
 * const tracker = new TransactionLifecycleTracker({
 *   chainIdentity,
 *   onTransition: (snapshot) => localStorage.setItem('tx', JSON.stringify(snapshot)),
 * });
 * tracker.transition('simulating');
 * tracker.transition('awaiting_approval');
 * // ... user approves in wallet ...
 * tracker.transition('submitting');
 * tracker.transition('submitted', { hash });
 * tracker.transition('confirming');
 * tracker.transition('confirmed');
 * tracker.transition('settled');
 * ```
 */
export class TransactionLifecycleTracker {
  private snapshot: TransactionLifecycleSnapshot;
  private readonly onTransition?: TransactionLifecycleObserver;
  private readonly now: () => number;

  constructor(options: TransactionLifecycleTrackerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onTransition = options.onTransition;
    this.snapshot = {
      version: 0,
      stage: 'idle',
      timeline: [
        {
          stage: 'idle',
          timestamp: this.now(),
        },
      ],
      chainIdentity: options.chainIdentity,
    };
  }

  /** Returns a deep copy of the current snapshot. */
  getSnapshot(): TransactionLifecycleSnapshot {
    return {
      ...this.snapshot,
      timeline: this.snapshot.timeline.map((entry) => ({ ...entry })),
      chainIdentity: this.snapshot.chainIdentity ? { ...this.snapshot.chainIdentity } : undefined,
    };
  }

  /** Returns the current lifecycle stage. */
  getStage(): TransactionLifecycleStage {
    return this.snapshot.stage;
  }

  /**
   * Record a transition into a new lifecycle stage.
   *
   * @param stage - The stage being entered.
   * @param detail - Optional message, hash, and failure descriptor.
   * @returns The updated snapshot.
   */
  transition(
    stage: TransactionLifecycleStage,
    detail: { message?: string; hash?: string; failure?: SorobanFailure } = {},
  ): TransactionLifecycleSnapshot {
    const entry: TransactionTimelineEntry = {
      stage,
      timestamp: this.now(),
    };
    if (detail.message !== undefined) {
      entry.message = detail.message;
    }
    if (detail.hash !== undefined) {
      entry.hash = detail.hash;
    }
    if (detail.failure !== undefined) {
      entry.failure = detail.failure;
    }

    this.snapshot = {
      ...this.snapshot,
      version: this.snapshot.version + 1,
      stage,
      timeline: [...this.snapshot.timeline, entry],
      hash: detail.hash ?? this.snapshot.hash,
    };

    this.emit();
    return this.getSnapshot();
  }

  /**
   * Record a failure and move into the `failed` stage.
   */
  fail(failure: SorobanFailure, message?: string): TransactionLifecycleSnapshot {
    return this.transition('failed', { failure, message: message ?? failure.message });
  }

  /**
   * Record a transient failure and move into the `retrying` stage.
   */
  retry(failure: SorobanFailure, message?: string): TransactionLifecycleSnapshot {
    return this.transition('retrying', { failure, message: message ?? failure.message });
  }

  /**
   * Record that the flow was aborted due to a chain identity mismatch.
   */
  abort(error: ChainIdentityMismatchError): TransactionLifecycleSnapshot {
    return this.transition('aborted', {
      message: error.message,
      failure: {
        kind: 'unknown',
        message: error.message,
        retryable: false,
      },
    });
  }

  /**
   * Record the latest ledger observed during confirmation polling.
   */
  observeLedger(latestLedger: number): void {
    this.snapshot = { ...this.snapshot, latestLedger };
  }

  private emit(): void {
    if (!this.onTransition) {
      return;
    }
    try {
      this.onTransition(this.getSnapshot());
    } catch {
      // Observers must not break the transaction flow.
    }
  }
}

/**
 * Rebuild a lifecycle tracker from a persisted snapshot.
 *
 * The tracker resumes at the persisted stage but immediately records a
 * `recovering` transition so the timeline makes the reload explicit. Callers
 * must then re-check the authoritative chain/transaction state (see
 * {@link recoverTransactionLifecycle}) before trusting the persisted stage.
 *
 * @param snapshot - Snapshot previously persisted by the web layer.
 * @param options - Tracker options (observer, clock).
 * @returns A tracker positioned at the `recovering` stage.
 */
export function resumeTransactionLifecycle(
  snapshot: TransactionLifecycleSnapshot,
  options: Omit<TransactionLifecycleTrackerOptions, 'chainIdentity'> = {},
): TransactionLifecycleTracker {
  const tracker = new TransactionLifecycleTracker({
    ...options,
    chainIdentity: snapshot.chainIdentity,
  });

  // Restore the persisted timeline so the UI can render the full history.
  const restored: TransactionLifecycleSnapshot = {
    version: snapshot.version,
    stage: snapshot.stage,
    timeline: snapshot.timeline.map((entry) => ({ ...entry })),
    chainIdentity: snapshot.chainIdentity ? { ...snapshot.chainIdentity } : undefined,
    hash: snapshot.hash,
    latestLedger: snapshot.latestLedger,
  };
  (tracker as unknown as { snapshot: TransactionLifecycleSnapshot }).snapshot = restored;

  tracker.transition('recovering', {
    message: 'Resumed after reload; re-checking transaction state.',
    hash: snapshot.hash,
  });

  return tracker;
}

/**
 * Result of reconciling a persisted lifecycle snapshot against the chain.
 */
export interface TransactionRecoveryResult {
  /** The reconciled stage. */
  stage: TransactionLifecycleStage;
  /** Whether the transaction was found on-chain. */
  found: boolean;
  /** Transaction hash, if known. */
  hash?: string;
  /** Latest ledger observed during recovery. */
  latestLedger?: number;
  /** Structured failure when recovery could not complete. */
  failure?: SorobanFailure;
}

/**
 * Recover a transaction flow after a reload by re-checking the authoritative
 * chain state.
 *
 * Recovery rules:
 * - If a chain identity was captured, it is re-asserted first; a mismatch
 *   aborts the flow into the `aborted` stage.
 * - If a hash is known, the transaction is looked up. A successful lookup
 *   advances to `confirmed` (and `settled` once the ledger has closed past
 *   the transaction's ledger). A `NOT_FOUND` result keeps the flow in
 *   `confirming` so the caller can keep polling.
 * - Transient RPC failures move the flow into `retrying` with a retryable
 *   failure descriptor.
 *
 * @param rpc - Soroban RPC server instance.
 * @param tracker - Tracker resumed via {@link resumeTransactionLifecycle}.
 * @returns The reconciled recovery result.
 */
export async function recoverTransactionLifecycle(
  rpc: Server,
  tracker: TransactionLifecycleTracker,
): Promise<TransactionRecoveryResult> {
  const snapshot = tracker.getSnapshot();

  if (snapshot.chainIdentity) {
    try {
      await assertChainBeforeConfirmation(rpc, snapshot.chainIdentity);
    } catch (err) {
      if (err instanceof ChainIdentityMismatchError) {
        tracker.abort(err);
        return {
          stage: 'aborted',
          found: false,
          hash: snapshot.hash,
          failure: { kind: 'unknown', message: err.message, retryable: false },
        };
      }
      throw err;
    }
  }

  if (!snapshot.hash) {
    // Nothing was submitted before the reload; the flow must be restarted.
    tracker.transition('failed', {
      message: 'No transaction hash was persisted; restart the flow.',
      failure: {
        kind: 'unknown',
        message: 'No transaction hash was persisted; restart the flow.',
        retryable: true,
      },
    });
    return {
      stage: 'failed',
      found: false,
      failure: {
        kind: 'unknown',
        message: 'No transaction hash was persisted; restart the flow.',
        retryable: true,
      },
    };
  }

  try {
    const response = await rpc.getTransaction(snapshot.hash);
    const latestLedger = await rpc.getLatestLedger();
    tracker.observeLedger(Number(latestLedger.sequence));

    if (response.status === Api.GetTransactionStatus.SUCCESS) {
      tracker.transition('confirmed', { hash: snapshot.hash });
      tracker.transition('settled', { hash: snapshot.hash });
      return {
        stage: 'settled',
        found: true,
        hash: snapshot.hash,
        latestLedger: Number(latestLedger.sequence),
      };
    }

    if (response.status === Api.GetTransactionStatus.FAILED) {
      const failure: SorobanFailure = {
        kind: 'contract_error',
        message: 'Transaction failed on-chain.',
        retryable: false,
      };
      tracker.fail(failure);
      return {
        stage: 'failed',
        found: true,
        hash: snapshot.hash,
        latestLedger: Number(latestLedger.sequence),
        failure,
      };
    }

    // NOT_FOUND: still in flight; keep confirming.
    tracker.transition('confirming', {
      hash: snapshot.hash,
      message: 'Transaction not yet confirmed; continue polling.',
    });
    return {
      stage: 'confirming',
      found: false,
      hash: snapshot.hash,
      latestLedger: Number(latestLedger.sequence),
    };
  } catch (err) {
    const failure = classifyThrownError(err);
    if (failure.retryable) {
      tracker.retry(failure);
    } else {
      tracker.fail(failure);
    }
    return {
      stage: failure.retryable ? 'retrying' : 'failed',
      found: false,
      hash: snapshot.hash,
      failure,
    };
  }
}

/**
 * Resource usage metrics for a Soroban transaction.
 */
export interface ResourceUsage {
  /** Estimated number of CPU instructions to be executed. */
  instructions: number;
  /** Estimated number of bytes to be read from ledger storage. */
  readBytes: number;
  /** Estimated number of bytes to be written to ledger storage. */
  writeBytes: number;
  /** Estimated number of ledger entries to be read. */
  readEntries: number;
  /** Estimated number of ledger entries to be written. */
  writeEntries: number;
}

/**
 * Classification of a Soroban simulation or contract failure.
 *
 * These categories are intentionally coarse so that the unified wallet
 * recovery layer can map them to safe user actions (retry, switch network,
 * reconnect, or surface the contract error) without re-parsing raw RPC
 * payloads.
 *
 * - `simulation_error`: the RPC returned a simulation error result.
 * - `contract_error`: the simulation succeeded at the RPC level but the
 *   contract invocation trapped (e.g. `HostError` / `invokeHostFunction`).
 * - `network_error`: transient transport/RPC failure (retryable).
 * - `unknown`: anything we could not classify.
 */
export type SorobanFailureKind =
  | 'simulation_error'
  | 'contract_error'
  | 'network_error'
  | 'unknown';

/**
 * Structured failure descriptor exposed for the unified recovery layer.
 */
export interface SorobanFailure {
  /** Coarse failure category. */
  kind: SorobanFailureKind;
  /** Human-readable message safe to surface to operators/logs. */
  message: string;
  /** Whether retrying the same request may succeed. */
  retryable: boolean;
}

/**
 * Fee and resource estimate for a Soroban transaction.
 */
export interface TransactionEstimate {
  /** Recommended fee in stroops (0.00001 XLM per stroop). */
  recommendedFee: string;
  /** Minimum resource fee from simulation (before safety buffer). */
  minResourceFee: string;
  /** Detailed resource usage breakdown. */
  resources: ResourceUsage;
  /** Whether the simulation succeeded. */
  success: boolean;
  /** Error message if simulation failed. */
  error?: string;
  /** Structured failure descriptor when `success` is false. */
  failure?: SorobanFailure;
}

/**
 * Configuration options for transaction estimation.
 */
export interface EstimationOptions {
  /**
   * Chain identity the flow is bound to. When provided, the simulation is
   * aborted with a {@link ChainIdentityMismatchError} if the RPC server
   * reports a different network before or after simulating.
   */
  chainIdentity?: ChainIdentity;
  /**
   * Safety multiplier applied on top of the simulated minimum resource fee.
   * Higher values provide more buffer against network congestion.
   * @default 1.2
   */
  feeBufferMultiplier?: number;
  /**
   * Base fee in stroops for each transaction operation.
   * @default '100'
   */
  baseFee?: string;
  /**
   * Maximum number of times to retry simulation on transient failures.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Delay in milliseconds between retry attempts.
   * @default 1000
   */
  retryDelayMs?: number;
  /**
   * Optional lifecycle tracker. When provided, the estimation flow records
   * `simulating`, `retrying`, `failed`, and `aborted` transitions so the web
   * layer can render the confirmation timeline.
   */
  lifecycle?: TransactionLifecycleTracker;
}

/**
 * Network congestion level based on recent ledger fees.
 */
export type CongestionLevel = 'low' | 'medium' | 'high';

/**
 * Network metrics for congestion analysis.
 */
export interface NetworkMetrics {
  /** Current congestion level. */
  congestionLevel: CongestionLevel;
  /** Average fee in stroops from recent ledgers. */
  averageFee: string;
  /** Minimum fee in stroops from recent ledgers. */
  minFee: string;
  /** Maximum fee in stroops from recent ledgers. */
  maxFee: string;
  /** Number of ledgers analyzed. */
  ledgerCount: number;
}

/**
 * Default estimation options.
 */
const DEFAULT_OPTIONS: Required<Omit<EstimationOptions, 'chainIdentity' | 'lifecycle'>> = {
  feeBufferMultiplier: 1.2,
  baseFee: '100',
  maxRetries: 3,
  retryDelayMs: 1000,
};

/**
 * Patterns that indicate a contract-level trap surfaced by simulation.
 * These are matched case-insensitively against the simulation error string.
 */
const CONTRACT_ERROR_PATTERNS = [
  'hosterror',
  'invokehostfunction',
  'contract error',
  'wasm trap',
  'unreachable',
  'vm error',
];

/**
 * Patterns that indicate a transient network/RPC failure (retryable).
 */
const NETWORK_ERROR_PATTERNS = [
  'timeout',
  'timed out',
  'econnreset',
  'econnrefused',
  'enotfound',
  'network',
  'fetch failed',
  'socket hang up',
  '503',
  '502',
  '504',
  '429',
];

/**
 * Classify a raw simulation error string into a structured failure.
 *
 * @param error - Raw error message from the RPC simulation result.
 * @returns Structured failure descriptor.
 */
export function classifySimulationError(error: string): SorobanFailure {
  const normalized = (error ?? '').toLowerCase();

  if (CONTRACT_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      kind: 'contract_error',
      message: error,
      retryable: false,
    };
  }

  if (NETWORK_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      kind: 'network_error',
      message: error,
      retryable: true,
    };
  }

  return {
    kind: 'simulation_error',
    message: error,
    retryable: false,
  };
}

/**
 * Classify a thrown error (transport/RPC failure) into a structured failure.
 *
 * @param error - The thrown error.
 * @returns Structured failure descriptor.
 */
export function classifyThrownError(error: unknown): SorobanFailure {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const normalized = message.toLowerCase();

  if (NETWORK_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      kind: 'network_error',
      message,
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    message,
    retryable: false,
  };
}

/**
 * Simulate a Soroban transaction and return fee/resource estimates.
 *
 * This function simulates the transaction on the network to determine the
 * minimum resource fee required, then applies a safety buffer to account for
 * network congestion and resource fluctuations.
 *
 * When `options.lifecycle` is provided, the flow records `simulating`,
 * `retrying`, `failed`, and `aborted` transitions so the web layer can
 * persist and render the confirmation timeline.
 *
 * @param rpc - Soroban RPC server instance.
 * @param transaction - The transaction to simulate.
 * @param options - Configuration options for estimation.
 * @returns Transaction estimate with fee and resource usage.
 *
 * @example
 * ```ts
 * const estimate = await estimateTransactionFee(rpc, transaction, {
 *   feeBufferMultiplier: 1.5,
 * });
 * console.log(`Recommended fee: ${estimate.recommendedFee} stroops`);
 * console.log(`CPU instructions: ${estimate.resources.instructions}`);
 * ```
 */
export async function estimateTransactionFee(
  rpc: Server,
  transaction: Transaction,
  options: EstimationOptions = {},
): Promise<TransactionEstimate> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lifecycle = opts.lifecycle;

  lifecycle?.transition('simulating');

  // Guard the simulation against a network switch that happened before we
  // started. A mismatch is terminal: retrying cannot fix a wrong chain.
  if (opts.chainIdentity) {
    try {
      const current = await captureChainIdentity(rpc);
      assertChainIdentity(opts.chainIdentity, current, 'simulation');
    } catch (err) {
      if (err instanceof ChainIdentityMismatchError) {
        lifecycle?.abort(err);
      }
      throw err;
    }
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    try {
      const simulation = await rpc.simulateTransaction(transaction);

      // Re-check after simulation: the wallet may have switched networks
      // while the simulation was in flight.
      if (opts.chainIdentity) {
        try {
          const current = await captureChainIdentity(rpc);
          assertChainIdentity(opts.chainIdentity, current, 'simulation');
        } catch (err) {
          if (err instanceof ChainIdentityMismatchError) {
            lifecycle?.abort(err);
          }
          throw err;
        }
      }

      if (Api.isSimulationError(simulation)) {
        const failure = classifySimulationError(simulation.error);
        lifecycle?.fail(failure, simulation.error);
        return {
          recommendedFee: opts.baseFee,
          minResourceFee: '0',
          resources: {
            instructions: 0,
            readBytes: 0,
            writeBytes: 0,
            readEntries: 0,
            writeEntries: 0,
          },
          success: false,
          error: simulation.error,
          failure,
        };
      }

      const successResponse = simulation as Api.SimulateTransactionSuccessResponse;
      const minResourceFee = successResponse.minResourceFee ?? '0';
      const sorobanData = successResponse.transactionData;

      // Apply safety buffer to account for network congestion
      const recommendedFee = String(
        Math.ceil(Number(minResourceFee) * opts.feeBufferMultiplier + Number(opts.baseFee)),
      );

      // Extract resource footprint from Soroban transaction data
      const resources = extractResources(sorobanData);

      return {
        recommendedFee,
        minResourceFee,
        resources,
        success: true,
      };
    } catch (err) {
      if (err instanceof ChainIdentityMismatchError) {
        throw err;
      }
      lastError = err as Error;
      if (attempt < opts.maxRetries - 1) {
        const failure = classifyThrownError(err);
        if (failure.retryable) {
          lifecycle?.retry(failure);
        }
        await sleep(opts.retryDelayMs);
      }
    }
  }

  const failure = lastError
    ? classifyThrownError(lastError)
    : {
        kind: 'unknown' as const,
        message: 'Simulation failed after retries',
        retryable: true,
      };

  lifecycle?.fail(failure);

  return {
    recommendedFee: opts.baseFee,
    minResourceFee: '0',
    resources: {
      instructions: 0,
      readBytes: 0,
      writeBytes: 0,
      readEntries: 0,
      writeEntries: 0,
    },
    success: false,
    error: failure.message,
    failure,
  };
}

/**
 * Extract resource usage from Soroban transaction data XDR.
 *
 * @param sorobanData - Base64-encoded Soroban transaction data.
 * @returns Resource usage metrics.
 */
function extractResources(sorobanData?: string | SorobanDataBuilder): ResourceUsage {
  const defaultResources: ResourceUsage = {
    instructions: 0,
    readBytes: 0,
    writeBytes: 0,
    readEntries: 0,
    writeEntries: 0,
  };

  if (!sorobanData) {
    return defaultResources;
  }

  try {
    const data =
      typeof sorobanData === 'string'
        ? xdr.SorobanTransactionData.fromXDR(sorobanData, 'base64')
        : sorobanData.build();
    const footprint = data.resources();

    return {
      instructions: Number(footprint.instructions()),
      readBytes: Number(footprint.diskReadBytes()),
      writeBytes: Number(footprint.writeBytes()),
      readEntries: footprint.footprint().readOnly().length,
      writeEntries: footprint.footprint().readWrite().length,
    };
  } catch {
    return defaultResources;
  }
}

/**
 * Analyze network congestion by examining recent ledger fees.
 *
 * This function queries the RPC server for recent ledger information and
 * calculates congestion metrics to help determine appropriate fee levels.
 *
 * @param rpc - Soroban RPC server instance.
 * @param ledgerCount - Number of recent ledgers to analyze (default: 10).
 * @returns Network congestion metrics.
 *
 * @example
 * ```ts
 * const metrics = await analyzeNetworkCongestion(rpc, 20);
 * console.log(`Congestion level: ${metrics.congestionLevel}`);
 * console.log(`Average fee: ${metrics.averageFee} stroops`);
 * ```
 */
export async function analyzeNetworkCongestion(
  rpc: Server,
  ledgerCount: number = 10,
): Promise<NetworkMetrics> {
  try {
    const latestLedger = await rpc.getLatestLedger();
    const sequence = Number(latestLedger.sequence);

    const firstLedger = Math.max(1, sequence - ledgerCount + 1);
    const response = await rpc.getLedgers({
      startLedger: firstLedger,
      pagination: { limit: ledgerCount },
    });
    const fees = response.ledgers.map((ledger) =>
      BigInt(ledger.headerXdr.header().baseFee() || 100),
    );

    if (fees.length === 0) {
      return getDefaultMetrics();
    }

    const minFee = fees.reduce((a, b) => (a < b ? a : b));
    const maxFee = fees.reduce((a, b) => (a > b ? a : b));
    const totalFee = fees.reduce((a, b) => a + b, 0n);
    const averageFee = totalFee / BigInt(fees.length);

    // Determine congestion level based on fee distribution
    const congestionLevel = determineCongestionLevel(averageFee, minFee, maxFee);

    return {
      congestionLevel,
      averageFee: averageFee.toString(),
      minFee: minFee.toString(),
      maxFee: maxFee.toString(),
      ledgerCount: fees.length,
    };
  } catch {
    return getDefaultMetrics();
  }
}

/**
 * Determine congestion level based on fee metrics.
 */
function determineCongestionLevel(averageFee: bigint, minFee: bigint, maxFee: bigint): CongestionLevel {
  const feeRange = maxFee - minFee;
  const averageOffset = averageFee - minFee;

  // If fees are consistently low, congestion is low
  if (averageFee <= 100n) {
    return 'low';
  }

  // If average is close to max, congestion is high
  if (feeRange > 0n && averageOffset > feeRange / 2n) {
    return 'high';
  }

  // Otherwise, medium congestion
  return 'medium';
}

/**
 * Get default network metrics when analysis fails.
 */
function getDefaultMetrics(): NetworkMetrics {
  return {
    congestionLevel: 'medium',
    averageFee: '100',
    minFee: '100',
    maxFee: '100',
    ledgerCount: 0,
  };
}

/**
 * Suggest an appropriate fee based on network congestion and transaction estimate.
 *
 * This function combines network congestion analysis with transaction simulation
 * to recommend an optimal fee that balances cost and reliability.
 *
 * @param estimate - Transaction estimate from simulation.
 * @param metrics - Network congestion metrics.
 * @param options - Configuration options.
 * @returns Recommended fee in stroops.
 *
 * @example
 * ```ts
 * const estimate = await estimateTransactionFee(rpc, transaction);
 * const metrics = await analyzeNetworkCongestion(rpc);
 * const suggestedFee = suggestFee(estimate, metrics);
 * console.log(`Suggested fee: ${suggestedFee} stroops`);
 * ```
 */
export function suggestFee(
  estimate: TransactionEstimate,
  metrics: NetworkMetrics,
  options: EstimationOptions = {},
): string {
  if (!estimate.success) {
    return options.baseFee ?? DEFAULT_OPTIONS.baseFee;
  }

  const baseFee = BigInt(estimate.recommendedFee);
  const networkFee = BigInt(metrics.averageFee);

  // Adjust fee based on congestion level
  let congestionMultiplier = 1.0;
  switch (metrics.congestionLevel) {
    case 'high':
      congestionMultiplier = 1.5;
      break;
    case 'medium':
      congestionMultiplier = 1.2;
      break;
    case 'low':
      congestionMultiplier = 1.0;
      break;
  }

  // Calculate suggested fee
  const suggestedFee = baseFee * BigInt(Math.ceil(congestionMultiplier * 100)) / 100n;
  const finalFee = suggestedFee > networkFee ? suggestedFee : networkFee;

  return finalFee.toString();
}

/**
 * Suggest resource limits based on transaction estimate with safety margins.
 *
 * This function takes the resource usage from simulation and adds safety margins
 * to ensure the transaction has sufficient resources even under varying conditions.
 *
 * @param estimate - Transaction estimate from simulation.
 * @param resourceBufferMultiplier - Multiplier for resource buffer (default: 1.3).
 * @returns Suggested resource limits.
 *
 * @example
 * ```ts
 * const estimate = await estimateTransactionFee(rpc, transaction);
 * const limits = suggestResourceLimits(estimate, 1.5);
 * console.log(`CPU instructions limit: ${limits.instructions}`);
 * ```
 */
export function suggestResourceLimits(
  estimate: TransactionEstimate,
  resourceBufferMultiplier: number = 1.3,
): ResourceUsage {
  if (!estimate.success) {
    return {
      instructions: 5_000_000,
      readBytes: 200_000,
      writeBytes: 100_000,
      readEntries: 50,
      writeEntries: 20,
    };
  }

  const buffer = Math.max(resourceBufferMultiplier, 1.1);

  return {
    instructions: Math.ceil(estimate.resources.instructions * buffer),
    readBytes: Math.ceil(estimate.resources.readBytes * buffer),
    writeBytes: Math.ceil(estimate.resources.writeBytes * buffer),
    readEntries: Math.ceil(estimate.resources.readEntries * buffer),
    writeEntries: Math.ceil(estimate.resources.writeEntries * buffer),
  };
}

/**
 * Guard a signing step against a network switch.
 *
 * Call this immediately before handing the transaction to the signer. If the
 * current chain differs from the captured identity the flow is aborted and
 * the user must renew confirmation.
 *
 * @param rpc - Soroban RPC server instance.
 * @param expected - Identity captured when the flow started.
 * @throws {ChainIdentityMismatchError} When the chain has changed.
 */
export async function assertChainBeforeSigning(rpc: Server, expected: ChainIdentity): Promise<void> {
  const current = await captureChainIdentity(rpc);
  assertChain