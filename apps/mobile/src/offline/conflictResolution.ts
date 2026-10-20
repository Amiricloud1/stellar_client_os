/**
 * Server-authoritative offline conflict resolution.
 *
 * The server is the single source of truth. When a sync flush returns a server
 * response, this module computes the correct local state by comparing the
 * local version against the server's version using a set of entity-specific
 * merge strategies.
 *
 * ## Merge strategies
 *
 * | Entity           | Strategy                                                   |
 * |------------------|------------------------------------------------------------|
 * | Campaign detail  | Server-wins: stale local edits are discarded.             |
 * | Wishlist         | Server-wins with local-add merge: server additions are    |
 * |                  | preserved; local additions not yet on the server survive; |
 * |                  | server removals always win.                                |
 * | Pending actions  | Permission-change detection: if the server reports a      |
 * |                  | 403/permission error the action is permanently failed.    |
 *
 * ## Resolution events
 *
 * `resolveConflict` returns a {@link ConflictResolution} describing what
 * happened and whether data was discarded. Callers can surface this in the UI.
 *
 * ## Partial sync recovery
 *
 * `mergePartialSync` handles the case where only a subset of a batch was
 * applied (e.g. network cut after 3 of 5 operations). It computes which
 * campaign IDs are safe to mark synced and which must remain queued.
 */

import type { CampaignSummary } from "./types";

// ── Conflict resolution types ─────────────────────────────────────────────────

/** The outcome of a merge decision. */
export type ResolutionOutcome =
  | "server-wins"        // Server data completely replaces local data.
  | "local-wins"         // Local data is kept (not used in current strategies).
  | "merged"             // Both sides contributed to the result.
  | "permission-denied"  // Server rejected due to auth/permission change.
  | "deleted";           // Server reported the entity no longer exists.

export interface ConflictResolution<T> {
  outcome: ResolutionOutcome;
  /** The data that should be persisted locally after resolution. */
  resolved: T;
  /**
   * Human-readable description of what happened, suitable for logging or
   * surfacing as a non-blocking toast in the UI.
   */
  description: string;
  /** Whether any local-only data was discarded during resolution. */
  localDataDiscarded: boolean;
}

// ── Campaign conflict resolution ──────────────────────────────────────────────

/**
 * Server-wins merge for campaign data.
 *
 * The server's version always replaces the local cache. `localDataDiscarded`
 * is true when the local version differs from the server version, so the UI
 * can optionally inform the user that stale data was overwritten.
 */
export function resolveCampaignConflict<T extends { id: string }>(
  local: T | null,
  server: T | null,
): ConflictResolution<T | null> {
  // Entity was deleted on the server.
  if (server === null) {
    return {
      outcome: "deleted",
      resolved: null,
      description: `Campaign ${local?.id ?? "unknown"} was deleted on the server.`,
      localDataDiscarded: local !== null,
    };
  }

  // No local version — nothing to conflict.
  if (local === null) {
    return {
      outcome: "server-wins",
      resolved: server,
      description: "No local version; using server data.",
      localDataDiscarded: false,
    };
  }

  const differs = JSON.stringify(local) !== JSON.stringify(server);
  return {
    outcome: "server-wins",
    resolved: server,
    description: differs
      ? `Campaign ${server.id}: local stale edit discarded; server version applied.`
      : `Campaign ${server.id}: local and server versions match.`,
    localDataDiscarded: differs,
  };
}

// ── Wishlist conflict resolution ──────────────────────────────────────────────

export interface WishlistConflictInput {
  /**
   * Campaign IDs in the local wishlist (may include un-synced additions).
   */
  localIds: readonly string[];
  /**
   * Authoritative wishlist returned by the server after sync.
   */
  serverIds: readonly string[];
  /**
   * IDs of campaigns that the local client added but have NOT yet been
   * confirmed by the server (i.e. they are still queued).
   */
  pendingLocalAdditions: readonly string[];
}

/**
 * Merge-strategy: server-wins for existing items; unsynced local additions
 * are preserved until the server confirms or rejects them.
 *
 * Server removals always win: if the server deleted an item the client
 * previously had, that deletion is respected even if the client hasn't heard
 * about it yet (e.g. permission revoked, campaign deleted).
 */
