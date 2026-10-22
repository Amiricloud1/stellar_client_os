/**
 * Error code thrown by @creit.tech/stellar-wallets-kit when getAddress
 * returns an empty address — the typical Freighter/extension response when
 * the wallet is locked (or access has not been granted yet after lock).
 *
 * See FreighterModule.getAddress: `{ code: -3, message: "Getting the address..." }`.
 */
export const WALLET_LOCKED_ERROR_CODE = -3;

type WalletErrorLike = {
  code?: unknown;
  message?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/**
 * Returns true when a wallet SDK / extension error indicates the extension
 * wallet is locked (or otherwise unable to return an address because it is locked).
 */
export function isLockedWalletError(error: unknown): boolean {
  if (!error) return false;

  const err = error as WalletErrorLike;
  const code = err.code ?? err.error?.code;
  const message = String(err.message ?? err.error?.message ?? "").toLowerCase();

  if (
    message.includes("locked") ||
    message.includes("unlock") ||
    message.includes("wallet is locked")
  ) {
    return true;
  }

  // Kit surfaces empty-address (locked) as code -3 with an address-related message.
  if (code === WALLET_LOCKED_ERROR_CODE && message.includes("address")) {
    return true;
  }

  if (typeof error === "string") {
    const lower = error.toLowerCase();
    return lower.includes("locked") || lower.includes("unlock");
  }

  return false;
}

/**
 * Error code returned/thrown when a user explicitly rejects or cancels a
 * wallet connection or signing request (e.g. Freighter rejection code -4).
 */
export const WALLET_REJECTED_ERROR_CODE = -4;

/**
 * Returns true when an error indicates that the user cancelled or closed the
 * wallet connection modal, popover, or extension prompt.
 */
export function isWalletCancellationError(error: unknown): boolean {
  if (!error) return false;

  const err = error as WalletErrorLike;
  const code = err.code ?? err.error?.code;
  const message = String(err.message ?? err.error?.message ?? "").toLowerCase();

  // Known rejection / cancellation error codes
  if (
    code === WALLET_REJECTED_ERROR_CODE ||
    code === -4 ||
    code === "USER_REJECTED" ||
    code === "USER_CANCELLED" ||
    code === "USER_CANCELED" ||
    code === "CANCELLED" ||
    code === "CANCELED"
  ) {
    return true;
  }

  if (
    message.includes("user rejected") ||
    message.includes("user declined") ||
    message.includes("declined") ||
    message.includes("permission denied") ||
    message.includes("user cancelled") ||
    message.includes("user canceled") ||
    message.includes("cancelled") ||
    message.includes("canceled") ||
    message.includes("cancellation") ||
    message.includes("closed") ||
    message.includes("dismissed") ||
    message.includes("aborted") ||
    message.includes("rejected")
  ) {
    return true;
  }

  if (typeof error === "string") {
    const lower = error.toLowerCase();
    return (
      lower.includes("user rejected") ||
      lower.includes("user declined") ||
      lower.includes("declined") ||
      lower.includes("permission denied") ||
      lower.includes("user cancelled") ||
      lower.includes("user canceled") ||
      lower.includes("cancelled") ||
      lower.includes("canceled") ||
      lower.includes("cancellation") ||
      lower.includes("closed") ||
      lower.includes("dismissed") ||
      lower.includes("aborted") ||
      lower.includes("rejected")
    );
  }

  return false;
}

/**
 * Stable set of safe recovery actions a wallet flow can take in response to
 * an error. Consumers should switch on this value rather than inspecting raw
 * error messages, so recovery behavior stays consistent across flows.
 *
 * - `retry`         — transient failure; the same request can be safely retried.
 * - `switch-network` — the request targeted the wrong network / network mismatch.
 * - `reconnect`     — the wallet session is invalid, locked, or disconnected.
 * - `abort`         — the user cancelled/rejected, or the error is unrecoverable.
 */
export type WalletErrorAction = "retry" | "switch-network" | "reconnect" | "abort";

/**
 * Error classes recognized by {@link classifyWalletError}.
 */
export type WalletErrorKind =
  | "cancellation"
  | "locked"
  | "network"
  | "simulation"
  | "contract"
  | "unknown";

/**
 * Result of classifying a wallet error. `action` is the safe recovery step;
 * `kind` is the underlying error class; `message` is a user-facing string.
 */
export type WalletErrorClassification = {
  kind: WalletErrorKind;
  action: WalletErrorAction;
  message: string;
};

const NETWORK_ERROR_PATTERNS = [
  "network",
  "fetch failed",
  "failed to fetch",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "timeout",
  "timed out",
  "socket hang up",
  "connection refused",
  "connection reset",
  "connection error",
  "offline",
  "unavailable",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "too many requests",
  "rate limit",
  "429",
  "502",
  "503",
  "504",
];

const NETWORK_SWITCH_PATTERNS = [
  "wrong network",
  "network mismatch",
  "unsupported network",
  "unknown network",
  "invalid network",
  "network passphrase",
  "passphrase mismatch",
  "network id",
  "switch network",
  "testnet",
  "mainnet",
  "futurenet",
];

const SIMULATION_ERROR_PATTERNS = [
  "simulation",
  "simulate",
  "simulation failed",
  "failed to simulate",
  "host function",
  "invoke host function",
  "insufficient balance",
  "insufficient funds",
  "insufficient fee",
  "tx_insufficient",
  "op_underfunded",
  "op_low_reserve",
  "op_no_trust",
  "op_not_authorized",
  "op_malformed",
  "op_bad_auth",
  "op_no_destination",
  "op_no_account",
  "op_src_no_trust",
  "op_src_not_authorized",
  "op_line_full",
  "op_already_exists",
  "op_not_supported",
  "op_too_many_subentries",
  "op_exceeded_work_limit",
  "footprint",
  "resource limit",
  "budget",
];

const CONTRACT_ERROR_PATTERNS = [
  "contract",
  "contract error",
  "contract call",
  "wasm",
  "trap",
  "unreachable",
  "panic",
  "hosterror",
  "host error",
  "scerror",
  "sc error",
  "invokecontract",
  "invoke contract",
  "contract invocation",
  "auth failed",
  "authorization",
  "not authorized",
  "missing signature",
  "invalid signature",
];

function getErrorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error.toLowerCase();
  if (typeof error === "number") return String(error);

  const err = error as WalletErrorLike & { name?: unknown; stack?: unknown };
  const parts: string[] = [];
  if (typeof err.message === "string") parts.push(err.message);
  if (typeof err.error?.message === "string") parts.push(err.error.message);
  if (typeof err.name === "string") parts.push(err.name);
  if (typeof err.code === "string") parts.push(err.code);
  if (typeof err.code === "number") parts.push(String(err.code));
  if (typeof err.error?.code === "string") parts.push(err.error.code);
  if (typeof err.error?.code === "number") parts.push(String(err.error.code));

  return parts.join(" ").toLowerCase();
}

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

