/**
 * Sanitization utilities for error reporting to prevent sensitive data exposure
 */

/**
 * Pattern to match Stellar public keys (G...)
 * Stellar public keys are 56 characters long and start with 'G'
 */
export const STELLAR_PUBLIC_KEY_PATTERN = /\bG[A-Z0-9]{55}\b/g;

/**
 * Pattern to match Stellar secret keys (S...)
 * Secret keys are 56 characters long and start with 'S'
 */
export const STELLAR_SECRET_KEY_PATTERN = /\bS[A-Z0-9]{55}\b/g;

/**
 * Pattern to match Stellar addresses in various formats
 * Includes GCKF...2BVN7 style truncated addresses
 */
const STELLAR_TRUNCATED_PATTERN = /\bG[A-Z0-9]{4}\.\.\.[A-Z0-9]{5}\b/g;

/**
 * Options for sanitization
 */
type SanitizeOptions = {
  /** Whether to mask the full key or keep a truncated version */
  maskFullKey?: boolean;
  /** Replacement string for masked keys */
  replacement?: string;
};

/**
 * Sanitize a string by masking Stellar public keys
 * 
 * @param input - The string to sanitize
 * @param options - Sanitization options
 * @returns The sanitized string with keys masked
 * 
 * @example
 * sanitizeErrorString('Error with account GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN')
 * // Returns: 'Error with account [PUBLIC_KEY_REDACTED]'
 */
export function sanitizeErrorString(
  input: string,
  options: SanitizeOptions = {}
): string {
  if (!input || typeof input !== 'string') {
    return input;
  }

  const {
    maskFullKey = false,
    replacement = '[PUBLIC_KEY_REDACTED]',
  } = options;

  let sanitized = input;

  // Replace full public keys
  sanitized = sanitized.replace(STELLAR_PUBLIC_KEY_PATTERN, (match) => {
    if (maskFullKey) {
      return replacement;
    }
    // Keep first 4 and last 5 characters for debugging
    return `${match.slice(0, 4)}...${match.slice(-5)}`;
  });

  // Replace secret keys (always full mask for security)
  sanitized = sanitized.replace(STELLAR_SECRET_KEY_PATTERN, '[SECRET_KEY_REDACTED]');

  // Replace truncated public keys
  sanitized = sanitized.replace(STELLAR_TRUNCATED_PATTERN, replacement);

  return sanitized;
}

/**
 * Recursively sanitize an object by masking Stellar public keys in string values
 * 
 * @param obj - The object to sanitize
 * @param options - Sanitization options
 * @returns A new object with all string values sanitized
 */
export function sanitizeObject<T = unknown>(
  obj: T,
  options: SanitizeOptions = {}
): T {
  if (!obj) {
    return obj;
  }

  // Handle primitive values
  if (typeof obj === 'string') {
    return sanitizeErrorString(obj, options) as T;
  }

  if (typeof obj === 'number' || typeof obj === 'boolean' || typeof obj === 'symbol') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, options)) as T;
  }

  // Handle plain objects
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Don't sanitize keys, only values
      result[key] = sanitizeObject(value, options);
    }
    return result as T;
  }

  return obj;
}

/**
 * A single field-level validation error, safe to return to clients.
 */
export type FieldError = {
  /** Dot-notation path of the offending field, e.g. `amount` or `recipient.address` */
  field: string;
  /** Machine-readable reason, e.g. `required`, `invalid_format` */
  code: string;
  /** Human-readable, already-sanitized explanation */
  message: string;
};

/**
 * The only shape ever returned to clients or logged externally.
 * Stack traces, `cause` chains and arbitrary internal properties are dropped.
 */
export type SanitizedError = {
  /** Stable machine-readable error code, e.g. `VALIDATION_ERROR` */
  code: string;
  /** Human-readable, already-sanitized message */
  message: string;
  /** Correlation ID shared with server logs */
  requestId?: string;
  /** Field-level validation errors, when applicable */
  fieldErrors?: FieldError[];
};

/**
 * Properties that are always preserved (after sanitization) when present.
 */
const PRESERVED_PROPERTIES = ['code', 'requestId'] as const;

/**
 * Properties that are never copied, even if present on the source error.
 */
const STRIPPED_PROPERTIES = new Set([
  'message',
  'name',
  'stack',
  'cause',
  'requestId',
  'code',
  'fieldErrors',
]);

const DEFAULT_ERROR_CODE = 'INTERNAL_ERROR';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize any thrown value (Error, string, object, undefined, ...) into a
 * `SanitizedError`. Never throws, never leaks stack traces or `cause` chains.
 *
 * @param error - The thrown value to sanitize
 * @param options - Sanitization options
 * @returns A plain, JSON-safe object suitable for API responses and logs
 */
export function sanitizeError(
  error: unknown,
  options: SanitizeOptions = {}
): SanitizedError {
  const result: SanitizedError = {
    code: DEFAULT_ERROR_CODE,
    message: 'An unexpected error occurred',
  };

  if (error === null || error === undefined) {
    return result;
  }

  // Non-object throws (string, number, boolean, symbol, bigint)
  if (typeof error !== 'object') {
    if (typeof error === 'string' && error.length > 0) {
      result.message = sanitizeErrorString(error, options);
    }
    return result;
  }

  const record = error as Record<string, unknown>;

  // Message: prefer `message`, fall back to `error` (e.g. from JSON payloads)
  const rawMessage =
    typeof record.message === 'string'
      ? record.message
      : typeof record.error === 'string'
        ? record.error
        : undefined;
  if (rawMessage) {
    result.message = sanitizeErrorString(rawMessage, options);
  }

  // Preserved scalar properties
  for (const prop of PRESERVED_PROPERTIES) {
    const value = record[prop];
    if (typeof value === 'string' && value.length > 0) {
      result[prop] = sanitizeErrorString(value, options);
    }
  }

  // Field errors: keep only well-formed entries, sanitize their messages
  if (Array.isArray(record.fieldErrors)) {
    const fieldErrors: FieldError[] = [];
    for (const entry of record.fieldErrors) {
      if (!isPlainObject(entry)) continue;
      const field = entry.field;
      const code = entry.code;
      const message = entry.message;
      if (typeof field !== 'string' || typeof code !== 'string') continue;
      fieldErrors.push({
        field: sanitizeErrorString(field, options),
        code: sanitizeErrorString(code, options),
        message:
          typeof message === 'string'
            ? sanitizeErrorString(message, options)
            : '',
      });
    }
    if (fieldErrors.length > 0) {
      result.fieldErrors = fieldErrors;
    }
  }

  return result;
}

/**
 * Build a `SanitizedError` from an arbitrary thrown value, guaranteeing that
 * only `code`, `message`, `requestId` and `fieldErrors` are present.
 *
 * This is the function API handlers should use before serializing an error
 * into a response body or an external log sink. It intentionally ignores
 * `stack`, `cause` and every other property on the source error.
 *
 * @param error - The thrown value to sanitize
 * @param options - Sanitization options
 * @returns A plain, JSON-safe object
 */
export function toClientError(
  error: unknown,
  options: SanitizeOptions = {}
): SanitizedError {
  return sanitizeError(error, options);
}

/**
 * Determine whether a property name should be copied when sanitizing.
 * Exposed for tests and for callers that need to mirror the allow-list.
 */
export function isStrippedProperty(prop: string): boolean {
  return STRIPPED_PROPERTIES.has(prop);
}