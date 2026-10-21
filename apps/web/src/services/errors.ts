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
 * Stable error codes for upload presign validation failures.
 * These codes are part of the public API contract and must not change.
 */
export const PresignErrorCode = {
  /** MIME type is missing, malformed, or not in the allowlist. */
  INVALID_TYPE: 'PRESIGN_INVALID_TYPE',
  /** Declared byte size is missing, non-numeric, or outside the allowed bounds. */
  INVALID_SIZE: 'PRESIGN_INVALID_SIZE',
  /** Object key is missing or does not use an allowed safe prefix. */
  INVALID_KEY: 'PRESIGN_INVALID_KEY',
  /** Requesting account is not authorized to presign for this campaign. */
  UNAUTHORIZED: 'PRESIGN_UNAUTHORIZED',
  /** Presign request has expired or requested expiry exceeds the maximum window. */
  EXPIRED: 'PRESIGN_EXPIRED',
} as const;

export type PresignErrorCodeValue = (typeof PresignErrorCode)[keyof typeof PresignErrorCode];

/**
 * Error thrown when an upload presign request fails validation
 * (MIME type, byte limits, or safe key prefix).
 */
export class PresignValidationError extends StellarError {
  public readonly field?: string;
  public readonly reason: PresignErrorCodeValue;

  constructor(
    message: string,
    reason: PresignErrorCodeValue = PresignErrorCode.INVALID_TYPE,
    field?: string,
    originalError?: Error
  ) {
    super(message, reason, originalError);
    this.name = 'PresignValidationError';
    this.reason = reason;
    this.field = field;
    Object.setPrototypeOf(this, PresignValidationError.prototype);
  }
}

/**
 * Error thrown when the requesting account is not authorized to presign
 * an upload for the target campaign.
 */
export class PresignUnauthorizedError extends StellarError {
  public readonly campaignId?: string;
  public readonly accountId?: string;

  constructor(
    message = 'You are not authorized to upload to this campaign.',
    options?: { campaignId?: string; accountId?: string; originalError?: Error }
  ) {
    super(message, PresignErrorCode.UNAUTHORIZED, options?.originalError);
    this.name = 'PresignUnauthorizedError';
    this.campaignId = options?.campaignId;
    this.accountId = options?.accountId;
    Object.setPrototypeOf(this, PresignUnauthorizedError.prototype);
  }
}

/**
 * Error thrown when a presign request has expired or requests an expiry
 * beyond the maximum allowed window.
 */
export class PresignExpiredError extends StellarError {
  public readonly expiresAt?: number;

  constructor(
    message = 'This upload presign request has expired. Please request a new one.',
    options?: { expiresAt?: number; originalError?: Error }
  ) {
    super(message, PresignErrorCode.EXPIRED, options?.originalError);
    this.name = 'PresignExpiredError';
    this.expiresAt = options?.expiresAt;
    Object.setPrototypeOf(this, PresignExpiredError.prototype);
  }
}

/**
 * Stable error codes for public contract compilation resource-limit failures.
 * These codes are part of the public API contract and must not change.
 */
export const CompilationLimitCode = {
  /** Request body or source exceeds the configured byte limit. */
  REQUEST_TOO_LARGE: 'COMPILE_REQUEST_TOO_LARGE',
  /** Compilation exceeded the configured wall-clock timeout. */
  TIMEOUT: 'COMPILE_TIMEOUT',
  /** Too many concurrent compilations are in flight. */
  CONCURRENCY: 'COMPILE_CONCURRENCY_LIMIT',
  /** Compiled output exceeds the configured byte limit. */
  OUTPUT_TOO_LARGE: 'COMPILE_OUTPUT_TOO_LARGE',
} as const;

export type CompilationLimitCodeValue =
  (typeof CompilationLimitCode)[keyof typeof CompilationLimitCode];

/**
 * Error thrown when a public contract compilation request exceeds a
 * configured resource limit (request size, CPU/time, concurrency, output size).
 */
export class CompilationLimitError extends StellarError {
  public readonly reason: CompilationLimitCodeValue;
  public readonly limit?: number;
  public readonly actual?: number;

  constructor(
    message: string,
    reason: CompilationLimitCodeValue,
    options?: { limit?: number; actual?: number; originalError?: Error }
  ) {
    super(message, reason, options?.originalError);
    this.name = 'CompilationLimitError';
    this.reason = reason;
    this.limit = options?.limit;
    this.actual = options?.actual;
    Object.setPrototypeOf(this, CompilationLimitError.prototype);
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
