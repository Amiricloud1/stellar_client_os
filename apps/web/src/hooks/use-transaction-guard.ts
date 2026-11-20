// apps/web/src/hooks/use-transaction-guard.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Transaction lifecycle stages.
 *
 * The four stages are ordered and monotonic: a transaction may only advance
 * forward. Each stage has an explicit failure/recovery state so that users and
 * operators can distinguish "wallet never approved" from "submitted but never
 * confirmed" from "confirmed but not settled".
 */
export type TransactionStage =
  | "wallet-approval"
  | "submission"
  | "ledger-confirmation"
  | "settlement";

export const TRANSACTION_STAGES: readonly TransactionStage[] = [
  "wallet-approval",
  "submission",
  "ledger-confirmation",
  "settlement",
] as const;

export type StageStatus =
  | "pending"
  | "in-progress"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "dropped";

export interface StageState {
  stage: TransactionStage;
  status: StageStatus;
  /** ISO timestamp of the last status transition. */
  updatedAt: string;
  /** Optional human-readable detail (error message, tx hash, etc.). */
  detail?: string;
  /** Number of recovery attempts made for this stage. */
  attempts: number;
}

export interface TransactionTimeline {
  /** Stable identifier for the transaction being tracked. */
  transactionId: string;
  /** Ordered stage states, always one entry per stage. */
  stages: StageState[];
  /** The stage currently in progress (or the last reached stage). */
  currentStage: TransactionStage;
  /** Overall status derived from the stage states. */
  status: "active" | "succeeded" | "failed" | "recoverable";
  /** ISO timestamp when tracking began. */
  startedAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

export interface RecoveryAction {
  id: string;
  label: string;
  stage: TransactionStage;
  kind: "retry" | "resubmit" | "reconcile" | "dismiss";
}

export interface NetworkReconciliation {
  /** The stage the network reports the transaction has reached. */
  networkStage: TransactionStage | null;
  /** Whether the network reports the transaction as dropped/unknown. */
  dropped: boolean;
  /** Whether the network reports the transaction as confirmed. */
  confirmed: boolean;
  /** Whether the network reports the transaction as settled. */
  settled: boolean;
}

export interface UseTransactionGuardOptions {
  /** Stable identifier for the transaction. */
  transactionId: string;
  /** Storage key prefix; defaults to "tx-guard". */
  storageKeyPrefix?: string;
  /** Storage implementation; defaults to window.localStorage when available. */
  storage?: StorageLike | null;
  /** Per-stage timeout in milliseconds. */
  stageTimeouts?: Partial<Record<TransactionStage, number>>;
  /** Function used to reconcile local state with the network. */
  reconcile?: (transactionId: string) => Promise<NetworkReconciliation>;
  /** Called whenever a recovery action is invoked. */
  onRecovery?: (
    action: RecoveryAction,
    timeline: TransactionTimeline,
  ) => Promise<void> | void;
  /** Whether the caller is authorized to view/recover this transaction. */
  authorized?: boolean;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const DEFAULT_STAGE_TIMEOUTS: Record<TransactionStage, number> = {
  "wallet-approval": 120_000,
  submission: 60_000,
  "ledger-confirmation": 30_000,
  settlement: 60_000,
};

const STAGE_INDEX: Record<TransactionStage, number> = {
  "wallet-approval": 0,
  submission: 1,
  "ledger-confirmation": 2,
  settlement: 3,
};

function getDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Access to localStorage can throw in sandboxed contexts.
  }
  return null;
}

function storageKey(prefix: string, transactionId: string): string {
  return `${prefix}:${transactionId}`;
}

function createInitialStages(nowIso: string): StageState[] {
  return TRANSACTION_STAGES.map((stage, index) => ({
    stage,
    status: index === 0 ? "in-progress" : "pending",
    updatedAt: nowIso,
    attempts: 0,
  }));
}

function deriveStatus(stages: StageState[]): TransactionTimeline["status"] {
  const last = stages[stages.length - 1];
  if (last.status === "succeeded") {
    return "succeeded";
  }
  const anyFailed = stages.some(
    (s) => s.status === "failed" || s.status === "timed-out" || s.status === "dropped",
  );
  if (anyFailed) {
    return "recoverable";
  }
  return "active";
}

function deriveCurrentStage(stages: StageState[]): TransactionStage {
  let current: TransactionStage = "wallet-approval";
  for (const state of stages) {
    if (state.status === "succeeded") {
      current = state.stage;
      continue;
    }
    if (
      state.status === "in-progress" ||
      state.status === "failed" ||
      state.status === "timed-out" ||
      state.status === "dropped"
    ) {
      return state.stage;
    }
  }
  return current;
}

