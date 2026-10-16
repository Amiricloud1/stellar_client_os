"use client";

/**
 * SyncQueueDrawer — Action drawer listing pending sync items and conflicts (Issues #528, #73)
 *
 * Slides up from the bottom on mobile / in from the right on desktop,
 * showing all items in the sync queue with their status and actions:
 *   - Retry transient failures or forced sync
 *   - Discard unneeded or duplicate items
 *   - Conflict-resolution actions for stale/conflict items (Keep local, Accept server, Edit & merge)
 *   - Payload editing so user input is never lost
 *
 * Accessibility:
 *   - Drawer is a dialog (role="dialog") with a labelled title
 *   - Each status badge uses aria-label for screen readers
 *   - Empty state has a descriptive paragraph
 *   - All action buttons have accessible labels and meet WCAG 2.2 AA target size (>=24x24px)
 */

import React, { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Edit2,
  GitMerge,
  Loader2,
  RefreshCw,
  Server,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import type { ConflictResolution, SyncQueueItem, SyncQueueState } from "@/hooks/use-sync-queue";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncQueueDrawerProps {
  open: boolean;
  onClose: () => void;
  syncQueue: Pick<
    SyncQueueState,
    | "queue"
    | "pendingCount"
    | "isSyncing"
    | "isOnline"
    | "retryAll"
    | "retryItem"
    | "remove"
    | "clearSynced"
    | "clearAll"
  > & {
    conflictItems?: SyncQueueItem[];
    conflictCount?: number;
    discard?: (id: string) => void;
    resolveConflict?: (id: string, resolution: ConflictResolution) => Promise<void>;
    updatePayload?: (id: string, newPayload: unknown, newLabel?: string) => void;
  };
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SyncQueueItem["status"] }) {
  const config = {
    pending: {
      icon: Clock,
      label: "Pending",
      className: "bg-amber-900/50 text-amber-300 border-amber-700/50",
      spin: false,
    },
    syncing: {
      icon: Loader2,
      label: "Syncing",
      className: "bg-purple-900/50 text-purple-300 border-purple-700/50",
      spin: true,
    },
    synced: {
      icon: CheckCircle2,
      label: "Synced",
      className: "bg-emerald-900/50 text-emerald-300 border-emerald-700/50",
      spin: false,
    },
    conflict: {
      icon: AlertTriangle,
      label: "Conflict",
      className: "bg-orange-900/60 text-orange-200 border-orange-600/60",
      spin: false,
    },
    failed: {
      icon: AlertCircle,
      label: "Failed",
      className: "bg-red-900/50 text-red-300 border-red-700/50",
      spin: false,
    },
  }[status];

  const Icon = config.icon;

  return (
    <span
      aria-label={`Status: ${config.label}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        config.className
      )}
    >
      <Icon aria-hidden="true" className={cn("h-3 w-3", config.spin && "animate-spin")} />
      {config.label}
    </span>
  );
}

// ── Queue item row ────────────────────────────────────────────────────────────

function QueueItemRow({
  item,
  onRetry,
  onRemove,
  onDiscard,
  onResolveConflict,
  onUpdatePayload,
  isOnline,
}: {
  item: SyncQueueItem;
  onRetry: (id: string, options?: { force?: boolean }) => void;
  onRemove: (id: string) => void;
  onDiscard?: (id: string) => void;
  onResolveConflict?: (id: string, resolution: ConflictResolution) => Promise<void>;
  onUpdatePayload?: (id: string, newPayload: unknown, newLabel?: string) => void;
  isOnline: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedPayloadText, setEditedPayloadText] = useState(() =>
    item.payload ? JSON.stringify(item.payload, null, 2) : ""
  );
  const [editedLabel, setEditedLabel] = useState(item.label);

  const isConflict = item.status === "conflict" || item.failureType === "conflict" || item.failureType === "stale";
  const isDuplicate = item.failureType === "duplicate";
  const isPermanent = item.failureType === "permanent";

  const handleSaveEdit = () => {
    let parsed: unknown = editedPayloadText;
    try {
      parsed = JSON.parse(editedPayloadText);
    } catch {
      // Keep as string if not valid JSON
    }
    onUpdatePayload?.(item.id, parsed, editedLabel.trim() || item.label);
    setIsEditing(false);
  };

  const handleMergeResolve = async () => {
    let parsed: unknown = editedPayloadText;
    try {
      parsed = JSON.parse(editedPayloadText);
    } catch {
      // Keep as string
    }
    await onResolveConflict?.(item.id, {
      action: "merge",
      mergedPayload: parsed,
      newLabel: editedLabel.trim() || item.label,
    });
    setIsEditing(false);
  };

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        "border-white/10 bg-white/5 hover:bg-white/[0.07]",
        isConflict && "border-orange-500/40 bg-orange-950/10"
      )}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <UploadCloud
          aria-hidden="true"
          className={cn(
            "mt-0.5 h-5 w-5 shrink-0",
            item.status === "synced"
              ? "text-emerald-400"
              : isConflict
              ? "text-orange-400"
              : item.status === "failed"
              ? "text-red-400"
              : item.status === "syncing"
              ? "text-purple-400"
              : "text-amber-400"
          )}
        />

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-sm font-medium text-white">{item.label}</p>
            <StatusBadge status={item.status} />
          </div>

          {item.description && (
            <p className="mt-0.5 truncate text-xs text-white/50">{item.description}</p>
          )}

          {/* Error / failure notice */}
          {item.error && (
            <div
              className={cn(
                "mt-1.5 rounded p-2 text-xs",
                isConflict
                  ? "border border-orange-500/30 bg-orange-500/10 text-orange-200"
                  : isDuplicate
                  ? "border border-amber-500/30 bg-amber-500/10 text-amber-200"
                  : "border border-red-500/30 bg-red-500/10 text-red-300"
              )}
              role="alert"
            >
              <div className="flex items-center gap-1 font-semibold">
                {isConflict ? (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Conflict: {item.failureType === "stale" ? "Stale server state" : "Data collision"}</span>
                  </>
                ) : isDuplicate ? (
                  <>
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Duplicate submission already confirmed</span>
                  </>
                ) : isPermanent ? (
                  <>
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Permanent error: manual edit required</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Transient error</span>
                  </>
                )}
              </div>
              <p className="mt-0.5 text-xs opacity-90">{item.error}</p>
              {item.conflictDetails?.reason && item.conflictDetails.reason !== item.error && (
                <p className="mt-0.5 text-xs opacity-75">{item.conflictDetails.reason}</p>
              )}
            </div>
          )}

          <div className="mt-1.5 flex items-center gap-2">
            <p className="text-xs text-white/40">
              {new Date(item.enqueuedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
            {item.retryCount > 0 && (
              <p className="text-xs text-white/40">
                · {item.retryCount} retr{item.retryCount === 1 ? "y" : "ies"}
              </p>
            )}
          </div>
        </div>

        {/* Header Right Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {item.status !== "syncing" && (
            <button
              type="button"
              onClick={() => (onDiscard ? onDiscard(item.id) : onRemove(item.id))}
              aria-label={`Discard ${item.label}`}
              className={cn(
                "min-h-[28px] min-w-[28px] rounded-md p-1.5 text-white/40 hover:text-red-400",
                "hover:bg-red-400/10 focus-visible:outline-none focus-visible:ring-2",
                "focus-visible:ring-red-400/30 transition-all duration-150"
              )}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Conflict Resolution Toolbar (Issue #73) */}
      {isConflict && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-white/10 pt-2">
          {/* Action 1: Keep local */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onResolveConflict?.(item.id, { action: "use_local" })}
            className="h-7 text-xs border-orange-500/40 bg-orange-500/10 text-orange-200 hover:bg-orange-500/20"
            aria-label={`Keep local version for ${item.label}`}
          >
            <UploadCloud className="mr-1 h-3 w-3" aria-hidden="true" />
            Keep local
          </Button>

          {/* Action 2: Accept server */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onResolveConflict?.(item.id, { action: "use_server" })}
            className="h-7 text-xs border-white/20 bg-white/5 text-white/80 hover:bg-white/10"
            aria-label={`Accept server version for ${item.label}`}
          >
            <Server className="mr-1 h-3 w-3" aria-hidden="true" />
            Accept server
          </Button>

          {/* Action 3: Edit input without losing data */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setIsEditing(!isEditing)}
            className="h-7 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            aria-label={`Edit user input for ${item.label}`}
          >
            <Edit2 className="mr-1 h-3 w-3" aria-hidden="true" />
            {isEditing ? "Cancel edit" : "Edit input"}
          </Button>

          {/* Action 4: Discard */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => (onDiscard ? onDiscard(item.id) : onRemove(item.id))}
            className="h-7 text-xs text-red-300 hover:bg-red-500/10 hover:text-red-200 ml-auto"
            aria-label={`Discard conflicting item ${item.label}`}
          >
            Discard
          </Button>
        </div>
      )}

      {/* Non-conflict failed or duplicate actions */}
      {!isConflict && item.status === "failed" && (
        <div className="mt-1 flex flex-wrap gap-2 border-t border-white/10 pt-2">
          {isOnline && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onRetry(item.id, { force: true })}
              className="h-7 text-xs border-white/20 bg-white/5 text-white/90 hover:bg-white/10"
              aria-label={isDuplicate ? `Force retry ${item.label}` : `Retry ${item.label}`}
            >
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
              {isDuplicate ? "Force retry" : "Retry now"}
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setIsEditing(!isEditing)}
            className="h-7 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            aria-label={`Edit payload for ${item.label}`}
          >
            <Edit2 className="mr-1 h-3 w-3" aria-hidden="true" />
            {isEditing ? "Cancel edit" : "Edit payload"}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => (onDiscard ? onDiscard(item.id) : onRemove(item.id))}
            className="h-7 text-xs text-red-300 hover:bg-red-500/10 hover:text-red-200 ml-auto"
            aria-label={`Discard failed item ${item.label}`}
          >
            Discard
          </Button>
        </div>
      )}

      {/* Inline payload editor ensuring no user input is lost */}
      {isEditing && (
        <div className="mt-2 rounded border border-white/15 bg-black/40 p-2.5">
          <label className="block text-xs font-semibold text-white/80">
            Edit Item Label
          </label>
          <input
            type="text"
            value={editedLabel}
            onChange={(e) => setEditedLabel(e.target.value)}
            className="mt-1 w-full rounded bg-white/10 px-2 py-1 text-xs text-white border border-white/20 focus:outline-none focus:ring-1 focus:ring-fundable-purple-2"
          />

          <label className="mt-2 block text-xs font-semibold text-white/80">
            Payload / User Input (JSON or text)
          </label>
          <textarea
            rows={3}
            value={editedPayloadText}
            onChange={(e) => setEditedPayloadText(e.target.value)}
            className="mt-1 w-full rounded bg-white/10 p-2 font-mono text-xs text-white border border-white/20 focus:outline-none focus:ring-1 focus:ring-fundable-purple-2"
            placeholder="{ ...user input }"
          />

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setIsEditing(false)}
              className="h-6 text-xs text-white/60 hover:text-white"
            >
              Cancel
            </Button>

            {isConflict ? (
              <Button
                type="button"
                size="sm"
                variant="gradient"
                onClick={handleMergeResolve}
                className="h-6 text-xs"
                aria-label="Save merged payload and retry sync"
              >
                <GitMerge className="mr-1 h-3 w-3" aria-hidden="true" />
                Merge & Retry
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="gradient"
                onClick={handleSaveEdit}
                className="h-6 text-xs"
                aria-label="Save input changes"
              >
                <Check className="mr-1 h-3 w-3" aria-hidden="true" />
                Save Changes
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ── Main drawer component ─────────────────────────────────────────────────────

export function SyncQueueDrawer({ open, onClose, syncQueue }: SyncQueueDrawerProps) {
  const {
    queue,
    pendingCount,
    isSyncing,
    isOnline,
    conflictItems = [],
    conflictCount = conflictItems.length,
    retryAll,
    retryItem,
    remove,
    discard = remove,
    resolveConflict,
    updatePayload,
    clearSynced,
    clearAll,
  } = syncQueue;

  const hasSynced = queue.some((i) => i.status === "synced");
  const hasRetryable = queue.some(
    (i) => i.status === "pending" || i.status === "failed" || i.status === "conflict"
  );

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        className={cn(
          "max-h-[85dvh] rounded-t-2xl border-white/10",
          "bg-fundable-dark text-white",
          "flex flex-col gap-0 p-0",
          "sm:side-right sm:max-h-full sm:rounded-none sm:rounded-l-2xl",
          "sm:w-[460px] sm:max-w-[460px]"
        )}
        aria-label="Sync queue"
      >
        {/* Header */}
        <SheetHeader className="border-b border-white/10 px-4 py-4">
          <div className="flex items-center gap-2">
            <UploadCloud aria-hidden="true" className="h-5 w-5 text-fundable-purple-2" />
            <SheetTitle className="text-base text-white">Sync Queue</SheetTitle>
            {pendingCount > 0 && (
              <span
                aria-label={`${pendingCount} pending`}
                className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-fundable-purple-2 px-1.5 text-xs font-bold text-white"
              >
                {pendingCount}
              </span>
            )}
            {conflictCount > 0 && (
              <span
                aria-label={`${conflictCount} conflicts`}
                className="flex h-5 items-center justify-center rounded-full bg-orange-600 px-2 text-xs font-bold text-white"
              >
                {conflictCount} conflict{conflictCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <SheetDescription className="text-sm text-white/50">
            {queue.length === 0
              ? "No uploads in queue."
              : isOnline
              ? `${pendingCount} pending · ${queue.filter((i) => i.status === "synced").length} synced`
              : `Offline — ${pendingCount} upload${pendingCount !== 1 ? "s" : ""} waiting`}
          </SheetDescription>
        </SheetHeader>

        {/* Queue list */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <CheckCircle2 aria-hidden="true" className="h-10 w-10 text-emerald-500/50" />
              <p className="text-sm text-white/50">
                All uploads are synced. Nothing pending.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5" aria-label="Sync queue items">
              {queue.map((item) => (
                <QueueItemRow
                  key={item.id}
                  item={item}
                  onRetry={retryItem}
                  onRemove={remove}
                  onDiscard={discard}
                  onResolveConflict={resolveConflict}
                  onUpdatePayload={updatePayload}
                  isOnline={isOnline}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Footer actions */}
        {queue.length > 0 && (
          <SheetFooter className="border-t border-white/10 px-4 py-3">
            <div className="flex w-full flex-wrap gap-2">
              {hasRetryable && isOnline && (
                <Button
                  variant="gradient"
                  size="sm"
                  onClick={() => retryAll({ includeConflicts: false })}
                  disabled={isSyncing}
                  className="flex-1"
                  aria-label="Retry all pending and failed uploads"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn("h-4 w-4", isSyncing && "animate-spin")}
                  />
                  {isSyncing ? "Syncing…" : "Retry all"}
                </Button>
              )}
              {hasSynced && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearSynced}
                  className="flex-1 border-white/10 bg-transparent text-white/70 hover:bg-white/10 hover:text-white"
                  aria-label="Clear synced uploads from queue"
                >
                  Clear synced
                </Button>
              )}
              {queue.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearAll}
                  className="text-white/30 hover:bg-red-500/10 hover:text-red-400"
                  aria-label="Clear all items from queue"
                >
                  Clear all
                </Button>
              )}
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default SyncQueueDrawer;