export function resolveWishlistConflict(
  input: WishlistConflictInput,
): ConflictResolution<string[]> {
  const serverSet = new Set(input.serverIds);
  const pendingSet = new Set(input.pendingLocalAdditions);
  const localSet = new Set(input.localIds);

  // Start with everything the server confirmed.
  const merged = new Set(input.serverIds);

  // Keep unsynced local additions that the server has not explicitly removed.
  // "Not on the server" could mean the add hasn't been flushed yet — so we
  // preserve those. We do NOT re-add items that are in localSet but not in
  // pendingSet; those are stale local data that the server already knows about.
  for (const id of pendingSet) {
    if (!serverSet.has(id)) {
      merged.add(id);
    }
  }

  // Detect discarded items: local items that are not in merged result.
  const discarded = [...localSet].filter((id) => !merged.has(id));

  const description =
    discarded.length > 0
      ? `Wishlist: ${discarded.length} stale local item(s) removed by server.`
      : "Wishlist: local and server versions reconciled without data loss.";

  return {
    outcome: "merged",
    resolved: [...merged],
    description,
    localDataDiscarded: discarded.length > 0,
  };
}

// ── Permission change detection ───────────────────────────────────────────────

export interface ServerError {
  /** HTTP status or application error code. */
  status: number;
  message?: string;
}

/**
 * Classify a server error as a permanent failure (permission denied, entity
 * gone) vs. a transient failure (network timeout, 5xx) that should be retried.
 */
export function classifyServerError(error: ServerError): {
  permanent: boolean;
  outcome: ResolutionOutcome;
  description: string;
} {
  if (error.status === 403 || error.status === 401) {
    return {
      permanent: true,
      outcome: "permission-denied",
      description: `Server rejected operation (HTTP ${error.status}): ${error.message ?? "permission denied"}. Action permanently failed.`,
    };
  }
  if (error.status === 404) {
    return {
      permanent: true,
      outcome: "deleted",
      description: `Resource not found (HTTP 404): ${error.message ?? "entity deleted"}. Action permanently failed.`,
    };
  }
  // 5xx, network errors, etc. are transient — keep in queue.
  return {
    permanent: false,
    outcome: "server-wins",
    description: `Transient error (HTTP ${error.status}): will retry on next sync.`,
  };
}

// ── Partial sync recovery ─────────────────────────────────────────────────────

export interface PartialSyncResult {
  /** Campaign IDs that the server confirmed as applied. */
  confirmedIds: readonly string[];
  /** Campaign IDs where the server reported a permanent failure. */
  permanentlyFailedIds: readonly string[];
  /** Campaign IDs that should remain queued for the next attempt. */
  retryIds: readonly string[];
}

export interface SyncAttemptOutcome {
  campaignId: string;
  success: boolean;
  error?: ServerError;
}

/**
 * Partition the results of a partial sync attempt into confirmed, permanently
 * failed, and retry categories.
 *
 * Callers use `confirmedIds` to call `queue.markSynced` and
 * `permanentlyFailedIds` to call `queue.markSynced` (drop) or surface an
 * error to the user. `retryIds` are left in the queue untouched.
 */
export function mergePartialSync(
  outcomes: readonly SyncAttemptOutcome[],
): PartialSyncResult {
  const confirmedIds: string[] = [];
  const permanentlyFailedIds: string[] = [];
  const retryIds: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.success) {
      confirmedIds.push(outcome.campaignId);
    } else if (outcome.error) {
      const classification = classifyServerError(outcome.error);
      if (classification.permanent) {
        permanentlyFailedIds.push(outcome.campaignId);
      } else {
        retryIds.push(outcome.campaignId);
      }
    } else {
      // Unknown failure — treat as transient.
      retryIds.push(outcome.campaignId);
    }
  }

  return { confirmedIds, permanentlyFailedIds, retryIds };
}

// ── Campaign list reconciliation ──────────────────────────────────────────────

/**
 * Reconcile a full campaign list from the server against a locally-cached
 * list. Campaigns present locally but absent from the server response are
 * treated as deleted. The server list is authoritative for all field values.
 *
 * @returns The merged list (server-authoritative) and the ids of any locally-
 *          cached campaigns that the server no longer returns.
 */
export function reconcileCampaignList(
  local: readonly CampaignSummary[],
  server: readonly CampaignSummary[],
): { list: CampaignSummary[]; removedIds: string[] } {
  const serverMap = new Map(server.map((c) => [c.id, c]));
  const localIds = new Set(local.map((c) => c.id));
  const serverIds = new Set(server.map((c) => c.id));

  const removedIds = [...localIds].filter((id) => !serverIds.has(id));

  return {
    list: [...serverMap.values()],
    removedIds,
  };
}
