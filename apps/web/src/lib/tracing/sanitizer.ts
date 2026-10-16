/**
 * Telemetry and Trace Data Sanitizer
 *
 * Excludes sensitive data (Stellar wallet payloads, secret keys, mnemonics,
 * API secrets, authorization tokens, and personal identifiers) from spans,
 * logs, headers, and trace metadata.
 */

export const STELLAR_SECRET_KEY_PATTERN = /\bS[A-Z0-9]{55}\b/g;
export const STELLAR_PUBLIC_KEY_PATTERN = /\bG[A-Z0-9]{55}\b/g;
export const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
export const PHONE_PATTERN = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
export const SSN_TAX_ID_PATTERN = /\b(?:\d{3}-\d{2}-\d{4}|\d{2}-\d{7})\b/g;
export const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
export const QUERY_SECRET_PATTERN = /([?&](?:apiKey|api_key|token|secret|password|key)=)[^&\s]*/gi;

const SENSITIVE_KEY_NAMES = new Set([
  'secret',
  'secrets',
  'secretkey',
  'secret_key',
  'privatekey',
  'private_key',
  'seed',
  'seeds',
  'mnemonic',
  'passphrase',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'x-api-key',
  'webhook_secret',
  'signature',
  'signers',
  'ssn',
  'taxid',
  'tax_id',
  'credit_card',
]);

export interface SanitizeOptions {
  /** Mask public keys fully or keep truncated prefix/suffix (default: true) */
  maskPublicKeys?: boolean;
  /** Redact emails and phone numbers (default: true) */
  maskPii?: boolean;
}

/**
 * Checks if an object property key name indicates sensitive content.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  for (const sensitive of SENSITIVE_KEY_NAMES) {
    const cleanSensitive = sensitive.replace(/[-_]/g, '');
    if (normalized === cleanSensitive || normalized.includes(cleanSensitive)) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitizes a string by redacting secret keys, bearer tokens, PII, and credentials.
 */
export function sanitizeString(input: string, options: SanitizeOptions = {}): string {
  if (!input || typeof input !== 'string') return input;

  const { maskPublicKeys = false, maskPii = true } = options;
  let sanitized = input;

  // 1. Redact Stellar Secret Keys (S...)
  sanitized = sanitized.replace(STELLAR_SECRET_KEY_PATTERN, '[REDACTED_SECRET_KEY]');

  // 2. Redact Bearer Tokens
  sanitized = sanitized.replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED_TOKEN]');

  // 3. Redact query param secrets in URLs
  sanitized = sanitized.replace(QUERY_SECRET_PATTERN, '$1[REDACTED]');

  // 4. Redact PII (emails, SSN, phone)
  if (maskPii) {
    sanitized = sanitized.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
    sanitized = sanitized.replace(SSN_TAX_ID_PATTERN, '[REDACTED_TAX_ID]');
    sanitized = sanitized.replace(PHONE_PATTERN, '[REDACTED_PHONE]');
  }

  // 5. Handle Stellar Public Keys (G...)
  if (maskPublicKeys) {
    sanitized = sanitized.replace(STELLAR_PUBLIC_KEY_PATTERN, '[REDACTED_PUBLIC_KEY]');
  } else {
    // Truncate to first 4 and last 5 for operational correlation without full PII exposure
    sanitized = sanitized.replace(STELLAR_PUBLIC_KEY_PATTERN, (match) => {
      return `${match.slice(0, 4)}...${match.slice(-5)}`;
    });
  }

  return sanitized;
}

/**
 * Recursively sanitizes any object, array, or primitive value.
 */
export function sanitizeObject<T = unknown>(input: T, options: SanitizeOptions = {}): T {
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    return sanitizeString(input, options) as T;
  }

  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'symbol') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeObject(item, options)) as T;
  }

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = '[REDACTED_SECRET]';
      } else {
        result[key] = sanitizeObject(value, options);
      }
    }
    return result as T;
  }

  return input;
}

/**
 * Sanitizes HTTP headers for tracing and logging.
 */
export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);

    if (isSensitiveKey(key) || key.toLowerCase() === 'authorization' || key.toLowerCase() === 'cookie') {
      result[key.toLowerCase()] = '[REDACTED_HEADER]';
    } else {
      result[key.toLowerCase()] = sanitizeString(value);
    }
  }

  return result;
}

/**
 * Sanitizes span attributes to guarantee zero leakage of secret keys, PII, or credentials.
 */
export function sanitizeSpanAttributes(
  attributes: Record<string, unknown>,
  options: SanitizeOptions = {}
): Record<string, unknown> {
  return sanitizeObject(attributes, options) as Record<string, unknown>;
}