function buildTimeline(
  transactionId: string,
  stages: StageState[],
  startedAt: string,
  nowIso: string,
): TransactionTimeline {
  return {
    transactionId,
    stages,
    currentStage: deriveCurrentStage(stages),
    status: deriveStatus(stages),
    startedAt,
    updatedAt: nowIso,
  };
}

function isValidTimeline(value: unknown): value is TransactionTimeline {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TransactionTimeline>;
  if (typeof candidate.transactionId !== "string") return false;
  if (!Array.isArray(candidate.stages)) return false;
  if (candidate.stages.length !== TRANSACTION_STAGES.length) return false;
  return candidate.stages.every(
    (s) =>
      s &&
      typeof s === "object" &&
      TRANSACTION_STAGES.includes((s as StageState).stage) &&
      typeof (s as StageState).status === "string" &&
      typeof (s as StageState).updatedAt === "string",
  );
}

function loadPersisted(
  storage: StorageLike | null,
  prefix: string,
  transactionId: string,
): TransactionTimeline | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(prefix, transactionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidTimeline(parsed)) return null;
    if (parsed.transactionId !== transactionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(
  storage: StorageLike | null,
  prefix: string,
  timeline: TransactionTimeline,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      storageKey(prefix, timeline.transactionId),
      JSON.stringify(timeline),
    );
  } catch {
    // Persistence is best-effort; failures must not break the UI.
  }
}

function advanceStage(
  stages: StageState[],
  stage: TransactionStage,
  status: StageStatus,
  nowIso: string,
  detail?: string,
): StageState[] {
  const targetIndex = STAGE_INDEX[stage];
  return stages.map((state, index) => {
    if (index < targetIndex) {
      // Earlier stages are implicitly succeeded once a later stage is reached.
      if (state.status !== "succeeded") {
        return { ...state, status: "succeeded", updatedAt: nowIso };
      }
      return state;
    }
    if (index === targetIndex) {
      return {
        ...state,
        status,
        updatedAt: nowIso,
        detail: detail ?? state.detail,
      };
    }
    return state;
  });
}

function nextStage(stage: TransactionStage): TransactionStage | null {
  const index = STAGE_INDEX[stage];
  return TRANSACTION_STAGES[index + 1] ?? null;
}

/**
 * Hook that tracks a transaction through the four lifecycle stages and
 * persists the timeline so it can be rehydrated after a reload.
 */
