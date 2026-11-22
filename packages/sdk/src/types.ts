/**
 * Type definitions for four critical objectives
 * These types support operation nonces, event traceability, fund authorization,
 * and token metadata preservation
 */

/**
 * Objective 1 & 4: Operation nonces for multi-contract workflows
 * Combines wallet sequence, operation index, and contract address
 */
export interface OperationNonce {
  /** Wallet's transaction sequence number (unique per transaction) */
  walletSequence: bigint | number;

  /** Index of this operation within the transaction */
  operationIndex: number;

  /** Contract that issued this nonce */
  contract: string;
}

/**
 * Objective 4: Event reference for stable causality tracking
 * Uniquely identifies an event and links it to the operation that caused it
 */
export interface EventReference {
  /** The operation that triggered this event */
  operationNonce: OperationNonce;

  /** Hash of event data for integrity verification */
  eventHash: string;

  /** Ledger sequence number when event was emitted */
  ledgerSequence: number;

  /** Unix timestamp when event was emitted */
  ledgerTimestamp: number;
}

/**
 * Objective 2: Token metadata snapshot at liability inception
 * Ensures decimals and asset identity cannot change after stream creation
 */
export interface TokenMetadata {
  /** Contract address of the token */
  token: string;

  /** Number of decimal places (immutable for stream lifetime) */
  decimals: number;

  /** Human-readable token name */
  name: string;

  /** One-letter symbol */
  symbol: string;
}

/**
 * Objective 3: Fund authorization policy and spending limits
 */
export interface FundSpendingLimit {
  /** Maximum per single transaction */
  perTransactionLimit: number;

  /** Maximum per day */
  perDayLimit: number;

  /** Maximum total */
  totalLimit: number;

  /** Amount already spent */
  amountSpent: number;

  /** Amount spent in current day */
  amountSpentToday: number;

  /** Last day reset timestamp */
  lastDayReset: number;
}

export enum FundPurpose {
  Reserve = 'reserve',
  Incentive = 'incentive',
  Revenue = 'revenue',
  Development = 'development',
  Emergency = 'emergency',
}

export enum AuthorizationLevel {
  Single = 'single',
  MultiSig = 'multisig',
  Governance = 'governance',
}

export interface FundAuthorizationPolicy {
  /** Purpose of the fund */
  purpose: FundPurpose;

  /** Required authorization level */
  authLevel: AuthorizationLevel;

  /** Addresses authorized to approve disbursements */
  approvers: string[];

  /** Spending limits */
  spendingLimits: FundSpendingLimit;

  /** Allowed recipients (empty = no restriction) */
  allowedRecipients: string[];

  /** Whether policy is active */
  active: boolean;
}

/**
 * Objective 4: Stream event with full traceability
 */
export interface StreamEvent {
  /** Unique stable reference to this event */
  eventRef: EventReference;

  /** Stream ID being modified */
  streamId: string;

  /** Type of event */
  eventType: 'create' | 'deposit' | 'withdraw' | 'pause' | 'resume' | 'cancel';

  /** Amount involved (in native token units) */
  amount: number;

  /** Token metadata (immutable from stream creation) */
  tokenMetadata: TokenMetadata;

  /** Caller who initiated the event */
  caller: string;

  /** Timestamp of event */
  timestamp: number;
}

/**
 * Objective 1: Recovery checkpoint for multi-step operations
 */
export interface OperationRecovery {
  /** The operation this checkpoint belongs to */
  nonce: OperationNonce;

  /** Current step in the operation */
  step: number;

  /** Maximum step number */
  maxSteps: number;

  /** Timestamp of checkpoint creation */
  checkpointTime: number;

  /** Caller who initiated this operation */
  caller: string;

  /** Arbitrary state data */
  state: string;

  /** Whether operation completed successfully */
  completed: boolean;
}

/**
 * Objective 4: Reconciliation checkpoint for audit trail
 */
export interface ReconciliationCheckpoint {
  /** The operation that triggered this reconciliation */
  operationNonce: OperationNonce;

  /** Type of operation */
  operationType: string;

  /** Resource affected */
  resourceId: string;

  /** Expected balance after operation */
  expectedBalance: number;

  /** Actual balance observed */
  actualBalance: number;

  /** Whether reconciliation passed */
  reconciled: boolean;

  /** Timestamp of check */
  timestamp: number;
}

/**
 * Objective 4: Complete liability history for independent audit
 */
export interface LiabilityRecord {
  /** The operation that caused this liability change */
  operationNonce: OperationNonce;

  /** Event reference for causality verification */
  eventReference: EventReference;

  /** Type of change */
  changeType: 'deposit' | 'withdrawal' | 'penalty' | 'fee' | 'adjustment';

  /** Amount change */
  amount: number;

  /** Actor who initiated the change */
  actor: string;

  /** Reason/purpose for the change */
  reason?: string;

  /** Timestamp of change */
  timestamp: number;

  /** Ledger sequence of change */
  ledgerSequence: number;
}

/**
 * Objective 1: Multi-step workflow recovery
 */
export interface WorkflowStep {
  /** Operation this step belongs to */
  nonce: OperationNonce;

  /** Step index */
  stepIndex: number;

  /** Type of step (e.g., "validate", "execute", "confirm") */
  stepType: string;

  /** Status of step */
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'recovered';

  /** Input parameters for this step */
  input: Record<string, any>;

  /** Output/result of this step */
  output?: Record<string, any>;

  /** Error message if step failed */
  error?: string;

  /** Timestamp of step execution */
  timestamp: number;

  /** Attempt number (for recovery retries) */
  attemptNumber: number;
}

/**
 * Event emission interface for standardized event publishing
 */
export interface EventEmitter {
  /**
   * Emit a stream event with full traceability
   */
  emitStreamEvent(
    eventType: StreamEvent['eventType'],
    streamId: string,
    amount: number,
    tokenMetadata: TokenMetadata,
    operationRef: EventReference
  ): void;

  /**
   * Emit a reconciliation checkpoint
   */
  emitReconciliation(checkpoint: ReconciliationCheckpoint): void;

  /**
   * Emit a fund disbursement audit event
   */
  emitFundDisbursement(
    purpose: FundPurpose,
    amount: number,
    recipient: string,
    approvers: string[]
  ): void;
}

/**
 * Recovery handler for multi-step operations
 */
export interface RecoveryHandler {
  /**
   * Check if an operation needs recovery
   */
  checkRecoveryNeeded(nonce: OperationNonce): Promise<OperationRecovery | null>;

  /**
   * Save recovery checkpoint after completing a step
   */
  saveCheckpoint(nonce: OperationNonce, step: number, state: string): Promise<void>;

  /**
   * Mark operation as completed
   */
  completeOperation(nonce: OperationNonce): Promise<void>;

  /**
   * List all active (in-progress) operations
   */
  listActiveOperations(): Promise<OperationRecovery[]>;
}
