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
 * Sanitize an error object for safe telemetry reporting
 */
export function sanitizeError(
  error: Error,
  options: SanitizeOptions = {}
): Error {
  const safeError = new Error(sanitizeErrorString(error.message, options));

  // Copy over safe properties
  safeError.name = sanitizeErrorString(error.name, options);
  safeError.stack = error.stack ? sanitizeErrorString(error.stack, options) : undefined;

  // Copy any custom properties if they exist
  const customProps = Object.getOwnPropertyNames(error).filter(
    (prop) => prop !== "message" && prop !== "name" && prop !== "stack"
  );

  const errorRecord = error as Error & Record<string, unknown>;
  const safeErrorRecord = safeError as Error & Record<string, unknown>;

  for (const prop of customProps) {
    const placeholder = getFieldRedactionPlaceholder(prop);
    const value = errorRecord[prop];
    if (placeholder !== null && value !== undefined && value !== null) {
      safeErrorRecord[prop] = placeholder;
    } else if (typeof value === "string") {
      safeErrorRecord[prop] = sanitizeErrorString(value, options);
    } else if (value && typeof value === "object") {
      safeErrorRecord[prop] = sanitizeObject(value, options);
    } else {
      safeErrorRecord[prop] = value;
    }
  }

  return safeError;
}

/**
 * Scrub a Sentry breadcrumb before it is attached to the scope or transmitted.
 */
export function scrubSentryBreadcrumb<T extends Record<string, unknown>>(
  breadcrumb: T,
  options: SanitizeOptions = {}
): T {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;

  const clone: Record<string, unknown> = { ...breadcrumb };

  if (typeof clone.message === "string") {
    clone.message = sanitizeErrorString(clone.message, options);
  }

  if (clone.data && typeof clone.data === "object") {
    const dataClone = { ...(clone.data as Record<string, unknown>) };
    if (typeof dataClone.url === "string") {
      dataClone.url = sanitizeUrl(dataClone.url, options);
    }
    clone.data = sanitizeObject(dataClone, options);
  }

  return clone as T;
}

/**
 * Scrub a Sentry event (error or transaction) prior to transmission (`beforeSend` / `beforeSendTransaction`).
 * Removes tax IDs, wallet secrets, signed transactions, verification/insurance evidence,
 * and sensitive URL, header, cookie, and request body fields.
 */
export function scrubSentryEvent<T extends Record<string, unknown>>(
  event: T,
  options: SanitizeOptions = {}
): T {
  if (!event || typeof event !== "object") return event;

  const clone: Record<string, unknown> = { ...event };

  if (typeof clone.message === "string") {
    clone.message = sanitizeErrorString(clone.message, options);
  }

  if (typeof clone.transaction === "string") {
    clone.transaction = sanitizeUrl(clone.transaction, options);
  }

  if (clone.logentry && typeof clone.logentry === "object") {
    clone.logentry = sanitizeObject(clone.logentry, options);
  }

  // Scrub exception values and stack frames
  if (clone.exception && typeof clone.exception === "object") {
    const exceptionObj = { ...(clone.exception as Record<string, unknown>) };
    if (Array.isArray(exceptionObj.values)) {
      exceptionObj.values = exceptionObj.values.map((ex: unknown) => {
        if (!ex || typeof ex !== "object") return ex;
        const exRecord = { ...(ex as Record<string, unknown>) };
        if (typeof exRecord.value === "string") {
          exRecord.value = sanitizeErrorString(exRecord.value, options);
        }
        if (typeof exRecord.type === "string") {
          exRecord.type = sanitizeErrorString(exRecord.type, options);
        }
        if (exRecord.stacktrace && typeof exRecord.stacktrace === "object") {
          const st = { ...(exRecord.stacktrace as Record<string, unknown>) };
          if (Array.isArray(st.frames)) {
            st.frames = st.frames.map((frame: unknown) => {
              if (!frame || typeof frame !== "object") return frame;
              const frameRecord = { ...(frame as Record<string, unknown>) };
              if (typeof frameRecord.filename === "string") {
                frameRecord.filename = sanitizeUrl(frameRecord.filename, options);
              }
              if (typeof frameRecord.abs_path === "string") {
                frameRecord.abs_path = sanitizeUrl(frameRecord.abs_path, options);
              }
              if (frameRecord.vars && typeof frameRecord.vars === "object") {
                frameRecord.vars = sanitizeObject(frameRecord.vars, options);
              }
              return frameRecord;
            });
          }
          exRecord.stacktrace = st;
        }
        return exRecord;
      });
    }
    clone.exception = exceptionObj;
  }

  // Scrub request URL, query_string, headers, cookies, and body data
  if (clone.request && typeof clone.request === "object") {
    const req = { ...(clone.request as Record<string, unknown>) };

    if (typeof req.url === "string") {
      req.url = sanitizeUrl(req.url, options);
    }

    if (typeof req.query_string === "string") {
      req.query_string = sanitizeUrl(
        req.query_string.startsWith("?") ? req.query_string : `?${req.query_string}`,
        options
      ).replace(/^\?/, "");
    } else if (req.query_string && typeof req.query_string === "object") {
      req.query_string = sanitizeObject(req.query_string, options);
    }

    if (req.headers && typeof req.headers === "object") {
      req.headers = sanitizeObject(req.headers, options);
    }

    if (req.cookies) {
      req.cookies = "[REDACTED]";
    }

    if (typeof req.data === "string") {
      const trimmed = req.data.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          const parsed = JSON.parse(trimmed);
          req.data = JSON.stringify(sanitizeObject(parsed, options));
        } catch {
          req.data = sanitizeErrorString(req.data, options);
        }
      } else {
        req.data = sanitizeUrl(sanitizeErrorString(req.data, options), options);
      }
    } else if (req.data && typeof req.data === "object") {
      req.data = sanitizeObject(req.data, options);
    }

    clone.request = req;
  }

  // Scrub breadcrumbs
  if (Array.isArray(clone.breadcrumbs)) {
    clone.breadcrumbs = clone.breadcrumbs.map((b: unknown) =>
      b && typeof b === "object"
        ? scrubSentryBreadcrumb(b as Record<string, unknown>, options)
        : b
    );
  } else if (clone.breadcrumbs && typeof clone.breadcrumbs === "object") {
    const bcObj = { ...(clone.breadcrumbs as Record<string, unknown>) };
    if (Array.isArray(bcObj.values)) {
      bcObj.values = bcObj.values.map((b: unknown) =>
        b && typeof b === "object"
          ? scrubSentryBreadcrumb(b as Record<string, unknown>, options)
          : b
      );
    }
    clone.breadcrumbs = bcObj;
  }

  // Scrub contexts, extra, tags, and user
  if (clone.extra && typeof clone.extra === "object") {
    clone.extra = sanitizeObject(clone.extra, options);
  }

  if (clone.contexts && typeof clone.contexts === "object") {
    clone.contexts = sanitizeObject(clone.contexts, options);
  }

  if (clone.tags && typeof clone.tags === "object") {
    clone.tags = sanitizeObject(clone.tags, options);
  }

  if (clone.user && typeof clone.user === "object") {
    const userObj = { ...(clone.user as Record<string, unknown>) };
    if (userObj.email) userObj.email = "[REDACTED]";
    if (userObj.ip_address) userObj.ip_address = "[REDACTED]";
    if (typeof userObj.id === "string") {
      userObj.id = sanitizeErrorString(userObj.id, options);
    }
    if (typeof userObj.username === "string") {
      userObj.username = sanitizeErrorString(userObj.username, options);
    }
    clone.user = sanitizeObject(userObj, options);
  }

  return clone as T;
}