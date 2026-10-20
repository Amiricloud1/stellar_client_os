"use client";

/**
 * SyncQueueBanner — Offline-first PWA sync status banner (Issues #528, #73)
 *
 * Sticky notification banner that appears when there are pending evidence
 * uploads or conflict resolutions in the sync queue. Follows the same
 * visual pattern as the existing offline status banner in AppProvider.
 *
 * States:
 *   - Hidden when queue is empty and device is online
 *   - Amber (warning)  — offline with pending items
 *   - Purple (active)  — online, syncing items now
 *   - Red (error)      — items failed after all retries
 *   - Orange (alert)   — items with conflicts or stale server versions (Issue #73)
 *   - Green (success)  — all items synced (auto-dismisses after 4s)
 *
 * Accessibility:
 *   - role="status" aria-live="polite" for dynamic updates
 *   - aria-atomic="true" so screen readers announce the full message
 *   - Focus-visible ring on interactive buttons
 *   - All icons are aria-hidden with adjacent visible text
 */

import React, { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SyncQueueItem, SyncQueueState } from "@/hooks/use-sync-queue";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncQueueBannerProps {
  /** Full sync queue state from useSyncQueue. */
  syncQueue: Pick<
    SyncQueueState,
    | "pendingCount"
    | "isSyncing"
    | "isOnline"
    | "failedItems"
    | "syncedItems"
    | "pendingItems"
    | "syncingItems"
    | "retryAll"
  > & {
    conflictItems?: SyncQueueItem[];
    conflictCount?: number;
  };
  /** Called when the user clicks "View all" — opens the action drawer. */
  onOpenDrawer?: () => void;
  /** Additional className applied to the root element. */
  className?: string;
}

type BannerVariant = "offline" | "syncing" | "failed" | "success" | "pending" | "conflict";

// ── Variant config ─────────────────────────────────────────────────────────────

const VARIANT_STYLES: Record<
  BannerVariant,
  { banner: string; icon: React.ElementType; label: (counts: BannerCounts) => string }
> = {
  offline: {
    banner: "border-amber-700 bg-amber-950 text-amber-100",
    icon: CloudOff,
    label: ({ pending }) =>
      `You're offline — ${pending} upload${pending !== 1 ? "s" : ""} pending sync`,
  },
  pending: {
    banner: "border-purple-700 bg-purple-950 text-purple-100",
    icon: UploadCloud,
    label: ({ pending }) =>
      `${pending} upload${pending !== 1 ? "s" : ""} waiting to sync`,
  },
  syncing: {
    banner: "border-fundable-violet bg-fundable-deep-purple text-purple-100",
    icon: Loader2,
    label: ({ syncing }) =>
      `Syncing ${syncing} upload${syncing !== 1 ? "s" : ""}…`,
  },
  failed: {
    banner: "border-red-700 bg-red-950 text-red-100",
    icon: AlertCircle,
    label: ({ failed }) =>
      `${failed} upload${failed !== 1 ? "s" : ""} failed to sync`,
  },
  conflict: {
    banner: "border-orange-600 bg-orange-950 text-orange-100",
    icon: AlertTriangle,
    label: ({ conflicts }) =>
      `${conflicts} upload${conflicts !== 1 ? "s" : ""} have conflicts — action required`,
  },
  success: {
    banner: "border-emerald-700 bg-emerald-950 text-emerald-100",
    icon: CheckCircle2,
    label: ({ synced }) =>
      `${synced} upload${synced !== 1 ? "s" : ""} synced successfully`,
  },
};

