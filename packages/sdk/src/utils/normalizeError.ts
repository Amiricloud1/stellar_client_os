/**
 * Normalized error model for wallet, RPC, simulation, and contract failures.
 *
 * `normalizeError` maps any thrown value into a stable, serializable shape
 * with a machine-readable `code`, a `category`, and a `retryable` flag.
 * Messages and causes are redacted so Stellar secret seeds and signed
 * transaction XDR never leak into logs, telemetry, or UI.
 *
 * This module is additive: `parseContractError` / `FundableStellarError`
 * keep their existing behavior.
 */

export type ErrorCategory =
  | "wallet"
  | "rpc"
  | "simulation"
  | "contract"
  | "network"
  | "unknown";

export type NormalizedErrorCode =
  | "WALLET_REJECTED"
  | "WALLET_NOT_CONNECTED"
  | "WALLET_UNAVAILABLE"
  | "RPC_RATE_LIMITED"
  | "RPC_UNAVAILABLE"
  | "RPC_BAD_RESPONSE"
  | "RPC_TX_FAILED"
  | "SIMULATION_FAILED"
  | "SIMULATION_RESTORE_REQUIRED"
  | "CONTRACT_ERROR"
  | "NETWORK_TIMEOUT"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export interface NormalizedError {
  category: ErrorCategory;
  code: NormalizedErrorCode;
  /** Contract error number when the failure came from `Error(Contract, #N)`. */
  contractCode?: number;
  /** Whether retrying the same request may succeed without user changes. */
  retryable: boolean;
  /** Redacted, human-readable message. */
  message: string;
  /** Redacted description of the underlying cause, if any. */
  cause?: string;
}

const RETRYABLE: Record<NormalizedErrorCode, boolean> = {
  WALLET_REJECTED: false,
  WALLET_NOT_CONNECTED: false,
  WALLET_UNAVAILABLE: false,
  RPC_RATE_LIMITED: true,
  RPC_UNAVAILABLE: true,
  RPC_BAD_RESPONSE: true,
  RPC_TX_FAILED: false,
  SIMULATION_FAILED: false,
  SIMULATION_RESTORE_REQUIRED: true,
  CONTRACT_ERROR: false,
  NETWORK_TIMEOUT: true,
  NETWORK_ERROR: true,
  UNKNOWN: false,
};

const CATEGORY: Record<NormalizedErrorCode, ErrorCategory> = {
  WALLET_REJECTED: "wallet",
  WALLET_NOT_CONNECTED: "wallet",
  WALLET_UNAVAILABLE: "wallet",
  RPC_RATE_LIMITED: "rpc",
  RPC_UNAVAILABLE: "rpc",
  RPC_BAD_RESPONSE: "rpc",
  RPC_TX_FAILED: "rpc",
  SIMULATION_FAILED: "simulation",
  SIMULATION_RESTORE_REQUIRED: "simulation",
  CONTRACT_ERROR: "contract",
  NETWORK_TIMEOUT: "network",
  NETWORK_ERROR: "network",
  UNKNOWN: "unknown",
};

const MAX_MESSAGE_LENGTH = 500;

/** Stellar secret seeds: `S` + 55 base32 chars. */
const SECRET_SEED = /\bS[A-Z2-7]{55}\b/g;
/** Long base64 blobs (signed envelopes / result XDR). */
const BASE64_BLOB = /[A-Za-z0-9+/]{64,}={0,2}/g;

/** Remove secret seeds and XDR blobs from arbitrary text. */
export function redactSensitive(text: string): string {
  const redacted = text
    .replace(SECRET_SEED, "[REDACTED_SECRET]")
    .replace(BASE64_BLOB, "[REDACTED_XDR]");
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`
    : redacted;
}

function safeString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message ?? "";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "title"]) {
      if (typeof v[key] === "string") return v[key] as string;
    }
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  return String(value);
}

function statusOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const candidates = [
    v.status,
    v.statusCode,
    (v.response as Record<string, unknown> | undefined)?.status,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

function classify(text: string, status?: number): { code: NormalizedErrorCode; contractCode?: number } {
  const contract = text.match(/Error\(Contract,\s*#(\d+)\)/i);
  if (contract) {
    return { code: "CONTRACT_ERROR", contractCode: parseInt(contract[1], 10) };
  }

  const lower = text.toLowerCase();

  if (/user (declined|rejected|denied)|rejected by user|request rejected/.test(lower)) {
    return { code: "WALLET_REJECTED" };
  }
  if (/wallet (is )?not connected|no (wallet|account) connected/.test(lower)) {
    return { code: "WALLET_NOT_CONNECTED" };
  }
  if (/freighter|wallet (is )?not (installed|available)|extension not found/.test(lower)) {
    return { code: "WALLET_UNAVAILABLE" };
  }

  if (status === 429 || /rate limit|too many requests/.test(lower)) {
    return { code: "RPC_RATE_LIMITED" };
  }
  if ((status !== undefined && status >= 500) || /service unavailable|bad gateway/.test(lower)) {
    return { code: "RPC_UNAVAILABLE" };
  }

  if (/restore(preamble| required)|entry archived|archived entry/.test(lower)) {
    return { code: "SIMULATION_RESTORE_REQUIRED" };
  }
  if (/simulat/.test(lower)) {
    return { code: "SIMULATION_FAILED" };
  }

  if (/tx_failed|tx_bad_seq|tx_insufficient_fee|transaction failed/.test(lower)) {
    return { code: "RPC_TX_FAILED" };
  }

  if (/timed? ?out|etimedout|deadline exceeded/.test(lower)) {
    return { code: "NETWORK_TIMEOUT" };
  }
  if (/econnrefused|econnreset|enotfound|network error|failed to fetch/.test(lower)) {
    return { code: "NETWORK_ERROR" };
  }

  if (/unexpected token|invalid json|malformed|jsonrpc|cannot read propert/.test(lower)) {
    return { code: "RPC_BAD_RESPONSE" };
  }

  return { code: "UNKNOWN" };
}

/**
 * Normalize any thrown value into a stable, redacted {@link NormalizedError}.
 * Never throws, including for malformed provider responses.
 */
export function normalizeError(error: unknown): NormalizedError {
  let rawMessage = "";
  let rawCause = "";
  let status: number | undefined;

  try {
    rawMessage = safeString(error);
    status = statusOf(error);
    const cause =
      error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
    rawCause = safeString(cause);
    if (status === undefined) status = statusOf(cause);
  } catch {
    rawMessage = "";
  }

  const { code, contractCode } = classify(`${rawMessage} ${rawCause}`, status);

  const normalized: NormalizedError = {
    category: CATEGORY[code],
    code,
    retryable: RETRYABLE[code],
    message: redactSensitive(rawMessage) || "Unknown error",
  };
  if (contractCode !== undefined) normalized.contractCode = contractCode;
  if (rawCause) normalized.cause = redactSensitive(rawCause);
  return normalized;
}
