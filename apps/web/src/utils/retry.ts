export interface RetryOptions {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    signal?: AbortSignal;
    /**
     * Optional predicate overriding the default retryability classification.
     * Return `false` to abort immediately (e.g. user rejected, insufficient funds).
     */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    /** Optional hook invoked before each backoff sleep (useful for telemetry). */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Unified recovery actions surfaced to wallet flows. Each maps a failure class to
 * a safe, user-facing next step so transaction hooks can render consistent UI.
 */
export type RecoveryAction = "retry" | "switch-network" | "reconnect" | "abort";

export interface RecoveryDecision {
    action: RecoveryAction;
    /** Whether the original form values should be preserved for a retry. */
    preserveForm: boolean;
    /** Whether an automatic bounded retry is safe to attempt. */
    retryable: boolean;
    message: string;
}

export class RetryableError extends Error {
    constructor(
        message: string,
        public readonly status?: number
    ) {
        super(message);
        this.name = "RetryableError";
    }
}

export function createAbortError(message: string = "The operation was aborted"): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

export function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException) {
        return error.name === "AbortError";
    }
    return error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError");
}

/**
 * Handles intentional AbortError cancellations silently without logging uncaught errors.
 */
export function handleAbortError(error: unknown): boolean {
    if (isAbortError(error)) {
        // Silent handling of intentional request cancellations
        return true;
    }
    return false;
}

/**
 * Silences intentional request abort errors and returns fallback value.
 */
export function silenceAbortError<T = null>(error: unknown, fallback: T = null as T): T {
    if (isAbortError(error)) {
        return fallback;
    }
    throw error;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

export async function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!signal) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createAbortError());
        signal.addEventListener("abort", onAbort, { once: true });

        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
}

const NETWORK_ERROR_CODES = new Set([
    "NETWORK_ERROR",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
]);

const WALLET_DISCONNECT_CODES = new Set(["WALLET_DISCONNECTED", "DISCONNECTED", "RECONNECT_REQUIRED"]);
const WRONG_NETWORK_CODES = new Set(["WRONG_NETWORK", "CHAIN_MISMATCH", "UNSUPPORTED_CHAIN"]);
const USER_REJECTION_CODES = new Set(["ACTION_REJECTED", "USER_REJECTED", "USER_DENIED"]);

function getErrorCode(error: unknown): string | undefined {
    if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") return code;
    }
    return undefined;
}

function getErrorStatus(error: unknown): number | undefined {
    if (error && typeof error === "object" && "status" in error) {
        const status = (error as { status?: unknown }).status;
        if (typeof status === "number") return status;
    }
    return undefined;
}

export function isRetryable(error: unknown): boolean {
    if (isAbortError(error)) return false;
    if (error instanceof RetryableError) return true;

    const code = getErrorCode(error);
    if (code) {
        if (USER_REJECTION_CODES.has(code)) return false;
        if (WRONG_NETWORK_CODES.has(code)) return false;
        if (WALLET_DISCONNECT_CODES.has(code)) return false;
        if (NETWORK_ERROR_CODES.has(code)) return true;
    }

    if (error instanceof TypeError) return true; // network error

    const status = getErrorStatus(error);
    if (status) {
        if (status === 429) return true; // Rate Limit should be retryable
        if (status >= 400 && status < 500) return false; // 4xx — not retryable
        if (status >= 500) return true; // 5xx — retryable
    }

    return true; // unknown errors are retried
}

/**
 * Classifies a failure into a safe recovery action for wallet/transaction flows.
 * Never throws; unknown errors default to a bounded retry with form preservation.
 */
export function classifyRecovery(error: unknown): RecoveryDecision {
    if (isAbortError(error)) {
        return { action: "abort", preserveForm: true, retryable: false, message: "Request cancelled." };
    }

    const code = getErrorCode(error);
    if (code && USER_REJECTION_CODES.has(code)) {
        return {
            action: "abort",
            preserveForm: true,
            retryable: false,
            message: "Transaction rejected in wallet.",
        };
    }
    if (code && WRONG_NETWORK_CODES.has(code)) {
        return {
            action: "switch-network",
            preserveForm: true,
            retryable: false,
            message: "Wrong network selected. Switch networks to continue.",
        };
    }
    if (code && WALLET_DISCONNECT_CODES.has(code)) {
        return {
            action: "reconnect",
            preserveForm: true,
            retryable: false,
            message: "Wallet disconnected. Reconnect to continue.",
        };
    }

    if (isRetryable(error)) {
        return {
            action: "retry",
            preserveForm: true,
            retryable: true,
            message: "Temporary failure. Retrying…",
        };
    }

    return {
        action: "abort",
        preserveForm: true,
        retryable: false,
        message: error instanceof Error ? error.message : "Transaction failed.",
    };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(createAbortError());
        };

        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 10_000,
        signal,
        shouldRetry,
        onRetry,
    }: RetryOptions = {}
): Promise<T> {
    const boundedMaxRetries = Math.max(0, Math.floor(maxRetries));
    let lastError: unknown;

    for (let attempt = 0; attempt <= boundedMaxRetries; attempt++) {
        throwIfAborted(signal);
        try {
            return await fn();
        } catch (error) {
            if (isAbortError(error)) throw error;
            lastError = error;

            const retryable = shouldRetry ? shouldRetry(error, attempt) : isRetryable(error);
            if (!retryable || attempt === boundedMaxRetries) throw error;

            const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * 1000, maxDelay);
            onRetry?.(error, attempt, delay);
            await sleep(delay, signal);
        }
    }

    throw lastError;
}