export function useTransactionGuard(options: UseTransactionGuardOptions) {
  const {
    transactionId,
    storageKeyPrefix = "tx-guard",
    stageTimeouts,
    reconcile,
    onRecovery,
    authorized = true,
    now = Date.now,
  } = options;

  const storage = useMemo<StorageLike | null>(() => {
    if (options.storage !== undefined) return options.storage;
    return getDefaultStorage();
  }, [options.storage]);

  const timeouts = useMemo<Record<TransactionStage, number>>(
    () => ({ ...DEFAULT_STAGE_TIMEOUTS, ...(stageTimeouts ?? {}) }),
    [stageTimeouts],
  );

  const nowRef = useRef(now);
  nowRef.current = now;

  const [timeline, setTimeline] = useState<TransactionTimeline>(() => {
    const nowIso = new Date(nowRef.current()).toISOString();
    if (!authorized) {
      // Unauthorized callers get a fresh, non-persisted timeline.
      return buildTimeline(
        transactionId,
        createInitialStages(nowIso),
        nowIso,
        nowIso,
      );
    }
    const persisted = loadPersisted(storage, storageKeyPrefix, transactionId);
    if (persisted) {
      return persisted;
    }
    return buildTimeline(
      transactionId,
      createInitialStages(nowIso),
      nowIso,
      nowIso,
    );
  });

  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  // Persist whenever the timeline changes (only when authorized).
  useEffect(() => {
    if (!authorized) return;
    persist(storage, storageKeyPrefix, timeline);
  }, [authorized, storage, storageKeyPrefix, timeline]);

  const applyUpdate = useCallback(
    (
      updater: (prev: TransactionTimeline, nowIso: string) => TransactionTimeline,
    ) => {
      setTimeline((prev) => {
        const nowIso = new Date(nowRef.current()).toISOString();
        return updater(prev, nowIso);
      });
    },
    [],
  );

  /**
   * Mark a stage as in progress. Advancing to a later stage implicitly
   * succeeds all earlier stages.
   */
  const beginStage = useCallback(
    (stage: TransactionStage, detail?: string) => {
      if (!authorized) {
        setRecoveryError("Not authorized to update this transaction.");
        return;
      }
      applyUpdate((prev, nowIso) => {
        const stages = advanceStage(prev.stages, stage, "in-progress", nowIso, detail);
        return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
      });
    },
    [applyUpdate, authorized],
  );

  /** Mark a stage as succeeded and advance to the next stage if any. */
  const completeStage = useCallback(
    (stage: TransactionStage, detail?: string) => {
      if (!authorized) {
        setRecoveryError("Not authorized to update this transaction.");
        return;
      }
      applyUpdate((prev, nowIso) => {
        let stages = advanceStage(prev.stages, stage, "succeeded", nowIso, detail);
        const next = nextStage(stage);
        if (next) {
          stages = advanceStage(stages, next, "in-progress", nowIso);
        }
        return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
      });
    },
    [applyUpdate, authorized],
  );

  /** Mark a stage as failed with an explicit reason. */
  const failStage = useCallback(
    (stage: TransactionStage, detail?: string) => {
      if (!authorized) {
        setRecoveryError("Not authorized to update this transaction.");
        return;
      }
      applyUpdate((prev, nowIso) => {
        const stages = advanceStage(prev.stages, stage, "failed", nowIso, detail);
        return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
      });
    },
    [applyUpdate, authorized],
  );

  /** Mark a stage as timed out. */
  const timeoutStage = useCallback(
    (stage: TransactionStage, detail?: string) => {
      if (!authorized) {
        setRecoveryError("Not authorized to update this transaction.");
        return;
      }
      applyUpdate((prev, nowIso) => {
        const stages = advanceStage(prev.stages, stage, "timed-out", nowIso, detail);
        return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
      });
    },
    [applyUpdate, authorized],
  );

  /** Mark a stage as dropped (e.g. submission evicted from the mempool). */
  const dropStage = useCallback(
    (stage: TransactionStage, detail?: string) => {
      if (!authorized) {
        setRecoveryError("Not authorized to update this transaction.");
        return;
      }
      applyUpdate((prev, nowIso) => {
        const stages = advanceStage(prev.stages, stage, "dropped", nowIso, detail);
        return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
      });
    },
    [applyUpdate, authorized],
  );

  /**
   * Reconcile local state with the network. This is called on mount (to
   * recover after reload) and can be invoked manually.
   */
  const reconcileWithNetwork = useCallback(async () => {
    if (!authorized) {
      setReconcileError("Not authorized to reconcile this transaction.");
      return;
    }
    if (!reconcile) return;
    setReconciling(true);
    setReconcileError(null);
    try {
      const result = await reconcile(transactionId);
      applyUpdate((prev, nowIso) => {
        let stages = prev.stages;

        if (result.dropped) {
          // The network has no record of the transaction: mark the furthest
          // in-progress stage as dropped so the user can resubmit.
          const current = deriveCurrentStage(stages);
          stages = advanceStage(
            stages,
            current,
            "dropped",
            nowIso,
            "Transaction not found on network.",
          );
        } else if (result.networkStage) {
          const networkIndex = STAGE_INDEX[result.networkStage];
          stages = stages.map((state, index) => {
            if (index < networkIndex && state.status !== "succeeded") {
              return { ...state, status: "succeeded", updatedAt: nowIso };
            }
            if (index === networkIndex) {
              const status: StageStatus = result.settled
                ? "succeeded"
                : result.confirmed && state.stage === "ledger-confirmation"
                  ? "succeeded"
                  : state.status === "pending"
                    ? "in-progress"
                    : state.status;
              return { ...state, status, updatedAt: nowIso };
            }
            return state;
          });
        }

        return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
      });
    } catch (error) {
      setReconcileError(
        error instanceof Error ? error.message : "Failed to reconcile transaction.",
      );
    } finally {
      setReconciling(false);
    }
  }, [applyUpdate, authorized, reconcile, transactionId]);

  // Rehydrate + reconcile on mount / when the transaction changes.
  const reconciledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authorized) return;
    if (!reconcile) return;
    if (reconciledRef.current === transactionId) return;
    reconciledRef.current = transactionId;
    void reconcileWithNetwork();
  }, [authorized, reconcile, reconcileWithNetwork, transactionId]);

  /** Compute the available recovery actions for the current timeline. */
  const recoveryActions = useMemo<RecoveryAction[]>(() => {
    if (!authorized) return [];
    const actions: RecoveryAction[] = [];
    for (const state of timeline.stages) {
      if (state.status === "failed" || state.status === "timed-out") {
        actions.push({
          id: `retry:${state.stage}`,
          label: `Retry ${state.stage.replace(/-/g, " ")}`,
          stage: state.stage,
          kind: "retry",
        });
      } else if (state.status === "dropped") {
        actions.push({
          id: `resubmit:${state.stage}`,
          label: `Resubmit ${state.stage.replace(/-/g, " ")}`,
          stage: state.stage,
          kind: "resubmit",
        });
      }
    }
    if (reconcile && timeline.status !== "succeeded") {
      actions.push({
        id: "reconcile",
        label: "Reconcile with network",
        stage: timeline.currentStage,
        kind: "reconcile",
      });
    }
    if (timeline.status === "recoverable") {
      actions.push({
        id: "dismiss",
        label: "Dismiss",
        stage: timeline.currentStage,
        kind: "dismiss",
      });
    }
    return actions;
  }, [authorized, reconcile, timeline]);

  /** Invoke a recovery action. */
  const recover = useCallback(
    async (action: RecoveryAction) => {
      if (!authorized) {
        setRecoveryError("Not authorized to recover this transaction.");
        return;
      }
      setRecoveryError(null);
      try {
        if (action.kind === "reconcile") {
          await reconcileWithNetwork();
          return;
        }
        if (action.kind === "dismiss") {
          applyUpdate((prev, nowIso) => {
            const stages = prev.stages.map((state) =>
              state.status === "failed" ||
              state.status === "timed-out" ||
              state.status === "dropped"
                ? { ...state, status: "pending" as StageStatus, updatedAt: nowIso }
                : state,
            );
            return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
          });
          return;
        }
        // retry / resubmit: bump attempts and re-enter the stage.
        applyUpdate((prev, nowIso) => {
          const stages = prev.stages.map((state) =>
            state.stage === action.stage
              ? {
                  ...state,
                  status: "in-progress" as StageStatus,
                  updatedAt: nowIso,
                  attempts: state.attempts + 1,
                  detail: undefined,
                }
              : state,
          );
          return buildTimeline(prev.transactionId, stages, prev.startedAt, nowIso);
        });
        if (onRecovery) {
          await onRecovery(action, timeline);
        }
      } catch (error) {
        setRecoveryError(
          error instanceof Error ? error.message : "Recovery action failed.",
        );
      }
    },
    [applyUpdate, authorized, onRecovery, reconcileWithNetwork, timeline],
  );

  /** Clear persisted state for this transaction. */
  const reset = useCallback(() => {
    if (storage) {
      try {
        storage.removeItem(storageKey(storageKeyPrefix, transactionId));
      } catch {
        // ignore
      }
    }
    const nowIso = new Date(nowRef.current()).toISOString();
    setTimeline(
      buildTimeline(transactionId, createInitialStages(nowIso), nowIso, nowIso),
    );
    setReconcileError(null);
    setRecoveryError(null);
  }, [storage, storageKeyPrefix, transactionId]);

  return {
    timeline,
    currentStage: timeline.currentStage,
    status: timeline.status,
    stages: timeline.stages,
    recoveryActions,
    reconciling,
    reconcileError,
    recoveryError,
    authorized,
    beginStage,
    completeStage,
    failStage,
    timeoutStage,
    dropStage,
    reconcileWithNetwork,
    recover,
    reset,
    stageTimeouts: timeouts,
  };
}

