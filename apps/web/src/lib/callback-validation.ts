/**
 * Callback Validation Utility — Origin, State, Expiry, and Network Validation
 *
 * Implements comprehensive security validation for offramp provider callbacks:
 * 1. Origin Validation: HMAC signature verification to ensure callback authenticity
 * 2. State Validation: Validates state transitions against allowed state machine
 * 3. Expiry Validation: Rejects callbacks older than maximum allowed age
 * 4. Network Validation: Ensures callback is for the correct Stellar network
 *
 * Prevents replay attacks, cross-network attacks, and unauthorized callbacks.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { PayoutStatus, ProviderCallbackPayload } from "@/types/offramp";

/**
 * Configuration for callback validation
 */
export const CALLBACK_VALIDATION_CONFIG = {
  /** Maximum age of callback in milliseconds (5 minutes) */
  MAX_CALLBACK_AGE_MS: 5 * 60 * 1000,
  
  /** Tolerance for clock skew in milliseconds (30 seconds) */
  CLOCK_SKEW_TOLERANCE_MS: 30 * 1000,
  
  /** Expected network passphrase (from environment) */
  NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
  
  /** Webhook signing secret environment variable key */
  WEBHOOK_SECRET_ENV_KEY: "OFFRAMP_WEBHOOK_SECRET",
} as const;

/**
 * Allowed state transitions in the settlement state machine
 */
const ALLOWED_STATE_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  pending: ["processing", "confirmed", "expired", "failed"],
  confirmed: ["processing", "completed", "failed", "delayed"],
  processing: ["completed", "failed", "delayed", "timeout"],
  delayed: ["completed", "failed", "timeout"],
  timeout: ["completed", "failed"],
  completed: [], // Terminal state
  failed: [], // Terminal state
  expired: [], // Terminal state
};

/**
 * Validation error types
 */
export class CallbackValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 400
  ) {
    super(message);
    this.name = "CallbackValidationError";
  }
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: {
    code: string;
    message: string;
    httpStatus: number;
  };
}

/**
 * Extended callback payload with network information
 */
export interface CallbackWithNetwork extends ProviderCallbackPayload {
  networkPassphrase?: string;
  network?: string;
}

/**
 * Validates HMAC signature for callback authenticity (Origin Validation)
 */
export function validateCallbackSignature(
  payload: ProviderCallbackPayload,
  signature: string | undefined,
  secret?: string
): ValidationResult {
  // If no signature provided, check if validation is required
  if (!signature) {
    // In production, signature MUST be present
    if (process.env.NODE_ENV === "production") {
      return {
        valid: false,
        error: {
          code: "MISSING_SIGNATURE",
          message: "Callback signature is required",
          httpStatus: 401,
        },
      };
    }
    // In non-production, allow unsigned callbacks for testing
    return { valid: true };
  }

  // Get webhook secret from environment or parameter
  const webhookSecret = secret || process.env[CALLBACK_VALIDATION_CONFIG.WEBHOOK_SECRET_ENV_KEY];
  
  if (!webhookSecret) {
    throw new Error("Webhook secret not configured");
  }

  try {
    // Create canonical payload string for signature verification
    const canonicalPayload = JSON.stringify({
      callbackId: payload.callbackId,
      transactionReference: payload.transactionReference,
      providerId: payload.providerId,
      status: payload.status,
      timestamp: payload.timestamp,
    });

    // Compute expected signature
    const expectedSignature = createHmac("sha256", webhookSecret)
      .update(canonicalPayload)
      .digest("hex");

    // Timing-safe comparison to prevent timing attacks
    const signatureBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");

    if (signatureBuffer.length !== expectedBuffer.length) {
      return {
        valid: false,
        error: {
          code: "INVALID_SIGNATURE",
          message: "Callback signature verification failed",
          httpStatus: 401,
        },
      };
    }

    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return {
        valid: false,
        error: {
          code: "INVALID_SIGNATURE",
          message: "Callback signature verification failed",
          httpStatus: 401,
        },
      };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: {
        code: "SIGNATURE_VERIFICATION_ERROR",
        message: "Failed to verify callback signature",
        httpStatus: 500,
      },
    };
  }
}

/**
 * Validates callback timestamp to prevent replay attacks (Expiry Validation)
 */
export function validateCallbackTimestamp(
  timestamp: string | undefined,
  now: number = Date.now()
): ValidationResult {
  if (!timestamp) {
    return {
      valid: false,
      error: {
        code: "MISSING_TIMESTAMP",
        message: "Callback timestamp is required",
        httpStatus: 400,
      },
    };
  }

  let callbackTime: number;
  try {
    callbackTime = new Date(timestamp).getTime();
    if (isNaN(callbackTime)) {
      throw new Error("Invalid timestamp format");
    }
  } catch {
    return {
      valid: false,
      error: {
        code: "INVALID_TIMESTAMP",
        message: "Callback timestamp is not a valid ISO 8601 date",
        httpStatus: 400,
      },
    };
  }

  const age = now - callbackTime;
  const maxAge = CALLBACK_VALIDATION_CONFIG.MAX_CALLBACK_AGE_MS;
  const tolerance = CALLBACK_VALIDATION_CONFIG.CLOCK_SKEW_TOLERANCE_MS;

  // Check if callback is too old (replay attack)
  if (age > maxAge) {
    return {
      valid: false,
      error: {
        code: "CALLBACK_EXPIRED",
        message: `Callback timestamp is too old (age: ${Math.floor(age / 1000)}s, max: ${Math.floor(maxAge / 1000)}s)`,
        httpStatus: 400,
      },
    };
  }

  // Check if callback is from the future (accounting for clock skew)
  if (age < -tolerance) {
    return {
      valid: false,
      error: {
        code: "CALLBACK_FROM_FUTURE",
        message: "Callback timestamp is in the future beyond acceptable clock skew",
        httpStatus: 400,
      },
    };
  }

  return { valid: true };
}

