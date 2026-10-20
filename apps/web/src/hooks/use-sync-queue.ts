"use client";

/**
 * useSyncQueue — Offline-first PWA sync queue hook (Issues #528, #73)
 *
 * Manages a queue of pending evidence uploads and actions that could not be
 * submitted while the user was offline. Provides:
 *   - Real-time online/offline detection
 *   - Queue CRUD (add, remove, discard, clear)
 *   - Automatic retry when the connection is restored
 *   - Manual retry trigger with force option
 *   - Per-item status tracking (pending | syncing | synced | failed | conflict)
 *   - Recoverable conflict resolution (stale, duplicate, permanent, transient)
 *   - Preservation of user input / payload throughout failures & conflicts
 *   - Explicit conflict-resolution actions: use local, accept server, merge
 *
 * Persistence: the queue is stored in localStorage so it survives page
 * refreshes. The key is configurable via the `storageKey` option.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SyncItemStatus = "pending" | "syncing" | "synced" | "failed" | "conflict";

export type SyncFailureType = "transient" | "permanent" | "stale" | "duplicate" | "conflict";

export interface ConflictDetails {
  serverVersion?: unknown;
  localVersion?: unknown;
  reason?: string;
  conflictedAt?: number;
  serverTimestamp?: number;
}

export type ConflictResolution =
  | { action: "use_local" }
  | { action: "use_server" }
  | { action: "merge"; mergedPayload: unknown; newLabel?: string };

export interface SyncResult {
  success: boolean;
  error?: string;
  failureType?: SyncFailureType;
  conflictDetails?: ConflictDetails;
}

export interface SyncQueueItem {
  /** Unique identifier for this queue item. */
  id: string;
  /** Human-readable label shown in the action drawer. */
  label: string;
  /** Optional description (file name, stream id, etc.). */
  description?: string;
  /** Current sync status. */
  status: SyncItemStatus;
  /** Unix timestamp (ms) when the item was enqueued. */
  enqueuedAt: number;
  /** Unix timestamp (ms) of the last retry attempt. */
  lastAttemptAt?: number;
  /** Number of retry attempts so far. */
  retryCount: number;
  /** Error message from the last failed attempt. */
  error?: string;
  /** Classification of the failure (stale, duplicate, permanent, transient, conflict). */
  failureType?: SyncFailureType;
  /** User input payload preserved across attempts and conflicts. */
  payload?: unknown;
  /** Conflict metadata if status === "conflict" or failureType === "conflict" | "stale". */
  conflictDetails?: ConflictDetails;
}

export interface SyncQueueOptions {
  /** localStorage key for queue persistence. Default: "fundable_sync_queue" */
  storageKey?: string;
  /** Maximum number of auto-retry attempts per item. Default: 3 */
  maxRetries?: number;
  /**
   * Async function that performs the actual sync operation for a single item.
   * Return `true` or `{ success: true }` on success,
   * throw or return `false` / `{ success: false, ... }` on failure.
   */
  onSync?: (item: SyncQueueItem) => Promise<boolean | SyncResult>;
  /** Called when an item syncs successfully. */
  onSyncSuccess?: (item: SyncQueueItem) => void;
  /** Called when an item fails after all retries or hits a non-retryable failure. */
  onSyncFailure?: (item: SyncQueueItem, error: string, failureType?: SyncFailureType) => void;
  /** Called when a conflict is encountered. */
  onSyncConflict?: (item: SyncQueueItem, conflict: ConflictDetails) => void;
}