export type UseTransactionGuardResult = ReturnType<typeof useTransactionGuard>;
```

```typescript
// apps/web/src/hooks/__tests__/use-transaction-guard.test.tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useTransactionGuard,
  type NetworkReconciliation,
  type StorageLike,
} from "../use-transaction-guard";

function createMemoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe("useTransactionGuard", () => {
  it("advances through all four stages on the success path", () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-1", storage }),
    );

    expect(result.current.currentStage).toBe("wallet-approval");

    act(() => result.current.completeStage("wallet-approval"));
    expect(result.current.currentStage).toBe("submission");

    act(() => result.current.completeStage("submission"));
    expect(result.current.currentStage).toBe("ledger-confirmation");

    act(() => result.current.completeStage("ledger-confirmation"));
    expect(result.current.currentStage).toBe("settlement");

    act(() => result.current.completeStage("settlement"));
    expect(result.current.status).toBe("succeeded");
    expect(result.current.stages.every((s) => s.status === "succeeded")).toBe(true);
  });

  it("persists and rehydrates the timeline after reload", () => {
    const storage = createMemoryStorage();
    const first = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-2", storage }),
    );
    act(() => first.result.current.completeStage("wallet-approval"));
    act(() => first.result.current.completeStage("submission"));
    first.unmount();

    const second = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-2", storage }),
    );
    expect(second.result.current.currentStage).toBe("ledger-confirmation");
    expect(second.result.current.stages[0].status).toBe("succeeded");
    expect(second.result.current.stages[1].status).toBe("succeeded");
  });

  it("marks a stage as timed out and exposes a retry action", () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-3", storage }),
    );
    act(() => result.current.completeStage("wallet-approval"));
    act(() => result.current.timeoutStage("submission", "no receipt"));

    expect(result.current.status).toBe("recoverable");
    expect(result.current.stages[1].status).toBe("timed-out");
    const retry = result.current.recoveryActions.find(
      (a) => a.kind === "retry" && a.stage === "submission",
    );
    expect(retry).toBeDefined();
  });

  it("marks a dropped submission and exposes a resubmit action", () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-4", storage }),
    );
    act(() => result.current.completeStage("wallet-approval"));
    act(() => result.current.dropStage("submission", "evicted"));

    expect(result.current.stages[1].status).toBe("dropped");
    const resubmit = result.current.recoveryActions.find(
      (a) => a.kind === "resubmit" && a.stage === "submission",
    );
    expect(resubmit).toBeDefined();
  });

  it("retries a failed stage and increments attempts", async () => {
    const storage = createMemoryStorage();
    const onRecovery = vi.fn();
    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-5", storage, onRecovery }),
    );
    act(() => result.current.failStage("wallet-approval", "rejected"));
    const retry = result.current.recoveryActions.find(
      (a) => a.kind === "retry" && a.stage === "wallet-approval",
    );
    expect(retry).toBeDefined();

    await act(async () => {
      await result.current.recover(retry!);
    });

    expect(result.current.stages[0].status).toBe("in-progress");
    expect(result.current.stages[0].attempts).toBe(1);
    expect(onRecovery).toHaveBeenCalledWith(retry, expect.anything());
  });

  it("reconciles with the network on mount and recovers after reload", async () => {
    const storage = createMemoryStorage();
    const reconcile = vi.fn(
      async (): Promise<NetworkReconciliation> => ({
        networkStage: "ledger-confirmation",
        dropped: false,
        confirmed: true,
        settled: false,
      }),
    );

    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-6", storage, reconcile }),
    );

    await waitFor(() => {
      expect(result.current.currentStage).toBe("ledger-confirmation");
    });
    expect(result.current.stages[0].status).toBe("succeeded");
    expect(result.current.stages[1].status).toBe("succeeded");
    expect(result.current.stages[2].status).toBe("succeeded");
    expect(result.current.currentStage).toBe("settlement");
  });

  it("marks the current stage dropped when the network has no record", async () => {
    const storage = createMemoryStorage();
    const reconcile = vi.fn(
      async (): Promise<NetworkReconciliation> => ({
        networkStage: null,
        dropped: true,
        confirmed: false,
        settled: false,
      }),
    );

    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-7", storage, reconcile }),
    );

    await waitFor(() => {
      expect(result.current.stages[0].status).toBe("dropped");
    });
    expect(result.current.status).toBe("recoverable");
  });

  it("surfaces reconcile errors without losing local state", async () => {
    const storage = createMemoryStorage();
    const reconcile = vi.fn(async () => {
      throw new Error("network unavailable");
    });

    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-8", storage, reconcile }),
    );

    await waitFor(() => {
      expect(result.current.reconcileError).toBe("network unavailable");
    });
    expect(result.current.currentStage).toBe("wallet-approval");
  });

  it("blocks updates and recovery when unauthorized", async () => {
    const storage = createMemoryStorage();
    const onRecovery = vi.fn();
    const { result } = renderHook(() =>
      useTransactionGuard({
        transactionId: "tx-9",
        storage,
        authorized: false,
        onRecovery,
      }),
    );

    act(() => result.current.completeStage("wallet-approval"));
    expect(result.current.currentStage).toBe("wallet-approval");
    expect(result.current.recoveryActions).toHaveLength(0);

    await act(async () => {
      await result.current.recover({
        id: "retry:wallet-approval",
        label: "Retry",
        stage: "wallet-approval",
        kind: "retry",
      });
    });
    expect(onRecovery).not.toHaveBeenCalled();
    expect(result.current.recoveryError).toMatch(/not authorized/i);
  });

  it("resets persisted state", () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() =>
      useTransactionGuard({ transactionId: "tx-10", storage }),
    );
    act(() => result.current.completeStage("wallet-approval"));
    expect(storage.data.size).toBe(1);

    act(() => result.current.reset());
    expect(result.current.currentStage).toBe("wallet-approval");
    expect(storage.data.size).toBe(0);
  });
});