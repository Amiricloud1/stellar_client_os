/**
 * Canonical Transaction State Definitions (Issue #4)
 *
 * Unified state machine for transaction lifecycle across API, UI, and SDK.
 * All transaction-like operations (payments, campaigns, sponsorships) converge
 * on these canonical states bound to ledger finality.
 *
 * State Transitions:
 *   - PREPARING -> PENDING (transaction signed, submitted to network)
 *   - PENDING -> CONFIRMED (transaction included in a committed ledger)
 *   - PENDING -> FAILED (transaction rejected or expired)
 *   - CONFIRMED -> (terminal; no further transitions)
 *   - FAILED -> (terminal; no further transitions)
 *
 * Ledger Binding:
 *   - PENDING: Not yet in ledger
 *   - CONFIRMED: Included in ledger at sequence `ledgerSequence`
 *   - FAILED: Definitively failed (either in ledger or after timeout)
 */

/**
 * Canonical transaction state
 * Represents all possible states a transaction can be in from submission to finality
 */
export enum CanonicalTransactionState {
  /**
   * Transaction is being prepared (not yet signed or submitted).
   * Still possible to cancel without ledger effects.
   */
  PREPARING = 'preparing',

  /**
   * Transaction has been signed and submitted to the network.
   * Waiting for inclusion in a ledger.
   * May still fail if network is congested or fees insufficient.
   */
  PENDING = 'pending',

  /**
   * Transaction has been included in a committed ledger.
   * Effects are now permanent and cannot be rolled back.
   * Bound to specific ledger sequence and timestamp.
   */
  CONFIRMED = 'confirmed',

  /**
   * Transaction failed and will never confirm.
   * Either:
   *   - Included in ledger with a non-success result code, or
   *   - Expired after deadline and will not be retried
   */
  FAILED = 'failed',
}

/**
 * Typed predicate: is this a pending state?
 */
export function isPending(state: CanonicalTransactionState): boolean {
  return state === CanonicalTransactionState.PENDING;
}

/**
 * Typed predicate: is this a terminal state?
 */
export function isTerminal(state: CanonicalTransactionState): boolean {
  return (
    state === CanonicalTransactionState.CONFIRMED || state === CanonicalTransactionState.FAILED
  );
}

/**
 * Typed predicate: is this a success state?
 */
export function isSuccess(state: CanonicalTransactionState): boolean {
  return state === CanonicalTransactionState.CONFIRMED;
}

/**
 * Canonical error type for transaction failures
 * Covers all failure modes with actionable categorization
 */
export enum TransactionErrorCategory {
  /**
   * Transaction was properly rejected by the network (e.g., insufficient funds, auth failure)
   * Result XDR contains the specific error code.
   */
  REJECTED = 'rejected',

  /**
   * Transaction was not accepted or dropped by RPC (bad signature, malformed)
   */
  INVALID = 'invalid',

  /**
   * Network issues prevented submission or polling (connectivity, RPC down)
   */
  NETWORK = 'network',

  /**
   * Transaction deadline expired before confirmation
   */
  EXPIRED = 'expired',

  /**
   * An unexpected error occurred (client bug, RPC bug, etc)
   */
  UNKNOWN = 'unknown',
}

/**
 * Ledger binding for a confirmed transaction
 */
export interface LedgerBinding {
  /** Ledger sequence number where transaction was confirmed */
  ledgerSequence: number;

  /** Consensus timestamp of the ledger */
  ledgerTimestamp: Date;

  /** Transaction index within the ledger */
  txIndex?: number;

  /** Closing time of the ledger (if different from consensus time) */
  closingTime?: Date;
}

/**
 * Canonical transaction status
 * Includes all information needed to present state in UI and sync with ledger
 */
export interface CanonicalTransactionStatus {
  /** Unique transaction ID (e.g., hash, UUID, or contract operation ID) */
  id: string;

  /** Current state */
  state: CanonicalTransactionState;

  /** Network where transaction is executing (testnet, mainnet, futurenet) */
  network: string;

  /** When was this status last updated? */
  updatedAt: Date;

  /**
   * Ledger binding (present only if CONFIRMED or FAILED-in-ledger)
   * Absent if transaction is still PENDING or FAILED-before-ledger
   */
  ledgerBinding?: LedgerBinding;

  /**
   * For FAILED transactions, categorize the failure mode
   */
  failureCategory?: TransactionErrorCategory;

  /**
   * Human-readable error message (if FAILED)
   */
  failureMessage?: string;

  /**
   * Suggested recovery action (e.g., "retry with higher fee", "use different account")
   */
  recoverySuggestion?: string;

  /**
   * For PENDING, how long have we been waiting? (ms)
   */
  pendingDurationMs?: number;

  /**
   * User-facing context (e.g., operation type: "payment", "campaign-contribution")
   */
  operationType?: string;

  /**
   * Raw transaction result XDR (if available; useful for debugging)
   */
  resultXdr?: string;

  /**
   * Raw transaction envelope XDR (if available)
   */
  envelopeXdr?: string;

  /**
   * Idempotency key for retry scenarios
   */
  idempotencyKey?: string;
}

