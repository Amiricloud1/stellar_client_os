/**
 * Custom error classes for Stellar Service
 * Provides user-friendly error messages and proper error categorization
 *
 * All errors are built from the canonical `ApiError` envelope so that every
 * service returns a consistent shape to API consumers:
 *
 *   { code, message, requestId, fieldErrors?, details? }
 *
 * Stack traces are never part of the serialized form (see `toApiError`).
 */

/**
 * Canonical error envelope returned to API consumers.
 * This is the single source of truth for error shape across all services.
 */
export interface ApiError {
  /** Stable machine-readable error code (e.g. `NETWORK_ERROR`). */
  code: string;
  /** Human-readable, user-safe message. */
  message: string;
  /** Correlation ID shared with server logs. */
  requestId: string;
  /** Per-field validation errors, keyed by field name. */
  fieldErrors?: Record<string, string[]>;
  /** Optional non-sensitive structured details. */
  details?: Record<string, unknown>;
}

/**
 * Options accepted by every Stellar error constructor.
 */
export interface StellarErrorOptions {
  requestId?: string;
  fieldErrors?: Record<string, string[]>;
  details?: Record<string, unknown>;
  originalError?: Error;
}

/**
 * Generate a correlation ID when one is not supplied by the caller.
 * Uses the platform crypto when available, falling back to a random string.
 */
export function generateRequestId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Base error class for all Stellar-related errors
 */
export class StellarError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly fieldErrors?: Record<string, string[]>;
  public readonly details?: Record<string, unknown>;
  public readonly originalError?: Error;

  constructor(message: string, code: string, options?: StellarErrorOptions | Error) {
    super(message);
    this.name = 'StellarError';
    this.code = code;
    // Backwards compatibility: the third argument used to be `originalError`.
    const opts: StellarErrorOptions =
      options instanceof Error ? { originalError: options } : options ?? {};
    this.requestId = opts.requestId ?? generateRequestId();
    this.fieldErrors = opts.fieldErrors;
    this.details = opts.details;
    this.originalError = opts.originalError;
    Object.setPrototypeOf(this, StellarError.prototype);
  }

  /**
   * Serialize to the canonical `ApiError` envelope.
   * Never includes `stack`, `originalError`, or other internal fields.
   */
  toApiError(): ApiError {
    const envelope: ApiError = {
      code: this.code,
      message: this.message,
      requestId: this.requestId,
    };
    if (this.fieldErrors && Object.keys(this.fieldErrors).length > 0) {
      envelope.fieldErrors = this.fieldErrors;
    }
    if (this.details && Object.keys(this.details).length > 0) {
      envelope.details = this.details;
    }
    return envelope;
  }
}

/**
 * Convert any thrown value into the canonical `ApiError` envelope.
 * Stack traces are intentionally excluded from the result.
 */
export function toApiError(error: unknown, requestId?: string): ApiError {
  if (error instanceof StellarError) {
    const envelope = error.toApiError();
    return requestId ? { ...envelope, requestId } : envelope;
  }
  const parsed = parseError(error, requestId);
  return parsed.toApiError();
}

/**
 * Error thrown when network connection fails
 */
export class NetworkError extends StellarError {
  constructor(message: string, options?: StellarErrorOptions | Error) {
    super(message, 'NETWORK_ERROR', options);
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
    options?: StellarErrorOptions & { txHash?: string; resultCodes?: string[] }
  ) {
    super(message, 'TRANSACTION_ERROR', options);
    this.name = 'TransactionError';
    this.txHash = options?.txHash;
    this.resultCodes = options?.resultCodes;
    Object.setPrototypeOf(this, TransactionError.prototype);
  }

  toApiError(): ApiError {
    const envelope = super.toApiError();
    const details: Record<string, unknown> = { ...(envelope.details ?? {}) };
    if (this.txHash) details.txHash = this.txHash;
    if (this.resultCodes) details.resultCodes = this.resultCodes;
    if (Object.keys(details).length > 0) envelope.details = details;
    return envelope;
  }
}

/**
 * Error thrown when transaction times out
 */