/**
 * Validates state transition is allowed (State Validation)
 */
export function validateStateTransition(
  currentStatus: PayoutStatus,
  newStatus: PayoutStatus
): ValidationResult {
  // If current status is terminal, no transitions are allowed
  if (currentStatus === "completed" || currentStatus === "failed" || currentStatus === "expired") {
    // However, allow duplicate callbacks of the same terminal state
    if (currentStatus === newStatus) {
      return { valid: true };
    }
    
    return {
      valid: false,
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot transition from terminal state '${currentStatus}' to '${newStatus}'`,
        httpStatus: 409,
      },
    };
  }

  const allowedTransitions = ALLOWED_STATE_TRANSITIONS[currentStatus] || [];
  
  // Allow same-state transitions (idempotent)
  if (currentStatus === newStatus) {
    return { valid: true };
  }

  if (!allowedTransitions.includes(newStatus)) {
    return {
      valid: false,
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: `Invalid state transition from '${currentStatus}' to '${newStatus}'`,
        httpStatus: 409,
      },
    };
  }

  return { valid: true };
}

/**
 * Validates callback is for the correct network (Network Validation)
 */
export function validateCallbackNetwork(
  payload: CallbackWithNetwork,
  expectedNetwork?: string
): ValidationResult {
  const expected = expectedNetwork || CALLBACK_VALIDATION_CONFIG.NETWORK_PASSPHRASE;
  
  // Check if callback includes network information
  if (!payload.networkPassphrase && !payload.network) {
    // If network not specified in callback, we cannot validate
    // In production, this should be required
    if (process.env.NODE_ENV === "production") {
      return {
        valid: false,
        error: {
          code: "MISSING_NETWORK",
          message: "Callback must include network information",
          httpStatus: 400,
        },
      };
    }
    return { valid: true };
  }

  // Validate network passphrase if provided
  if (payload.networkPassphrase && payload.networkPassphrase !== expected) {
    return {
      valid: false,
      error: {
        code: "NETWORK_MISMATCH",
        message: `Callback network '${payload.networkPassphrase}' does not match expected network '${expected}'`,
        httpStatus: 400,
      },
    };
  }

  // Validate network name if provided (testnet/mainnet)
  if (payload.network) {
    const expectedNetworkName = process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet";
    if (payload.network !== expectedNetworkName) {
      return {
        valid: false,
        error: {
          code: "NETWORK_MISMATCH",
          message: `Callback network '${payload.network}' does not match expected network '${expectedNetworkName}'`,
          httpStatus: 400,
        },
      };
    }
  }

  return { valid: true };
}

/**
 * Comprehensive callback validation combining all checks
 */
export function validateCallback(
  payload: CallbackWithNetwork,
  currentStatus?: PayoutStatus,
  options?: {
    skipSignature?: boolean;
    skipTimestamp?: boolean;
    skipNetwork?: boolean;
    webhookSecret?: string;
    now?: number;
  }
): ValidationResult {
  // 1. Validate origin (signature)
  if (!options?.skipSignature) {
    const signatureResult = validateCallbackSignature(
      payload,
      payload.signature,
      options?.webhookSecret
    );
    if (!signatureResult.valid) {
      return signatureResult;
    }
  }

  // 2. Validate expiry (timestamp)
  if (!options?.skipTimestamp) {
    const timestampResult = validateCallbackTimestamp(payload.timestamp, options?.now);
    if (!timestampResult.valid) {
      return timestampResult;
    }
  }

  // 3. Validate network
  if (!options?.skipNetwork) {
    const networkResult = validateCallbackNetwork(payload);
    if (!networkResult.valid) {
      return networkResult;
    }
  }

  // 4. Validate state transition (if current status provided)
  if (currentStatus) {
    const stateResult = validateStateTransition(currentStatus, payload.status);
    if (!stateResult.valid) {
      return stateResult;
    }
  }

  return { valid: true };
}

/**
 * Generates HMAC signature for a callback payload (for testing/provider integration)
 */
export function generateCallbackSignature(
  payload: Pick<ProviderCallbackPayload, "callbackId" | "transactionReference" | "providerId" | "status" | "timestamp">,
  secret: string
): string {
  const canonicalPayload = JSON.stringify({
    callbackId: payload.callbackId,
    transactionReference: payload.transactionReference,
    providerId: payload.providerId,
    status: payload.status,
    timestamp: payload.timestamp,
  });

  return createHmac("sha256", secret)
    .update(canonicalPayload)
    .digest("hex");
}