/**
 * State transition validation
 * Ensures only valid state transitions are allowed
 */
export function canTransitionTo(
  from: CanonicalTransactionState,
  to: CanonicalTransactionState
): boolean {
  // PREPARING can transition to PENDING
  if (from === CanonicalTransactionState.PREPARING && to === CanonicalTransactionState.PENDING) {
    return true;
  }

  // PENDING can transition to CONFIRMED or FAILED
  if (
    from === CanonicalTransactionState.PENDING &&
    (to === CanonicalTransactionState.CONFIRMED || to === CanonicalTransactionState.FAILED)
  ) {
    return true;
  }

  // No transitions from terminal states
  if (
    from === CanonicalTransactionState.CONFIRMED ||
    from === CanonicalTransactionState.FAILED
  ) {
    return false;
  }

  return false;
}

/**
 * Convert the 4-state canonical model to legacy domain-specific states
 * (for backward compatibility with existing code)
 *
 * @param canonicalState The canonical state
 * @param context Domain context (e.g., 'offramp', 'sponsorship')
 * @returns Legacy state name in the domain
 */
export function toLegacyState(canonicalState: CanonicalTransactionState, context: string): string {
  switch (context) {
    case 'offramp':
      switch (canonicalState) {
        case CanonicalTransactionState.PREPARING:
          return 'pending';
        case CanonicalTransactionState.PENDING:
          return 'processing';
        case CanonicalTransactionState.CONFIRMED:
          return 'completed';
        case CanonicalTransactionState.FAILED:
          return 'failed';
      }
      break;

    case 'sponsorship':
      switch (canonicalState) {
        case CanonicalTransactionState.PREPARING:
          return 'draft';
        case CanonicalTransactionState.PENDING:
          return 'submitted';
        case CanonicalTransactionState.CONFIRMED:
          return 'confirmed';
        case CanonicalTransactionState.FAILED:
          return 'rejected';
      }
      break;

    case 'campaign':
      switch (canonicalState) {
        case CanonicalTransactionState.PREPARING:
          return 'draft';
        case CanonicalTransactionState.PENDING:
          return 'pending';
        case CanonicalTransactionState.CONFIRMED:
          return 'confirmed';
        case CanonicalTransactionState.FAILED:
          return 'failed';
      }
      break;

    default:
      // Generic fallback
      return canonicalState.toLowerCase();
  }

  return 'unknown';
}

/**
 * Parse legacy domain state back to canonical
 * (inverse of toLegacyState)
 *
 * @param legacyState Legacy state name
 * @param context Domain context
 * @returns Canonical state, or null if unmappable
 */
export function fromLegacyState(
  legacyState: string,
  context: string
): CanonicalTransactionState | null {
  const state = legacyState.toLowerCase();

  switch (context) {
    case 'offramp':
      switch (state) {
        case 'pending':
          return CanonicalTransactionState.PREPARING;
        case 'processing':
          return CanonicalTransactionState.PENDING;
        case 'completed':
          return CanonicalTransactionState.CONFIRMED;
        case 'failed':
        case 'expired':
          return CanonicalTransactionState.FAILED;
      }
      break;

    case 'sponsorship':
      switch (state) {
        case 'draft':
          return CanonicalTransactionState.PREPARING;
        case 'submitted':
          return CanonicalTransactionState.PENDING;
        case 'confirmed':
          return CanonicalTransactionState.CONFIRMED;
        case 'rejected':
          return CanonicalTransactionState.FAILED;
      }
      break;

    case 'campaign':
      switch (state) {
        case 'draft':
          return CanonicalTransactionState.PREPARING;
        case 'pending':
          return CanonicalTransactionState.PENDING;
        case 'confirmed':
          return CanonicalTransactionState.CONFIRMED;
        case 'failed':
          return CanonicalTransactionState.FAILED;
      }
      break;

    default:
      // Try generic mapping
      switch (state) {
        case 'preparing':
        case 'draft':
          return CanonicalTransactionState.PREPARING;
        case 'pending':
        case 'submitted':
        case 'processing':
          return CanonicalTransactionState.PENDING;
        case 'confirmed':
        case 'completed':
        case 'success':
          return CanonicalTransactionState.CONFIRMED;
        case 'failed':
        case 'rejected':
        case 'expired':
          return CanonicalTransactionState.FAILED;
      }
  }

  return null;
}

/**
 * Create a CanonicalTransactionStatus from basic information
 */
export function createTransactionStatus(
  id: string,
  state: CanonicalTransactionState,
  network: string,
  overrides?: Partial<CanonicalTransactionStatus>
): CanonicalTransactionStatus {
  return {
    id,
    state,
    network,
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * User-friendly description of a state
 */
export function describeState(state: CanonicalTransactionState): string {
  switch (state) {
    case CanonicalTransactionState.PREPARING:
      return 'Preparing transaction (not yet submitted)';
    case CanonicalTransactionState.PENDING:
      return 'Transaction submitted, waiting for confirmation';
    case CanonicalTransactionState.CONFIRMED:
      return 'Transaction confirmed and finalized on the ledger';
    case CanonicalTransactionState.FAILED:
      return 'Transaction failed and will not be confirmed';
  }
}
