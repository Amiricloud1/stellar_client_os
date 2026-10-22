"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    classifyWalletError,
    type WalletErrorAction,
    type WalletErrorCategory,
} from "../lib/walletErrorClassifier";

export type MutationStatus = "idle" | "pending" | "success" | "error";

interface GuardOptions {
    cooldownMs?: number;
    /** Optional hook invoked with the classified error before it is rethrown. */
    onError?: (error: unknown, action: WalletErrorAction) => void;
}

export interface TransactionGuardError {
    /** The original error thrown by the wrapped fn. */
    cause: unknown;
    category: WalletErrorCategory;
    action: WalletErrorAction;
    /** Human-readable, safe-to-display message. */
    message: string;
}

/**
 * Chain identity captured at simulation time. Any change to `networkId` or
 * `passphrase` between simulation, signing, and confirmation means the flow is
 * stale and must be aborted (issue #70). */
export interface ChainIdentity {
    networkId: string;
    passphrase: string;
}

export type ChainGuardPhase = "idle" | "simulating" | "signing" | "confirming";

export type ChainGuardAbortReason = "network-changed" | "reconfirmation-required";

export interface ChainGuardState {
    /** Chain identity captured when the flow started (simulation time). */
    simulatedChain: ChainIdentity | null;
    /** Current phase of the guarded flow. */
    phase: ChainGuardPhase;
    /** Set when the flow was aborted because the chain identity changed. */
    abortReason: ChainGuardAbortReason | null;
    /** True when the user must re-confirm after a network switch. */
    requiresReconfirmation: boolean;
}

interface UseTransactionGuardReturn {
    isSubmitting: boolean;
    isCoolingDown: boolean;
    isGuardActive: boolean;
    /** Classified failure from the most recent run, cleared on the next run. */
    lastError: TransactionGuardError | null;
    /** Safe action recommended for the most recent failure. */
    errorAction: WalletErrorAction | null;
    /** Clears the stored error without touching form state. */
    clearError: () => void;
    runWithGuard: <T>(fn: () => Promise<T>, options?: GuardOptions) => Promise<T | undefined>;
    /** Chain-bound state for in-flight wallet transactions. */
    chainGuard: ChainGuardState;
    /**
     * Begin a chain-bound flow. Captures `chain` as the simulated identity and
     * returns a context whose `assertChain` must be called before signing and
     * before confirmation. Returns `null` if the guard is already active.
     */
    beginChainFlow: (chain: ChainIdentity) => ChainFlowContext | null;
    /** Clear a chain-guard abort and require the user to confirm again. */
    acknowledgeReconfirmation: () => void;
}

export interface ChainFlowContext {
    /** Chain identity captured at simulation time. */
    readonly simulatedChain: ChainIdentity;
    /** Advance the phase (e.g. "signing", "confirming"). */
    setPhase: (phase: ChainGuardPhase) => void;
    /**
     * Compare the live chain identity against the simulated one. On mismatch the
     * flow is aborted, the simulation invalidated, and renewed confirmation is
     * required. Returns `true` when the chain still matches.
     */
    assertChain: (current: ChainIdentity) => boolean;
    /** Mark the flow as finished (success or error) and release the guard. */
    finish: () => void;
}

function chainIdentitiesEqual(a: ChainIdentity, b: ChainIdentity): boolean {
    return a.networkId === b.networkId && a.passphrase === b.passphrase;
}

/**
 * Prevents duplicate async submissions by blocking re-entry while work is in flight
 * and for a short cooldown period after a successful submission.
 *
 * Optionally accepts an external `mutationStatus` (e.g. derived from ledger/bridge
 * polling) so the guard's lifecycle is tied to when the mutation actually settles,
 * not just to when the wrapped `fn` promise resolves. This matters when `fn` only
 * submits/kicks off work (e.g. starts polling) and resolves long before the real
 * outcome (ledger inclusion, payout confirmation) is known.
 *
 * - `mutationStatus === "pending"`: guard stays locked, even past any cooldown.
 *   Note: if `mutationStatus` is already "pending" on the very first call, `runWithGuard`
 *   is a no-op — `fn` is not invoked and the guard remains locked — since the guard has
 *   no way to distinguish "already tracking a pending mutation" from "not yet started".
 * - `mutationStatus === "success"`: guard applies the cooldown, then unlocks.
 * - `mutationStatus === "error"`: guard unlocks immediately (explicit failure, no cooldown).
 * - `mutationStatus` omitted: behavior is unchanged from the original fn-resolution-based guard. */
