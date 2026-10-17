/**
 * Custom error classes for Stellar Service
 * Provides user-friendly error messages and proper error categorization
 */

/**
 * Base error class for all Stellar-related errors
 */
export class StellarError extends Error {
  public readonly code: string;
  public readonly originalError?: Error;

  constructor(message: string, code: string, originalError?: Error) {
    super(message);
    this.name = 'StellarError';
    this.code = code;
    this.originalError = originalError;
    Object.setPrototypeOf(this, StellarError.prototype);
  }
}

/**
 * Error thrown when network connection fails
 */
export class NetworkError extends StellarError {
  constructor(message: string, originalError?: Error) {
    super(message, 'NETWORK_ERROR', originalError);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * Error thrown when transaction fails
 */
export class TransactionError extends StellarError {
  public readonly txHash?: string;
  public readonly resultCodes?: string[];

  constructor(
    message: string,
    options?: { txHash?: string; resultCodes?: string[]; originalError?: Error }
  ) {
    super(message, 'TRANSACTION_ERROR', options?.originalError);
    this.name = 'TransactionError';
    this.txHash = options?.txHash;
    this.resultCodes = options?.resultCodes;
    Object.setPrototypeOf(this, TransactionError.prototype);
  }
}

/**
 * Error thrown when transaction times out
 */
export class TransactionTimeoutError extends TransactionError {
  constructor(txHash: string, originalError?: Error) {
    super(
      'Transaction timed out. It may still be processed. Check status with the transaction hash.',
      { txHash, originalError }
    );
    this.name = 'TransactionTimeoutError';
    Object.setPrototypeOf(this, TransactionTimeoutError.prototype);
  }
}

/**
 * Error thrown when contract invocation fails
 */
export class ContractError extends StellarError {
  public readonly contractId?: string;
  public readonly method?: string;

  constructor(
    message: string,
    options?: { contractId?: string; method?: string; originalError?: Error }
  ) {
    super(message, 'CONTRACT_ERROR', options?.originalError);
    this.name = 'ContractError';
    this.contractId = options?.contractId;
    this.method = options?.method;
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

/**
 * Error thrown when simulation fails
 */
export class SimulationError extends StellarError {
  public readonly simulationResult?: unknown;

  constructor(message: string, simulationResult?: unknown, originalError?: Error) {
    super(message, 'SIMULATION_ERROR', originalError);
    this.name = 'SimulationError';
    this.simulationResult = simulationResult;
    Object.setPrototypeOf(this, SimulationError.prototype);
  }
}

/**
 * Error thrown when account is not found
 */
export class AccountNotFoundError extends StellarError {
  public readonly accountId: string;

  constructor(accountId: string, originalError?: Error) {
    super(`Account not found: ${accountId}`, 'ACCOUNT_NOT_FOUND', originalError);
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
    Object.setPrototypeOf(this, AccountNotFoundError.prototype);
  }
}

/**
 * Error thrown when stream is not found
 */
export class StreamNotFoundError extends StellarError {
  public readonly streamId: bigint;

  constructor(streamId: bigint, originalError?: Error) {
    super(`Stream not found: ${streamId}`, 'STREAM_NOT_FOUND', originalError);
    this.name = 'StreamNotFoundError';
    this.streamId = streamId;
    Object.setPrototypeOf(this, StreamNotFoundError.prototype);
  }
}

/**
 * Error thrown when insufficient funds
 */
export class InsufficientFundsError extends StellarError {
  public readonly required?: bigint;
  public readonly available?: bigint;

  constructor(
    message: string,
    options?: { required?: bigint; available?: bigint; originalError?: Error }
  ) {
    super(message, 'INSUFFICIENT_FUNDS', options?.originalError);
    this.name = 'InsufficientFundsError';
    this.required = options?.required;
    this.available = options?.available;
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends StellarError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.field = field;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Error thrown when the authenticated caller does not own the requested resource.
 * Used by tax document generation to reject cross-account access (issue #61).
 */
export class UnauthorizedOwnerError extends StellarError {
  public readonly resourceType: string;
  public readonly resourceId: string;

  constructor(resourceType: string, resourceId: string) {
    super(
      `Authenticated user is not authorized to access ${resourceType} ${resourceId}.`,
      'UNAUTHORIZED_OWNER'
    );
    this.name = 'UnauthorizedOwnerError';
    this.resourceType = resourceType;
    this.resourceId = resourceId;
    Object.setPrototypeOf(this, UnauthorizedOwnerError.prototype);
  }
}

/**
 * Error thrown when a profile lacks verified attributes required for an operation.
 * Used by tax document generation to require a verified tax identity (issue #61).
 */
export class UnverifiedProfileError extends StellarError {
  public readonly missingAttributes: string[];

  constructor(missingAttributes: string[]) {
    super(
      `Profile is not verified for this operation. Missing verified attributes: ${missingAttributes.join(', ')}.`,
      'UNVERIFIED_PROFILE'
    );
    this.name = 'UnverifiedProfileError';
    this.missingAttributes = missingAttributes;
    Object.setPrototypeOf(this, UnverifiedProfileError.prototype);
  }
}

/**
 * Error thrown when a caller attempts to access another account's resources.
 * Used by tax document generation to reject cross-account access (issue #61).
 */
export class CrossAccountAccessError extends StellarError {
  public readonly resourceType: string;

  constructor(resourceType: string) {
    super(
      `Cross-account access to ${resourceType} is not permitted.`,
      'CROSS_ACCOUNT_ACCESS'
    );
    this.name = 'CrossAccountAccessError';
    this.resourceType = resourceType;
    Object.setPrototypeOf(this, CrossAccountAccessError.prototype);
  }
}

/**
 * Parse and transform SDK errors into user-friendly error classes
 */
export function parseError(error: unknown): StellarError {
  if (error instanceof StellarError) {
    return error;
  }

  const err = error as Error & { response?: { data?: { extras?: { result_codes?: unknown } } } };
  const message = err?.message || 'An unknown error occurred';

  // Check for network errors
  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT')
  ) {
    return new NetworkError('Unable to connect to the Stellar network. Please try again later.', err);
  }

  // Check for timeout errors
  if (message.includes('timeout') || message.includes('504')) {
    return new TransactionTimeoutError('', err);
  }

  // Check for account not found
  if (message.includes('Account not found') || message.includes('op_no_source_account')) {
    const accountMatch = message.match(/account[:\s]+([A-Z0-9]+)/i);
    return new AccountNotFoundError(accountMatch?.[1] || 'unknown', err);
  }

  // Check for insufficient funds
  if (
    message.includes('insufficient') ||
    message.includes('op_underfunded') ||
    message.includes('op_low_reserve')
  ) {
    return new InsufficientFundsError('Insufficient funds for this transaction.', { originalError: err });
  }

  // Check for transaction failures with result codes
  const resultCodes = err?.response?.data?.extras?.result_codes;
  if (resultCodes) {
    return new TransactionError('Transaction failed. Please check your parameters and try again.', {
      resultCodes: Array.isArray(resultCodes) ? resultCodes : [String(resultCodes)],
      originalError: err,
    });
  }

  // Default to generic stellar error
  return new StellarError(message, 'UNKNOWN_ERROR', err);
}
