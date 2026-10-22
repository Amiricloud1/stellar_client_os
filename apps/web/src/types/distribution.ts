/**
 * Type definitions for Token Distribution UI
 */

/**
 * Distribution type enum
 */
export type DistributionType = "equal" | "weighted";

/**
 * Recipient data structure
 */
export interface Recipient {
  /** Unique identifier for the recipient */
  id: string;
  /** Stellar address of the recipient */
  address: string;
  /** Amount for this recipient (required for weighted, calculated for equal) */
  amount?: string;
  /** Whether the recipient data is valid */
  isValid: boolean;
  /** Validation error message if any */
  validationError?: string;
  /** Whether the address is a duplicate */
  isDuplicate?: boolean;
  /** Warning message if any (e.g. duplicate address warning) */
  warning?: string;
}

/**
 * Distribution state interface
 */
export interface DistributionState {
  /** Type of distribution (equal or weighted) */
  type: DistributionType;
  /** List of recipients */
  recipients: Recipient[];
  /** Total amount for equal distribution */
  totalAmount: string;
  /** Whether the entire state is valid */
  isValid: boolean;
  /** List of validation errors */
  errors: ValidationError[];
}

/**
 * Validation error interface
 */
export interface ValidationError {
  /** Field that has the error */
  field: string;
  /** Error message */
  message: string;
  /** Recipient ID if error is specific to a recipient */
  recipientId?: string;
}

/**
 * Transaction summary for confirmation
 */
export interface TransactionSummary {
  /** Distribution type */
  type: DistributionType;
  /** Number of recipients */
  recipientCount: number;
  /** Total amount to be distributed */
  totalAmount: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Estimated transaction fee */
  estimatedFee: string;
}

/**
 * CSV processing error
 */
export interface CSVError {
  /** Line number where error occurred */
  line: number;
  /** Column name if applicable */
  column?: string;
  /** Error message */
  message: string;
  /** Invalid value that caused the error */
  value?: string;
}

/**
 * CSV processing warning
 */
export interface CSVWarning {
  /** Line number where warning occurred */
  line: number;
  /** Warning message */
  message: string;
  /** Value that caused the warning */
  value?: string;
}

/**
 * CSV validation result
 */
export interface CSVValidationResult {
  /** Whether the CSV is valid */
  isValid: boolean;
  /** List of errors found */
  errors: CSVError[];
  /** List of warnings found */
  warnings: CSVWarning[];
  /** Successfully parsed recipients */
  recipients: Recipient[];
}

/**
 * Distribution operation for service integration
 */
export interface DistributionOperation {
  /** Distribution type */
  type: DistributionType;
  /** Token contract address */
  token: string;
  /** List of recipient addresses */
  recipients: string[];
  /** List of amounts (for weighted) or single total amount (for equal) */
  amounts: string[];
}

/**
 * Kind of operation a simulation was produced for.
 * Used to label the pre-signing review surface.
 */
export type SimulationOperationKind =
  | "funding"
  | "payout"
  | "stream"
  | "distribution";

/**
 * Status of a simulation result.
 * - `success`: simulation completed and the transaction is expected to succeed
 * - `rejected`: simulation completed and the transaction would fail on-chain
 * - `stale`: simulation no longer matches the current transaction inputs
 * - `error`: simulation could not be produced (network, RPC, etc.)
 */
export type SimulationStatus = "success" | "rejected" | "stale" | "error";

/**
 * A single asset movement produced by a simulated transaction.
 */
export interface SimulationAmount {
  /** Token symbol (e.g. "XLM", "USDC") */
  tokenSymbol: string;
  /** Token contract or issuer address, if applicable */
  tokenAddress?: string;
  /** Human-readable amount (decimal string, already formatted) */
  amount: string;
  /** Number of decimals used to format the amount */
  decimals: number;
}

/**
 * Destination of a simulated asset movement.
 */
export interface SimulationDestination {
  /** Stellar address receiving the funds */
  address: string;
  /** Optional human-readable label (e.g. recipient name) */
  label?: string;
  /** Amount expected to arrive at this destination */
  amount: SimulationAmount;
}

/**
 * Fee breakdown for a simulated transaction.
 */
export interface SimulationFees {
  /** Base fee in stroops (as a decimal string to avoid precision loss) */
  baseFeeStroops: string;
  /** Total fee in stroops (as a decimal string to avoid precision loss) */
  totalFeeStroops: string;
  /** Total fee formatted in the native asset (e.g. "0.0000100 XLM") */
  totalFeeFormatted: string;
  /** Optional resource fee for Soroban transactions, in stroops */
  resourceFeeStroops?: string;
}

/**
 * A single contract effect (state change, event, or invocation) observed
 * during simulation.
 */
export interface SimulationContractEffect {
  /** Contract address affected by the effect */
  contractId: string;
  /** Kind of effect observed */
  kind: "invocation" | "state-change" | "event" | "transfer";
  /** Human-readable description of the effect */
  description: string;
  /** Optional raw effect payload for advanced inspection */
  data?: Record<string, unknown>;
}

/**
 * Result of simulating a transaction before signing.
 */
export interface SimulationResult {
  /** Operation kind the simulation was produced for */
  operationKind: SimulationOperationKind;
  /** Overall simulation status */
  status: SimulationStatus;
  /** Chain identifier the simulation was run against (e.g. "stellar:testnet") */
  chainId: string;
  /** Ledger sequence the simulation was run against */
  ledger: number;
  /** Amounts moved by the transaction */
  amounts: SimulationAmount[];
  /** Destinations receiving funds */
  destinations: SimulationDestination[];
  /** Fee breakdown for the transaction */
  fees: SimulationFees;
  /** Contract effects observed during simulation */
  contractEffects: SimulationContractEffect[];
  /** Human-readable error/rejection reason when status is not `success` */
  errorMessage?: string;
  /** ISO timestamp of when the simulation was produced */
  simulatedAt: string;
  /** Hash of the transaction envelope the simulation was produced for */
  transactionHash?: string;
}

/**
 * Inputs used to detect whether a simulation result is stale relative to
 * the current transaction being reviewed.
 */
export interface SimulationFingerprint {
  /** Chain identifier the transaction targets */
  chainId: string;
  /** Operation kind */
  operationKind: SimulationOperationKind;
  /** Hash of the transaction envelope, when available */
  transactionHash?: string;
  /** Serialized operation inputs used to detect drift */
  inputsHash: string;
}