export interface SyncQueueState {
  /** All items in the queue (all statuses). */
  queue: SyncQueueItem[];
  /** Items still waiting to be synced. */
  pendingItems: SyncQueueItem[];
  /** Items currently being synced. */
  syncingItems: SyncQueueItem[];
  /** Items that failed after retries or with permanent/duplicate error. */
  failedItems: SyncQueueItem[];
  /** Items that encountered a conflict or stale server state. */
  conflictItems: SyncQueueItem[];
  /** Items successfully synced. */
  syncedItems: SyncQueueItem[];
  /** Number of pending + failed + conflict items. */
  pendingCount: number;
  /** Number of items currently requiring conflict resolution. */
  conflictCount: number;
  /** Whether any items are actively syncing. */
  isSyncing: boolean;
  /** Whether the browser is currently online. */
  isOnline: boolean;
  /** Add a new item to the sync queue while preserving user payload. */
  enqueue: (item: Omit<SyncQueueItem, "id" | "status" | "enqueuedAt" | "retryCount">) => string;
  /** Remove a specific item from the queue. */
  remove: (id: string) => void;
  /** Discard a specific failed or conflicted item from the queue. */
  discard: (id: string) => void;
  /** Retry all pending and failed items immediately. */
  retryAll: (options?: { includeConflicts?: boolean }) => Promise<void>;
  /** Retry a single item, with optional force to bypass backoff or conflict status. */
  retryItem: (id: string, options?: { force?: boolean }) => Promise<void>;
  /** Resolve a conflict using local input, server version, or merged payload. */
  resolveConflict: (id: string, resolution: ConflictResolution) => Promise<void>;
  /** Update an item's user payload without losing input, resetting it to pending. */
  updatePayload: (id: string, newPayload: unknown, newLabel?: string) => void;
  /** Clear all synced items from the queue. */
  clearSynced: () => void;
  /** Clear the entire queue (pending, failed, synced, conflicts). */
  clearAll: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_STORAGE_KEY = "fundable_sync_queue";
const DEFAULT_MAX_RETRIES = 3;

// ── UUID helper ───────────────────────────────────────────────────────────────

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Queue persistence ─────────────────────────────────────────────────────────

function loadQueue(storageKey: string): SyncQueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SyncQueueItem[];
    // Reset any "syncing" items back to "pending" (interrupted mid-sync)
    return parsed.map((item) =>
      item.status === "syncing" ? { ...item, status: "pending" } : item
    );
  } catch {
    return [];
  }
}

function saveQueue(storageKey: string, queue: SyncQueueItem[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(queue));
  } catch {
    // localStorage unavailable — silently skip
  }
}

/**
 * Classifies an error into transient, permanent, stale, duplicate, or conflict.
 */