interface BannerCounts {
  pending: number;
  syncing: number;
  failed: number;
  synced: number;
  conflicts: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SyncQueueBanner({
  syncQueue,
  onOpenDrawer,
  className,
}: SyncQueueBannerProps) {
  const {
    pendingCount,
    isSyncing,
    isOnline,
    failedItems,
    syncedItems,
    pendingItems,
    syncingItems,
    conflictItems = [],
    conflictCount = conflictItems.length,
    retryAll,
  } = syncQueue;

  const [showSuccess, setShowSuccess] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const prevSyncedCount = React.useRef(0);

  // Flash "success" state briefly when all pending items are synced
  useEffect(() => {
    if (
      syncedItems.length > 0 &&
      syncedItems.length > prevSyncedCount.current &&
      pendingCount === 0 &&
      !isSyncing
    ) {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), 4_000);
      return () => clearTimeout(timer);
    }
    prevSyncedCount.current = syncedItems.length;
  }, [syncedItems.length, pendingCount, isSyncing]);

  // Determine which variant to show
  const variant: BannerVariant = showSuccess
    ? "success"
    : conflictCount > 0 && !isSyncing
    ? "conflict"
    : failedItems.length > 0 && !isSyncing
    ? "failed"
    : isSyncing
    ? "syncing"
    : !isOnline && pendingCount > 0
    ? "offline"
    : "pending";

  const shouldShow =
    showSuccess ||
    isSyncing ||
    pendingCount > 0 ||
    failedItems.length > 0 ||
    conflictCount > 0;

  if (!shouldShow) return null;

  const counts: BannerCounts = {
    pending: pendingItems.length,
    syncing: syncingItems.length,
    failed: failedItems.length,
    synced: syncedItems.length,
    conflicts: conflictCount,
  };

  const config = VARIANT_STYLES[variant];
  const Icon = config.icon;

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await retryAll();
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="sync-queue-banner"
      data-variant={variant}
      className={cn(
        "sticky top-0 z-50 flex w-full max-w-full flex-wrap sm:flex-nowrap min-h-11 items-center justify-between gap-2 overflow-x-hidden border-b px-3 sm:px-4 py-2 text-sm",
        "transition-colors duration-300",
        config.banner,
        className
      )}
    >
      {/* Left: icon + message */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0",
            variant === "syncing" && "animate-spin"
          )}
        />
        <span className="truncate">{config.label(counts)}</span>
      </div>

      {/* Right: action buttons */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Retry button — shown when offline has pending items, or items failed */}
        {(variant === "offline" || variant === "failed" || variant === "pending") &&
          isOnline && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={isRetrying || isSyncing}
              aria-label="Retry syncing pending uploads"
              className={cn(
                "flex min-h-8 items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium",
                "transition-all duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                "disabled:cursor-not-allowed disabled:opacity-50",
                variant === "failed"
                  ? "bg-red-800 hover:bg-red-700 active:bg-red-900"
                  : "bg-amber-800 hover:bg-amber-700 active:bg-amber-900 text-amber-100"
              )}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn("h-3 w-3", (isRetrying || isSyncing) && "animate-spin")}
              />
              <span>{isRetrying ? "Retrying…" : "Retry"}</span>
            </button>
          )}

        {/* View all button — opens action drawer */}
        {onOpenDrawer && pendingCount + failedItems.length > 0 && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={isSyncing || isRetrying || !isOnline}
            aria-label="Retry syncing pending uploads"
            className={cn(
              "min-h-8 rounded-sm px-2.5 py-1 text-xs font-medium underline-offset-2",
              "hover:underline focus-visible:outline-none focus-visible:ring-2",
              "focus-visible:ring-white/50 transition-all duration-150"
            )}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn("h-3 w-3", (isSyncing || isRetrying) && "animate-spin")}
            />
            <span>{isSyncing || isRetrying ? "Syncing…" : "Retry"}</span>
          </button>
        )}

        {/* View all button — opens the action drawer */}
        {onOpenDrawer && (
          <button
            type="button"
            onClick={onOpenDrawer}
            aria-label={variant === "conflict" ? "Review and resolve sync conflicts" : "View pending sync items"}
            className={cn(
              "min-h-8 min-w-8 inline-flex items-center justify-center rounded-sm p-1 opacity-70 hover:opacity-100",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
              "transition-colors duration-150 text-white/90"
            )}
          >
            {variant === "conflict" ? "Resolve" : "View all"}
          </button>
        )}
      </div>
    </div>
  );
}

export default SyncQueueBanner;
