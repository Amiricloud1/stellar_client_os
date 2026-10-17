/**
 * Error handling utilities for Fundable Stellar smart contracts.
 *
 * Provides utilities to parse Soroban simulation errors and transaction result XDR
 * to deliver human-readable error messages to developers.
 */

import { xdr } from '@stellar/stellar-sdk';

/**
 * Maps contract error codes to human-readable descriptions
 * Based on contract error enums in payment-stream and distributor contracts
 */
export const CONTRACT_ERRORS: Record<number, string> = {
  // Payment Stream Contract Errors
  1: "AlreadyInitialized - Contract has already been initialized",
  2: "NotInitialized - Contract has not been initialized",
  3: "Unauthorized - Caller does not have permission to perform this action",
  4: "InvalidAmount - Amount must be positive and within valid range",
  5: "InvalidTimeRange - End time must be after start time",
  6: "StreamNotFound - Stream ID does not exist",
  7: "StreamNotActive - Stream is not in active state",
  8: "StreamNotPaused - Stream is not in paused state",
  9: "StreamCannotBeCanceled - Stream cannot be canceled in its current state",
  10: "InsufficientWithdrawable - Insufficient withdrawable amount available",
  11: "TransferFailed - Token transfer operation failed",
  12: "FeeTooHigh - Protocol fee exceeds maximum allowed (5%)",
  13: "InvalidRecipient - Recipient address is invalid",
  14: "DepositExceedsTotal - Deposit amount exceeds stream total capacity",
  15: "ArithmeticOverflow - Numeric operation caused overflow",
  16: "InvalidDelegate - Delegate address is invalid",
};

/**
 * Error codes used by the SDK for identity/ownership and chain-identity guards.
 *
 * These are SDK-level (not contract-level) codes so the web layer can map them to
 * typed errors without relying on string matching. They are stable and safe to
 * branch on in application code.
 */
export const SDK_ERROR_CODES = {
  /** The authenticated caller does not own the resource being accessed. */
  UNAUTHORIZED_OWNER: "UNAUTHORIZED_OWNER",
  /** The authenticated caller's profile is not verified for the requested action. */
  UNVERIFIED_PROFILE: "UNVERIFIED_PROFILE",
  /** The caller attempted to access a resource owned by a different account. */
  CROSS_ACCOUNT_ACCESS: "CROSS_ACCOUNT_ACCESS",
  /** The in-flight flow was started on a different network than the current one. */
  CHAIN_IDENTITY_MISMATCH: "CHAIN_IDENTITY_MISMATCH",
  /** The in-flight flow is stale (network switched or flow superseded) and must be restarted. */
  STALE_TRANSACTION_FLOW: "STALE_TRANSACTION_FLOW",
  /** The user must re-confirm the transaction after a network switch. */
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
} as const;

export type SdkErrorCode = (typeof SDK_ERROR_CODES)[keyof typeof SDK_ERROR_CODES];

/**
 * Represents a parsed Soroban contract error with context
 */
export interface ParsedContractError {
  type:
    | "contract_error"
    | "simulation_error"
    | "transaction_error"
    | "authorization_error"
    | "chain_identity_error"
    | "unknown";
  code?: number;
  message: string;
  details?: string;
  originalError?: unknown;
  operation?: string;
  suggestion?: string;
  /** Stable SDK-level error code, when the error originates from an SDK guard. */
  sdkCode?: SdkErrorCode;
}

/**
 * Extracts error code from Soroban error message
 * Handles various formats: "Error: 7", "code: 7", etc.
 */