export class TransactionTimeoutError extends TransactionError {
  constructor(txHash: string, options?: StellarErrorOptions | Error) {
    super(
      'Transaction timed out. It may still be processed. Check status with the transaction hash.',
      { ...(options instanceof Error ? { originalError: options } : options), txHash }
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
    options?: StellarErrorOptions & { contractId?: string; method?: string }
  ) {
    super(message, 'CONTRACT_ERROR', options);
    this.name = 'ContractError';
    this.contractId = options?.contractId;
    this.method = options?.method;
    Object.setPrototypeOf(this, ContractError.prototype);
  }

  toApiError(): ApiError {
    const envelope = super.toApiError();
    const details: Record<string, unknown> = { ...(envelope.details ?? {}) };
    if (this.contractId) details.contractId = this.contractId;
    if (this.method) details.method = this.method;
    if (Object.keys(details).length > 0) envelope.details = details;
    return envelope;
  }
}

/**
 * Error thrown when simulation fails
 */
export class SimulationError extends StellarError {
  public readonly simulationResult?: unknown;

  constructor(message: string, simulationResult?: unknown, options?: StellarErrorOptions | Error) {
    super(message, 'SIMULATION_ERROR', options);
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

  constructor(accountId: string, options?: StellarErrorOptions | Error) {
    super(`Account not found: ${accountId}`, 'ACCOUNT_NOT_FOUND', options);
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
    Object.setPrototypeOf(this, AccountNotFoundError.prototype);
  }

  toApiError(): ApiError {
    const envelope = super.toApiError();
    envelope.details = { ...(envelope.details ?? {}), accountId: this.accountId };
    return envelope;
  }
}

/**
 * Error thrown when stream is not found
 */
export class StreamNotFoundError extends StellarError {
  public readonly streamId: bigint;

  constructor(streamId: bigint, options?: StellarErrorOptions | Error) {
    super(`Stream not found: ${streamId}`, 'STREAM_NOT_FOUND', options);
    this.name = 'StreamNotFoundError';
    this.streamId = streamId;
    Object.setPrototypeOf(this, StreamNotFoundError.prototype);
  }

  toApiError(): ApiError {
    const envelope = super.toApiError();
    envelope.details = { ...(envelope.details ?? {}), streamId: this.streamId.toString() };
    return envelope;
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
    options?: StellarErrorOptions & { required?: bigint; available?: bigint }
  ) {
    super(message, 'INSUFFICIENT_FUNDS', options);
    this.name = 'InsufficientFundsError';
    this.required = options?.required;
    this.available = options?.available;
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }

  toApiError(): ApiError {
    const envelope = super.toApiError();
    const details: Record<string, unknown> = { ...(envelope.details ?? {}) };
    if (this.required !== undefined) details.required = this.required.toString();
    if (this.available !== undefined) details.available = this.available.toString();
    if (Object.keys(details).length > 0) envelope.details = details;
    return envelope;
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends StellarError {
  public readonly field?: string;

  constructor(
    message: string,
    fieldOrOptions?: string | (StellarErrorOptions & { field?: string })
  ) {
    const opts: StellarErrorOptions & { field?: string } =
      typeof fieldOrOptions === 'string' ? { field: fieldOrOptions } : fieldOrOptions ?? {};
    const field = opts.field;
    const fieldErrors =
      opts.fieldErrors ?? (field ? { [field]: [message] } : undefined);
    super(message, 'VALIDATION_ERROR', { ...opts, fieldErrors });
    this.name = 'ValidationError';
    this.field = field;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Parse and transform SDK errors into user-friendly error classes
 */
export function parseError(error: unknown, requestId?: string): StellarError {
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
    return new NetworkError('Unable to connect to the Stellar network. Please try again later.', {
      originalError: err,
      requestId,
    });
  }

  // Check for timeout errors
  if (message.includes('timeout') || message.includes('504')) {
    return new TransactionTimeoutError('', { originalError: err, requestId });
  }

  // Check for account not found
  if (message.includes('Account not found') || message.includes('op_no_source_account')) {
    const accountMatch = message.match(/account[:\s]+([A-Z0-9]+)/i);
    return new AccountNotFoundError(accountMatch?.[1] || 'unknown', {
      originalError: err,
      requestId,
    });
  }

  // Check for insufficient funds
  if (
    message.includes('insufficient') ||
    message.includes('op_underfunded') ||
    message.includes('op_low_reserve')
  ) {
    return new InsufficientFundsError('Insufficient funds for this transaction.', {
      originalError: err,
      requestId,
    });
  }

  // Check for transaction failures with result codes
  const resultCodes = err?.response?.data?.extras?.result_codes;
  if (resultCodes) {
    return new TransactionError('Transaction failed. Please check your parameters and try again.', {
      resultCodes: Array.isArray(resultCodes) ? resultCodes : [String(resultCodes)],
      originalError: err,
      requestId,
    });
  }

  // Default to generic stellar error
  return new StellarError(message, 'UNKNOWN_ERROR', { originalError: err, requestId });
}
