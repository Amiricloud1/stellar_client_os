/**
 * Sanitization utilities for error reporting and Sentry event scrubbing (#83)
 *
 * Prevents sensitive data exposure in client/server/edge telemetry by scrubbing:
 * - Stellar secret keys, mnemonics, and wallet secrets
 * - Stellar public keys (full redaction or truncated format)
 * - Tax IDs (EIN, SSN/ITIN, VAT IDs, nonprofit registration numbers)
 * - Signed Stellar transactions (Base64 XDR envelopes and signature payloads)
 * - Campaign verification / insurance evidence (IPFS/S3 URLs, presigned URLs, EXIF/GPS coordinates, binary buffers)
 * - Sensitive URL query parameters, HTTP headers, and request/response body fields
 */

/**
 * Pattern to match Stellar public keys (G...)
 * Matches 51–56 character Stellar public keys starting with 'G'
 */
export const STELLAR_PUBLIC_KEY_PATTERN = /\bG[A-Z0-9]{50,55}\b/g;

/**
 * Pattern to match Stellar secret keys (S...)
 * Matches 51–56 character Stellar secret keys starting with 'S'
 */
export const STELLAR_SECRET_KEY_PATTERN = /\bS[A-Z0-9]{50,55}\b/g;

/**
 * Pattern to match truncated Stellar addresses (e.g. GABC...KLMN or GCKF...2BVN7)
 */
export const STELLAR_TRUNCATED_PATTERN = /\bG[A-Z0-9]{3,4}\.\.\.[A-Z0-9]{4,5}\b/g;

/**
 * Patterns to match tax identifiers (US EIN, US SSN/ITIN, EU/UK VAT numbers)
 */
export const TAX_ID_EIN_PATTERN = /\b\d{2}-\d{7}\b/g;
export const TAX_ID_SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
export const TAX_ID_VAT_PATTERN =
  /\b(?:AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|GB|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)U?[0-9A-Z]{8,12}\b/g;

/**
 * Pattern to match Base64-encoded Stellar TransactionEnvelope XDR payloads
 * Stellar transaction envelopes (ENVELOPE_TYPE_TX_V0, ENVELOPE_TYPE_TX, ENVELOPE_TYPE_TX_FEE_BUMP)
 * begin with `AAAAAgAAA`, `AAAAAQAAA`, or `AAAAAwAAA` in Base64.
 */
export const SIGNED_TX_XDR_PATTERN =
  /\bAAAA(?:AgAAA|AQAAA|AwAAA)[A-Za-z0-9+/=]{20,}/g;

/**
 * Pattern to match verification/insurance evidence URIs (IPFS CIDs and evidence storage paths)
 */