function extractErrorCode(errorString: string): number | null {
  // Try various patterns to extract error code
  const patterns = [
    /error[:\s]+(\d+)/i,
    /code[:\s]+(\d+)/i,
    /exit[:\s]+(\d+)/i,
    /Status\s+code[:\s]+(\d+)/i,
    /^(\d+)$/,
  ];

  for (const pattern of patterns) {
    const match = errorString.match(pattern);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

/**
 * Parses transaction result XDR to extract meaningful error information
 */
function parseTransactionResultXdr(resultXdr: string): {
  message: string;
  details?: string;
  suggestion?: string;
} {
  try {
    const result = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
    
    if (result.result().switch() === xdr.TransactionResultCode.txFailed()) {
      const operations = result.result().results();
      if (operations && operations.length > 0) {
        const firstOp = operations[0];
        
        // Check for contract-specific errors
        if (firstOp.tr().switch() === xdr.OperationType.invokeHostFunction()) {
          const invokeResult = firstOp.tr().value() as xdr.InvokeHostFunctionResult;
          if (
            invokeResult.switch() ===
            xdr.InvokeHostFunctionResultCode.invokeHostFunctionSuccess()
          ) {
            const val = xdr.ScVal.fromXDR(invokeResult.success());
            if (val.switch() === xdr.ScValType.scvError()) {
              const errorVal = val.error();
              if (errorVal.switch() === xdr.ScErrorType.sceContract()) {
                const contractCode = errorVal.contractCode();
                if (contractCode in CONTRACT_ERRORS) {
                  return {
                    message: CONTRACT_ERRORS[contractCode],
                    details: `Contract error code: ${contractCode}`,
                    suggestion: getSuggestionForErrorCode(contractCode),
                  };
                }
              }
            }
          }
        }
        
        // Check for other operation-specific errors
        switch (firstOp.switch()) {
          case xdr.OperationResultCode.opBadAuth():
            return {
              message: "Authentication failed - invalid signature or insufficient permissions",
              suggestion: "Check that you're using the correct account and have signed the transaction properly",
            };
          case xdr.OperationResultCode.opNoAccount():
            return {
              message: "Account does not exist",
              suggestion: "Ensure the account has been created and funded on the network",
            };
          case xdr.OperationResultCode.opNotSupported():
            return {
              message: "Operation not supported",
              suggestion: "This operation may not be available on the current network or protocol version",
            };
        }
      }
    }
    
    // If we can't parse specific details, return generic info
    return {
      message: "Transaction execution failed",
      details: `Result XDR: ${resultXdr.substring(0, 100)}...`,
      suggestion: "Check the transaction parameters and network conditions",
    };
  } catch (error) {
    return {
      message: "Failed to parse transaction result",
      details: `XDR parsing error for ${resultXdr.slice(0, 100)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      suggestion: "The transaction result may be corrupted or in an unexpected format",
    };
  }
}

/**
 * Provides user-friendly suggestions based on error codes
 */
function getSuggestionForErrorCode(code: number): string {
  const suggestions: Record<number, string> = {
    1: "The contract is already initialized. You can use it directly without re-initializing.",
    2: "The contract has not been initialized. Call the initialize() method first.",
    3: "Check that you're using the correct account with proper permissions for this operation.",
    4: "Ensure the amount is positive and within valid range for this operation.",
    5: "Verify that the end time is after the start time for the stream.",
    6: "Check that the stream ID is correct and the stream exists.",
    7: "Only active streams can be modified. Check the stream status first.",
    8: "Only paused streams can be resumed. Check the stream status first.",
    9: "Streams can only be canceled when they are active or paused.",
    10: "Wait for more funds to accumulate in the stream or check the calculation.",
    11: "Ensure you have sufficient token balance and the token contract is working properly.",
    12: "The fee exceeds the maximum allowed. Try with a lower fee or check contract settings.",
    13: "Verify the recipient address is a valid Stellar address.",
    14: "The deposit amount exceeds the total stream capacity. Check the stream parameters.",
    15: "The calculation caused an overflow. Try with smaller numbers.",
    16: "Verify the delegate address is a valid Stellar address.",
  };
  
  return suggestions[code] || "Review the operation parameters and try again.";
}

/**
 * Parses Soroban simulation errors to extract meaningful information
 */
function parseSimulationError(errorMessage: string): {
  message: string;
  details?: string;
  suggestion?: string;
} {
  // Common simulation error patterns
  if (errorMessage.includes("insufficient fee")) {
    return {
      message: "Insufficient transaction fee",
      details: errorMessage,
      suggestion: "Increase the transaction fee and try again",
    };
  }
  
  if (errorMessage.includes("insufficient balance")) {
    return {
      message: "Insufficient account balance",
      details: errorMessage,
      suggestion: "Ensure the account has enough XLM to cover fees and operations",
    };
  }
  
  if (errorMessage.includes("contract error")) {
    const errorCode = extractErrorCode(errorMessage);
    if (errorCode !== null && errorCode in CONTRACT_ERRORS) {
      return {
        message: CONTRACT_ERRORS[errorCode],
        details: errorMessage,
        suggestion: getSuggestionForErrorCode(errorCode),
      };
    }
  }
  
  if (errorMessage.includes("XDR")) {
    return {
      message: "Transaction simulation XDR encoding/decoding error",
      details: errorMessage,
      suggestion: "Check transaction format and parameters",
    };
  }
  
  if (errorMessage.includes("timeout")) {
    return {
      message: "Simulation timeout",
      details: errorMessage,
      suggestion: "The operation may be too complex. Try simplifying or increase timeout",
    };
  }
  
  return {
    message: "Transaction simulation failed",
    details: errorMessage,
    suggestion: "Check the transaction parameters and network conditions",
  };
}

/**
 * Parses Soroban contract errors from various error formats
 * Handles simulation errors, transaction result errors, and generic errors
 */
export function parseContractError(error: unknown, operationContext?: string): ParsedContractError {
  // Handle null/undefined
  if (!error) {
    return {
      type: "unknown",
      message: "An unknown error occurred",
    };
  }

  // Handle Error objects
  if (error instanceof Error) {
    const errorMessage = error.message || "";
    const errorCode = extractErrorCode(errorMessage);

    if (errorCode !== null && errorCode in CONTRACT_ERRORS) {
      return {
        type: "contract_error",
        code: errorCode,
        message: CONTRACT_ERRORS[errorCode],
        details: errorMessage,
        suggestion: getSuggestionForErrorCode(errorCode),
        operation: operationContext,
        originalError: error,
      };
    }

    // Check for simulation error patterns
    if (
      errorMessage.includes("simulation") ||
      errorMessage.includes("XDR") ||
      errorMessage.includes("insufficient fee") ||
      errorMessage.includes("insufficient balance")
    ) {
      const parsed = parseSimulationError(errorMessage);
      return {
        type: "simulation_error",
        message: parsed.message,
        details: parsed.details,
        suggestion: parsed.suggestion,
        operation: operationContext,
        originalError: error,
      };
    }

    // Check for transaction error patterns
    if (
      errorMessage.includes("transaction") ||
      errorMessage.includes("failed")
    ) {
      return {
        type: "transaction_error",
        message: "Transaction execution failed",
        details: errorMessage,
        suggestion: "Check the transaction parameters and network conditions",
        operation: operationContext,
        originalError: error,
      };
    }

    return {
      type: "unknown",
      message: errorMessage || "An error occurred",
      operation: operationContext,
      originalError: error,
    };
  }

  // Handle string errors
  if (typeof error === "string") {
    const errorCode = extractErrorCode(error);

    if (errorCode !== null && errorCode in CONTRACT_ERRORS) {
      return {
        type: "contract_error",
        code: errorCode,
        message: CONTRACT_ERRORS[errorCode],
        suggestion: getSuggestionForErrorCode(errorCode),
        operation: operationContext,
        originalError: error,
      };
    }

    return {
      type: "unknown",
      message: error,
      operation: operationContext,
      originalError: error,
    };
  }

  // Handle objects with error properties (response objects from SDK)
  if (typeof error === "object") {
    const errorObj = error as Record<string, unknown>;

    // Check for Soroban RPC error response
    if (errorObj.code !== undefined) {
      const errorCode = extractErrorCode(String(errorObj.code));
      if (errorCode !== null && errorCode in CONTRACT_ERRORS) {
        return {
          type: "contract_error",
          code: errorCode,
          message: CONTRACT_ERRORS[errorCode],
          details: String(errorObj.message || ""),
          suggestion: getSuggestionForErrorCode(errorCode),
          operation: operationContext,
          originalError: error,
        };
      }
    }

    // Check for transaction error response
    if (errorObj.resultXdr !== undefined) {
      const parsed = parseTransactionResultXdr(String(errorObj.resultXdr));
      return {
        type: "transaction_error",
        message: parsed.message,
        details: parsed.details,
        suggestion: parsed.suggestion,
        operation: operationContext,
        originalError: error,
      };
    }

    // Fallback to checking message property
    if (errorObj.message !== undefined) {
      const message = String(errorObj.message);
      const errorCode = extractErrorCode(message);

      if (errorCode !== null && errorCode in CONTRACT_ERRORS) {
        return {
          type: "contract_error",
          code: errorCode,
          message: CONTRACT_ERRORS[errorCode],
          details: message,
          suggestion: getSuggestionForErrorCode(errorCode),
          operation: operationContext,
          originalError: error,
        };
      }

      return {
        type: "unknown",
        message: message,
        operation: operationContext,
        originalError: error,
      };
    }

    return {
      type: "unknown",
      message: "An unknown error occurred",
      operation: operationContext,
      originalError: error,
    };
  }

  return {
    type: "unknown",
    message: "An unexpected error occurred",
    operation: operationContext,
    originalError: error,
  };
}

/**
 * Custom error class for SDK operations
 * Provides structured error information to calling code
 */
export class FundableStellarError extends Error {
  public readonly code?: number;
  public readonly type: ParsedContractError["type"];
  public readonly details?: string;
  public readonly suggestion?: string;
  public readonly operation?: string;
  public readonly sdkCode?: SdkErrorCode;

  constructor(parsed: ParsedContractError) {
    super(parsed.message);
    this.name = "FundableStellarError";
    this.code = parsed.code;
    this.type = parsed.type;
    this.details = parsed.details;
    this.suggestion = parsed.suggestion;
    this.operation = parsed.operation;
    this.sdkCode = parsed.sdkCode;

    // Set prototype for instanceof checks
    Object.setPrototypeOf(this, FundableStellarError.prototype);
  }

  /**
   * Returns a formatted error message suitable for logging or display
   */
  toString(): string {
    let result = `${this.name}: ${this.message}`;
    if (this.sdkCode !== undefined) {
      result += ` [SDK Code: ${this.sdkCode}]`;
    }
    if (this.code !== undefined) {
      result += ` [Code: ${this.code}]`;
    }
    if (this.operation) {
      result += ` [Operation: ${this.operation}]`;
    }
    if (this.details) {
      result += `\nDetails: ${this.details}`;
    }
    if (this.suggestion) {
      result += `\nSuggestion: ${this.suggestion}`;
    }
    return result;
  }

  /**
   * Returns a user-friendly message without technical details
   */
  getUserMessage(): string {
    return this.message;
  }

  /**
   * Returns a user-friendly message with suggestion
   */
  getUserMessageWithSuggestion(): string {
    let result = this.message;
    if (this.suggestion) {
      result += `\n\n💡 ${this.suggestion}`;
    }
    return result;
  }
}

/**
 * Error raised when the authenticated caller does not own the resource.
 * Maps to {@link SDK_ERROR_CODES.UNAUTHORIZED_OWNER}.
 */
export class UnauthorizedOwnerError extends FundableStellarError {
  constructor(operation?: string, details?: string) {
    super({
      type: "authorization_error",
      sdkCode: SDK_ERROR_CODES.UNAUTHORIZED_OWNER,
      message: "You are not authorized to access this resource",
      details,
      suggestion: "Ensure you are signed in as the account that owns this resource.",
      operation,
    });
    this.name = "UnauthorizedOwnerError";
    Object.setPrototypeOf(this, UnauthorizedOwnerError.prototype);
  }
}

/**
 * Error raised when the caller's profile is not verified for the requested action.
 * Maps to {@link SDK_ERROR_CODES.UNVERIFIED_PROFILE}.
 */
export class UnverifiedProfileError extends FundableStellarError {
  constructor(operation?: string, details?: string) {
    super({
      type: "authorization_error",
      sdkCode: SDK_ERROR_CODES.UNVERIFIED_PROFILE,
      message: "Your profile must be verified before performing this action",
      details,
      suggestion: "Complete identity verification in your profile settings and try again.",
      operation,
    });
    this.name = "UnverifiedProfileError";
    Object.setPrototypeOf(this, UnverifiedProfileError.prototype);
  }
}

/**
 * Error raised when a caller attempts to access a resource owned by another account.
 * Maps to {@link SDK_ERROR_CODES.CROSS_ACCOUNT_ACCESS}.
 */
export class CrossAccountAccessError extends FundableStellarError {
  constructor(operation?: string, details?: string) {
    super({
      type: "authorization_error",
      sdkCode: SDK_ERROR_CODES.CROSS_ACCOUNT_ACCESS,
      message: "This resource belongs to a different account",
      details,
      suggestion: "Sign in with the account that owns this resource.",
      operation,
    });
    this.name = "CrossAccountAccessError";
    Object.setPrototypeOf(this, CrossAccountAccessError.prototype);
  }
}

/**
 * Error raised when an in-flight transaction flow was started on a different
 * network than the one currently selected. The flow must be aborted and restarted.
 * Maps to {@link SDK_ERROR_CODES.CHAIN_IDENTITY_MISMATCH}.
 */
export class ChainIdentityMismatchError extends FundableStellarError {
  public readonly expectedNetwork?: string;
  public readonly actualNetwork?: string;

  constructor(
    expectedNetwork?: string,
    actualNetwork?: string,
    operation?: string,
  ) {
    super({
      type: "chain_identity_error",
      sdkCode: SDK_ERROR_CODES.CHAIN_IDENTITY_MISMATCH,
      message: "The network changed while this transaction was in progress",
      details:
        expectedNetwork !== undefined || actualNetwork !== undefined
          ? `Expected network: ${expectedNetwork ?? "unknown"}, current network: ${
              actualNetwork ?? "unknown"
            }`
          : undefined,
      suggestion:
        "The transaction was aborted because the network changed. Restart the flow on the current network.",
      operation,
    });
    this.name = "ChainIdentityMismatchError";
    this.expectedNetwork = expectedNetwork;
    this.actualNetwork = actualNetwork;
    Object.setPrototypeOf(this, ChainIdentityMismatchError.prototype);
  }
}

/**
 * Error raised when an in-flight transaction flow is stale (superseded or
 * invalidated by a network switch) and can no longer be safely completed.
 * Maps to {@link SDK_ERROR_CODES.STALE_TRANSACTION_FLOW}.
 */
export class StaleTransactionFlowError extends FundableStellarError {
  constructor(operation?: string, details?: string) {
    super({
      type: "chain_identity_error",
      sdkCode: SDK_ERROR_CODES.STALE_TRANSACTION_FLOW,
      message: "This transaction flow is no longer valid",
      details,
      suggestion: "Start a new transaction to continue.",
      operation,
    });
    this.name = "StaleTransactionFlowError";
    Object.setPrototypeOf(this, StaleTransactionFlowError.prototype);
  }
}

/**
 * Error raised when the user must re-confirm a transaction after a network
 * switch before it can be signed or submitted.
 * Maps to {@link SDK_ERROR_CODES.CONFIRMATION_REQUIRED}.
 */
export class ConfirmationRequiredError extends FundableStellarError {
  constructor(operation?: string, details?: string) {
    super({
      type: "chain_identity_error",
      sdkCode: SDK_ERROR_CODES.CONFIRMATION_REQUIRED,
      message: "Please re-confirm this transaction on the current network",
      details,
      suggestion:
        "The network changed. Review and confirm the transaction again before continuing.",
      operation,
    });
    this.name = "ConfirmationRequiredError";
    Object.setPrototypeOf(this, ConfirmationRequiredError.prototype);
  }
}

/**
 * Wrapper function to safely execute contract operations and handle errors
 * @param operation Async function that executes a contract operation
 * @param operationName Name of the operation for error context
 * @returns Result of the operation or throws FundableStellarError
 */
export async function executeWithErrorHandling<T>(
  operation: () => Promise<T>,
  operationName: string = "Contract operation",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const parsed = parseContractError(error, operationName);
    const fundableError = new FundableStellarError(parsed);
    throw fundableError;
  }
}