export function useTransactionGuard(
    defaultCooldownMs = 2000,
    mutationStatus?: MutationStatus
): UseTransactionGuardReturn {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isCoolingDown, setIsCoolingDown] = useState(false);
    const [lastError, setLastError] = useState<TransactionGuardError | null>(null);
    const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lockRef = useRef(false);
    const prevStatusRef = useRef<MutationStatus | undefined>(mutationStatus);
    const cooldownOverrideRef = useRef<number | undefined>(undefined);
    const chainGuardRef = useRef<ChainGuardState>(chainGuard);
    chainGuardRef.current = chainGuard;

    const isMutationTracked = mutationStatus !== undefined;
    const isMutationPending = mutationStatus === "pending";

    const isGuardActive = isSubmitting || isCoolingDown || lockRef.current || isMutationPending;

    useEffect(() => {
        return () => {
            if (cooldownRef.current) {
                clearTimeout(cooldownRef.current);
            }
        };
    }, []);

    // React to external mutation status transitions so the guard stays locked
    // for the full real-world lifecycle of the mutation, not just for as long
    // as the wrapped fn's own promise takes to resolve.
    useEffect(() => {
        const prevStatus = prevStatusRef.current;
        prevStatusRef.current = mutationStatus;

        if (!isMutationTracked || prevStatus === mutationStatus) {
            return;
        }

        if (mutationStatus === "error") {
            if (cooldownRef.current) {
                clearTimeout(cooldownRef.current);
                cooldownRef.current = null;
            }
            setIsCoolingDown(false);
            return;
        }

        if (mutationStatus === "success") {
            const cooldownMs = cooldownOverrideRef.current ?? defaultCooldownMs;
            if (cooldownMs > 0) {
                setIsCoolingDown(true);
                cooldownRef.current = setTimeout(() => {
                    setIsCoolingDown(false);
                    cooldownRef.current = null;
                }, cooldownMs);
            }
        }
    }, [mutationStatus, isMutationTracked, defaultCooldownMs]);

    const clearError = useCallback(() => {
        setLastError(null);
    }, []);

    const runWithGuard = useCallback(
        async <T,>(fn: () => Promise<T>, options?: GuardOptions): Promise<T | undefined> => {
            if (isGuardActive) {
                return undefined;
            }
            lockRef.current = true;
            setIsSubmitting(true);
            setLastError(null);
            cooldownOverrideRef.current = options?.cooldownMs;
            try {
                const result = await fn();
                // Only apply the fn-resolution-based cooldown when no external
                // mutation status is supplied. When a status is tracked, the
                // lifecycle is driven by the effect above instead, since fn
                // resolving early (e.g. after submit, before ledger inclusion)
                // must not be treated as "done".
                if (!isMutationTracked) {
                    const cooldownMs = options?.cooldownMs ?? defaultCooldownMs;
                    if (cooldownMs > 0) {
                        setIsCoolingDown(true);
                        cooldownRef.current = setTimeout(() => {
                            setIsCoolingDown(false);
                            cooldownRef.current = null;
                        }, cooldownMs);
                    }
                }
                return result;
            } catch (error) {
                // Map the raw failure to a safe, actionable category. The guard
                // never mutates caller-owned form state, so inputs are preserved
                // for retry / network switch / reconnect flows.
                const classified = classifyWalletError(error);
                const guardError: TransactionGuardError = {
                    cause: error,
                    category: classified.category,
                    action: classified.action,
                    message: classified.message,
                };
                setLastError(guardError);
                options?.onError?.(error, classified.action);
                throw guardError;
            } finally {
                lockRef.current = false;
                setIsSubmitting(false);
            }
        },
        [defaultCooldownMs, isGuardActive, isMutationTracked]
    );

    return {
        isSubmitting,
        isCoolingDown,
        isGuardActive,
        lastError,
        errorAction: lastError?.action ?? null,
        clearError,
        runWithGuard,
        chainGuard,
        beginChainFlow,
        acknowledgeReconfirmation,
    };
}