function classifyError(err: unknown): { failureType: SyncFailureType; message: string; conflictDetails?: ConflictDetails } {
  if (typeof err === "object" && err !== null) {
    const errObj = err as Record<string, unknown>;
    const message = typeof errObj.message === "string" ? errObj.message : String(errObj.error || "Sync failed");
    if (errObj.failureType && typeof errObj.failureType === "string") {
      return {
        failureType: errObj.failureType as SyncFailureType,
        message,
        conflictDetails: errObj.conflictDetails as ConflictDetails | undefined,
      };
    }
    const lower = message.toLowerCase();
    if (lower.includes("conflict") || lower.includes("409") || lower.includes("version mismatch")) {
      return {
        failureType: "conflict",
        message,
        conflictDetails: {
          serverVersion: errObj.serverVersion,
          localVersion: errObj.localVersion,
          reason: message,
          conflictedAt: Date.now(),
        },
      };
    }
    if (lower.includes("stale") || lower.includes("outdated")) {
      return {
        failureType: "stale",
        message,
        conflictDetails: {
          serverVersion: errObj.serverVersion,
          localVersion: errObj.localVersion,
          reason: message,
          conflictedAt: Date.now(),
        },
      };
    }
    if (lower.includes("duplicate") || lower.includes("already exists") || lower.includes("already submitted")) {
      return { failureType: "duplicate", message };
    }
    if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("invalid input") || lower.includes("400")) {
      return { failureType: "permanent", message };
    }
    return { failureType: "transient", message };
  }
  return { failureType: "transient", message: String(err || "Sync failed") };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSyncQueue(options: SyncQueueOptions = {}): SyncQueueState {
  const {
    storageKey = DEFAULT_STORAGE_KEY,
    maxRetries = DEFAULT_MAX_RETRIES,
    onSync,
    onSyncSuccess,
    onSyncFailure,
    onSyncConflict,
  } = options;

  const [queue, setQueue] = useState<SyncQueueItem[]>(() => loadQueue(storageKey));
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  const queueRef = useRef(queue);
  queueRef.current = queue;

  // ── Persist on every change ───────────────────────────────────────────────
  useEffect(() => {
    saveQueue(storageKey, queue);
  }, [queue, storageKey]);

  // ── Online / offline detection ────────────────────────────────────────────
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // ── Auto-retry when coming back online ───────────────────────────────────
  useEffect(() => {
    if (!isOnline) return;
    const hasPending = queueRef.current.some(
      (item) => item.status === "pending" || (item.status === "failed" && item.failureType === "transient")
    );
    if (hasPending && onSync) {
      retryAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // ── Queue mutations ───────────────────────────────────────────────────────

  const enqueue = useCallback(
    (item: Omit<SyncQueueItem, "id" | "status" | "enqueuedAt" | "retryCount">): string => {
      const id = generateId();
      const newItem: SyncQueueItem = {
        ...item,
        id,
        status: "pending",
        enqueuedAt: Date.now(),
        retryCount: 0,
      };
      setQueue((prev) => {
        const next = [...prev, newItem];
        queueRef.current = next;
        return next;
      });
      return id;
    },
    []
  );

  const remove = useCallback((id: string) => {
    setQueue((prev) => {
      const next = prev.filter((item) => item.id !== id);
      queueRef.current = next;
      return next;
    });
  }, []);

  const discard = useCallback((id: string) => {
    remove(id);
  }, [remove]);

  const clearSynced = useCallback(() => {
    setQueue((prev) => {
      const next = prev.filter((item) => item.status !== "synced");
      queueRef.current = next;
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setQueue([]);
    queueRef.current = [];
  }, []);

  // ── Update user payload ───────────────────────────────────────────────────

  const updatePayload = useCallback(
    (id: string, newPayload: unknown, newLabel?: string) => {
      const next = queueRef.current.map((item) =>
        item.id === id
          ? {
              ...item,
              payload: newPayload,
              label: newLabel ?? item.label,
              status: "pending" as const,
              error: undefined,
              failureType: undefined,
              conflictDetails: undefined,
              retryCount: 0,
            }
          : item
      );
      queueRef.current = next;
      setQueue(next);
    },
    []
  );

  // ── Handle item failure ───────────────────────────────────────────────────

  const handleItemFailure = useCallback(
    (
      id: string,
      item: SyncQueueItem,
      errInfo: { failureType: SyncFailureType; message: string; conflictDetails?: ConflictDetails }
    ) => {
      const { failureType, message, conflictDetails } = errInfo;
      const newRetryCount = item.retryCount + 1;

      if (failureType === "conflict" || failureType === "stale") {
        const finalConflict: ConflictDetails = conflictDetails || {
          reason: message,
          conflictedAt: Date.now(),
          localVersion: item.payload,
        };

        setQueue((prev) => {
          const next = prev.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "conflict" as const,
                  failureType,
                  error: message,
                  conflictDetails: finalConflict,
                  retryCount: newRetryCount,
                }
              : i
          );
          queueRef.current = next;
          return next;
        });

        onSyncConflict?.(
          { ...item, status: "conflict", failureType, error: message, conflictDetails: finalConflict },
          finalConflict
        );
        return;
      }

      if (failureType === "permanent" || failureType === "duplicate") {
        setQueue((prev) => {
          const next = prev.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "failed" as const,
                  failureType,
                  error: message,
                  retryCount: newRetryCount,
                }
              : i
          );
          queueRef.current = next;
          return next;
        });

        onSyncFailure?.(
          { ...item, status: "failed", failureType, error: message, retryCount: newRetryCount },
          message,
          failureType
        );
        return;
      }

      // Transient failure
      const isFinal = newRetryCount >= maxRetries;
      setQueue((prev) => {
        const next = prev.map((i) =>
          i.id === id
            ? {
                ...i,
                status: isFinal ? ("failed" as const) : ("pending" as const),
                failureType: "transient" as const,
                retryCount: newRetryCount,
                error: message,
              }
            : i
        );
        queueRef.current = next;
        return next;
      });

      if (isFinal) {
        onSyncFailure?.(
          { ...item, status: "failed", failureType: "transient", error: message, retryCount: newRetryCount },
          message,
          "transient"
        );
      }
    },
    [maxRetries, onSyncConflict, onSyncFailure]
  );

  // ── Sync a single item ────────────────────────────────────────────────────

  const syncItem = useCallback(
    async (id: string, syncOpts?: { force?: boolean }): Promise<void> => {
      if (!onSync) return;

      const item = queueRef.current.find((i) => i.id === id);
      if (!item || item.status === "syncing" || item.status === "synced") return;
      if (item.status === "conflict" && !syncOpts?.force) return;

      // Mark as syncing
      setQueue((prev) => {
        const next = prev.map((i) =>
          i.id === id
            ? { ...i, status: "syncing" as const, lastAttemptAt: Date.now() }
            : i
        );
        queueRef.current = next;
        return next;
      });

      try {
        const result = await onSync({ ...item, status: "syncing" });

        if (result === true || (typeof result === "object" && result !== null && result.success)) {
          // Success
          setQueue((prev) => {
            const next = prev.map((i) =>
              i.id === id
                ? {
                    ...i,
                    status: "synced" as const,
                    error: undefined,
                    failureType: undefined,
                    conflictDetails: undefined,
                  }
                : i
            );
            queueRef.current = next;
            return next;
          });
          onSyncSuccess?.({ ...item, status: "synced" });
        } else {
          // Failure returned as object or false
          const failureObj = typeof result === "object" && result !== null ? result : {};
          const errInfo = classifyError(failureObj.error ? failureObj : new Error("Sync returned false"));
          handleItemFailure(id, item, errInfo);
        }
      } catch (err) {
        const errInfo = classifyError(err);
        handleItemFailure(id, item, errInfo);
      }
    },
    [handleItemFailure, onSync, onSyncSuccess]
  );

  // ── Retry actions ─────────────────────────────────────────────────────────

  const retryItem = useCallback(
    async (id: string, options?: { force?: boolean }): Promise<void> => {
      setQueue((prev) => {
        const next = prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "pending" as const,
                error: undefined,
                retryCount: options?.force ? 0 : item.retryCount,
                conflictDetails: options?.force ? undefined : item.conflictDetails,
              }
            : item
        );
        queueRef.current = next;
        return next;
      });
      await syncItem(id, options);
    },
    [syncItem]
  );

  const retryAll = useCallback(
    async (retryOpts?: { includeConflicts?: boolean }): Promise<void> => {
      const retryable = queueRef.current.filter((item) => {
        if (item.status === "pending") return true;
        if (item.status === "failed") return true;
        if (retryOpts?.includeConflicts && item.status === "conflict") return true;
        return false;
      });

      // Reset failed items back to pending before retrying
      setQueue((prev) => {
        const next = prev.map((item) =>
          item.status === "failed" || (retryOpts?.includeConflicts && item.status === "conflict")
            ? { ...item, status: "pending" as const, retryCount: 0, error: undefined, conflictDetails: undefined }
            : item
        );
        queueRef.current = next;
        return next;
      });

      await Promise.allSettled(retryable.map((item) => syncItem(item.id, { force: retryOpts?.includeConflicts })));
    },
    [syncItem]
  );

  // ── Conflict resolution ───────────────────────────────────────────────────

  const resolveConflict = useCallback(
    async (id: string, resolution: ConflictResolution): Promise<void> => {
      const item = queueRef.current.find((i) => i.id === id);
      if (!item) return;

      if (resolution.action === "use_server") {
        // Accept server version: mark item resolved/synced without overwriting server
        setQueue((prev) => {
          const next = prev.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "synced" as const,
                  error: undefined,
                  failureType: undefined,
                  conflictDetails: undefined,
                }
              : i
          );
          queueRef.current = next;
          return next;
        });
        return;
      }

      if (resolution.action === "use_local") {
        // Force retry using local user input
        await retryItem(id, { force: true });
        return;
      }

      if (resolution.action === "merge") {
        // Update payload with merged user input and sync
        updatePayload(id, resolution.mergedPayload, resolution.newLabel);
        await syncItem(id, { force: true });
      }
    },
    [retryItem, syncItem, updatePayload]
  );

  // ── Derived state ─────────────────────────────────────────────────────────

  const pendingItems = queue.filter((i) => i.status === "pending");
  const syncingItems = queue.filter((i) => i.status === "syncing");
  const failedItems = queue.filter((i) => i.status === "failed");
  const conflictItems = queue.filter((i) => i.status === "conflict");
  const syncedItems = queue.filter((i) => i.status === "synced");

  return {
    queue,
    pendingItems,
    syncingItems,
    failedItems,
    conflictItems,
    syncedItems,
    pendingCount: pendingItems.length + failedItems.length + conflictItems.length,
    conflictCount: conflictItems.length,
    isSyncing: syncingItems.length > 0,
    isOnline,
    enqueue,
    remove,
    discard,
    retryAll,
    retryItem,
    resolveConflict,
    updatePayload,
    clearSynced,
    clearAll,
  };
}