export const EVIDENCE_URI_PATTERN =
  /\b(?:ipfs:\/\/[A-Za-z0-9/._-]+|https?:\/\/[^\s"'<>]+\/(?:evidence|verification-evidence|insurance-evidence|claims-evidence)\/[^\s"'<>]*)/gi;

const TAX_ID_FIELD_NAMES = new Set([
  "taxid",
  "tax_id",
  "tin",
  "ein",
  "ssn",
  "itin",
  "vatid",
  "vat_id",
  "vatnumber",
  "vat_number",
  "taxidentifier",
  "tax_identifier",
  "nonprofittaxid",
  "nonprofit_tax_id",
  "partnerregistrationnumber",
  "partner_registration_number",
  "registrationnumber",
  "registration_number",
]);

const WALLET_SECRET_FIELD_NAMES = new Set([
  "secretkey",
  "secret_key",
  "privatekey",
  "private_key",
  "walletsecret",
  "wallet_secret",
  "mnemonic",
  "seedphrase",
  "seed_phrase",
  "recoveryphrase",
  "recovery_phrase",
  "keystore",
  "signersecret",
  "signer_secret",
]);

const SIGNED_TX_FIELD_NAMES = new Set([
  "signedtx",
  "signed_tx",
  "signedtransaction",
  "signed_transaction",
  "signedxdr",
  "signed_xdr",
  "txxdr",
  "tx_xdr",
  "envelopexdr",
  "envelope_xdr",
  "transactionxdr",
  "transaction_xdr",
  "rawtransaction",
  "raw_transaction",
  "txenvelope",
  "tx_envelope",
  "xdr",
  "signatures",
]);

const EVIDENCE_FIELD_NAMES = new Set([
  "evidence",
  "verificationevidence",
  "verification_evidence",
  "insuranceevidence",
  "insurance_evidence",
  "claimevidence",
  "claim_evidence",
  "evidenceurl",
  "evidence_url",
  "evidenceurls",
  "evidence_urls",
  "evidencecid",
  "evidence_cid",
  "ipfscid",
  "ipfs_cid",
  "presignedurl",
  "presigned_url",
  "uploadurl",
  "upload_url",
  "photobuffer",
  "photo_buffer",
  "filebuffer",
  "file_buffer",
  "documentbuffer",
  "document_buffer",
  "exif",
  "gpslocations",
  "gps_locations",
  "gpscoordinates",
  "gps_coordinates",
  "latitude",
  "longitude",
  "coordinates",
]);

const SENSITIVE_BODY_AND_HEADER_FIELD_NAMES = new Set([
  "password",
  "passcode",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "apikey",
  "api_key",
  "x-api-key",
  "adminkey",
  "admin_key",
  "x-admin-key",
  "webhooksecret",
  "webhook_secret",
  "x-webhook-signature",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "bankaccount",
  "bank_account",
  "accountnumber",
  "account_number",
  "routingnumber",
  "routing_number",
  "iban",
  "swift",
  "email",
  "creatoremail",
  "creator_email",
  "recipientemail",
  "recipient_email",
  "phone",
  "phonenumber",
  "phone_number",
]);

const PRESIGNED_URL_QUERY_PARAMS = new Set([
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "awsaccesskeyid",
  "signature",
  "googleaccessid",
]);

/**
 * Options for sanitization
 */
export type SanitizeOptions = {
  /** Whether to mask the full key or keep a truncated version (defaults to true) */
  maskFullKey?: boolean;
  /** Replacement string for masked keys */
  replacement?: string;
};

function normalizeFieldKey(key: string): string {
  return key.trim().toLowerCase();
}

function getFieldRedactionPlaceholder(key: string): string | null {
  const normalized = normalizeFieldKey(key);
  if (TAX_ID_FIELD_NAMES.has(normalized)) return "[TAX_ID_REDACTED]";
  if (WALLET_SECRET_FIELD_NAMES.has(normalized)) return "[SECRET_KEY_REDACTED]";
  if (SIGNED_TX_FIELD_NAMES.has(normalized)) return "[SIGNED_TX_REDACTED]";
  if (EVIDENCE_FIELD_NAMES.has(normalized)) return "[EVIDENCE_REDACTED]";
  if (PRESIGNED_URL_QUERY_PARAMS.has(normalized)) return "[EVIDENCE_REDACTED]";
  if (SENSITIVE_BODY_AND_HEADER_FIELD_NAMES.has(normalized)) return "[REDACTED]";
  return null;
}

/**
 * Sanitize a URL or query string by scrubbing sensitive query parameters and path tokens.
 */
export function sanitizeUrl(input: string, options: SanitizeOptions = {}): string {
  if (!input || typeof input !== "string") return input;

  // Replace query parameter values for known sensitive keys without disturbing URL structure
  const queryReplaced = input.replace(
    /([?&])([A-Za-z0-9_.-]+)=([^&#\s]*)/g,
    (_full, prefix: string, rawKey: string, rawVal: string) => {
      const placeholder = getFieldRedactionPlaceholder(rawKey);
      if (placeholder) {
        return `${prefix}${rawKey}=${placeholder}`;
      }
      let decodedVal = rawVal;
      try {
        decodedVal = decodeURIComponent(rawVal);
      } catch {
        // keep rawVal if malformed percent-encoding
      }
      const scrubbedVal = sanitizeErrorString(decodedVal, options);
      return `${prefix}${rawKey}=${scrubbedVal}`;
    }
  );

  return queryReplaced;
}

/**
 * Sanitize a string by masking Stellar keys, tax IDs, signed transactions,
 * evidence URLs, and sensitive query parameters.
 */
export function sanitizeErrorString(
  input: string,
  options: SanitizeOptions = {}
): string {
  if (!input || typeof input !== "string") {
    return input;
  }

  const {
    maskFullKey = true,
    replacement = "[PUBLIC_KEY_REDACTED]",
  } = options;

  let sanitized = input;

  // 1. Scrub sensitive query parameters in URLs embedded in strings
  if (sanitized.includes("?") || sanitized.includes("&")) {
    sanitized = sanitized.replace(
      /([?&])([A-Za-z0-9_.-]+)=([^&#\s"']*)/g,
      (full, prefix: string, rawKey: string) => {
        const placeholder = getFieldRedactionPlaceholder(rawKey);
        return placeholder ? `${prefix}${rawKey}=${placeholder}` : full;
      }
    );
  }

  // 2. Scrub evidence URIs (IPFS CIDs and evidence bucket paths)
  sanitized = sanitized.replace(EVIDENCE_URI_PATTERN, "[EVIDENCE_REDACTED]");

  // 3. Scrub Base64-encoded signed Stellar XDR transaction envelopes
  sanitized = sanitized.replace(SIGNED_TX_XDR_PATTERN, "[SIGNED_TX_REDACTED]");

  // 4. Scrub Stellar secret keys (always full mask for security)
  sanitized = sanitized.replace(STELLAR_SECRET_KEY_PATTERN, "[SECRET_KEY_REDACTED]");

  // 5. Scrub tax IDs (US EIN, US SSN/ITIN, EU/UK VAT IDs)
  sanitized = sanitized.replace(TAX_ID_EIN_PATTERN, "[TAX_ID_REDACTED]");
  sanitized = sanitized.replace(TAX_ID_SSN_PATTERN, "[TAX_ID_REDACTED]");
  sanitized = sanitized.replace(TAX_ID_VAT_PATTERN, "[TAX_ID_REDACTED]");

  // 6. Replace full Stellar public keys
  sanitized = sanitized.replace(STELLAR_PUBLIC_KEY_PATTERN, (match) => {
    if (maskFullKey) {
      return replacement;
    }
    // Keep first 4 and last 5 characters for debugging
    return `${match.slice(0, 4)}...${match.slice(-5)}`;
  });

  // 7. Replace truncated public keys only when maskFullKey is enabled
  if (maskFullKey) {
    sanitized = sanitized.replace(STELLAR_TRUNCATED_PATTERN, replacement);
  }

  return sanitized;
}

/**
 * Recursively sanitize an object by masking sensitive fields and string values
 */
export function sanitizeObject<T = unknown>(
  obj: T,
  options: SanitizeOptions = {},
  seen: WeakSet<object> = new WeakSet()
): T {
  if (!obj) {
    return obj;
  }

  // Handle primitive values
  if (typeof obj === "string") {
    return sanitizeErrorString(obj, options) as T;
  }

  if (typeof obj === "number" || typeof obj === "boolean" || typeof obj === "symbol") {
    return obj;
  }

  // Preserve Date and RegExp instances
  if (obj instanceof Date || obj instanceof RegExp) {
    return obj;
  }

  // Redact binary buffers / typed arrays that may hold evidence files
  if (
    typeof ArrayBuffer !== "undefined" &&
    (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj))
  ) {
    return "[EVIDENCE_REDACTED]" as unknown as T;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, options, seen)) as T;
  }

  // Handle plain objects
  if (typeof obj === "object") {
    if (seen.has(obj as object)) {
      return "[CIRCULAR]" as unknown as T;
    }
    seen.add(obj as object);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const placeholder = getFieldRedactionPlaceholder(key);
      if (placeholder !== null && value !== undefined && value !== null) {
        result[key] = placeholder;
        continue;
      }

      // If a string value looks like a serialized JSON payload (e.g. request body), scrub inside it
      if (
        typeof value === "string" &&
        ((value.startsWith("{") && value.endsWith("}")) ||
          (value.startsWith("[") && value.endsWith("]")))
      ) {
        try {
          const parsed = JSON.parse(value);
          result[key] = JSON.stringify(sanitizeObject(parsed, options, seen));
          continue;
        } catch {
          // Fall through to standard string sanitization
        }
      }

      result[key] = sanitizeObject(value, options, seen);
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