/**
 * Classifies any wallet / RPC / simulation / contract error into a stable
 * {@link WalletErrorAction} so every wallet flow can recover consistently.
 *
 * Precedence (most specific first):
 *  1. User cancellation / rejection → `abort`
 *  2. Locked / disconnected wallet → `reconnect`
 *  3. Network mismatch             → `switch-network`
 *  4. Transient network failure    → `retry`
 *  5. Simulation failure           → `retry` (transient) unless clearly fatal
 *  6. Contract error               → `abort` (not safely retryable)
 *  7. Unknown                      → `retry` (safe default for transient errors)
 *
 * The classifier never mutates form state; callers should preserve their
 * form values and only apply the returned `action`.
 */
export function classifyWalletError(error: unknown): WalletErrorClassification {
  if (error == null) {
    return {
      kind: "unknown",
      action: "retry",
      message: "Something went wrong. Please try again.",
    };
  }

  // 1. User cancellation / rejection — never retry automatically.
  if (isWalletCancellationError(error)) {
    return {
      kind: "cancellation",
      action: "abort",
      message: "Request was cancelled. Your inputs have been kept.",
    };
  }

  // 2. Locked / disconnected wallet — reconnect before retrying.
  if (isLockedWalletError(error)) {
    return {
      kind: "locked",
      action: "reconnect",
      message: "Your wallet is locked. Please unlock it and reconnect.",
    };
  }

  const text = getErrorText(error);

  // 3. Network mismatch — ask the user to switch networks.
  if (matchesAny(text, NETWORK_SWITCH_PATTERNS)) {
    return {
      kind: "network",
      action: "switch-network",
      message: "Your wallet is on the wrong network. Please switch networks.",
    };
  }

  // 4. Transient network / RPC failure — safe to retry.
  if (matchesAny(text, NETWORK_ERROR_PATTERNS)) {
    return {
      kind: "network",
      action: "retry",
      message: "Network request failed. Please try again.",
    };
  }

  // 5. Simulation failure — retryable unless it is a contract-level trap.
  if (matchesAny(text, SIMULATION_ERROR_PATTERNS)) {
    return {
      kind: "simulation",
      action: "retry",
      message: "Transaction simulation failed. Please review and try again.",
    };
  }

  // 6. Contract error — not safely retryable; abort and keep inputs.
  if (matchesAny(text, CONTRACT_ERROR_PATTERNS)) {
    return {
      kind: "contract",
      action: "abort",
      message: "The contract rejected this transaction. Your inputs have been kept.",
    };
  }

  // 7. Unknown — default to a safe retry.
  return {
    kind: "unknown",
    action: "retry",
    message: "Something went wrong. Please try again.",
  };
}