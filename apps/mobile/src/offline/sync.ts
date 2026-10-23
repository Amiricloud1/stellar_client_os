/**
 * Wishlist sync queue + reconnect orchestration.
 *
 * Offline wishlist mutations are queued durably. The queue applies a
 * deterministic merge: for any campaign only the latest operation survives, so
 * flushing can never produce duplicate/server-conflicting writes. On reconnect
 * the engine drains the queue through the {@link WishlistRemote}.
 */

import { type KeyValueStorage, readJSON, writeJSON } from "./storage";
import type { OfflineWishlist } from "./wishlist";
import {
  classifySyncError,
  type SyncTelemetry,
  type SyncTelemetryEventMap,
} from "./telemetry";

export type WishlistOperationType = "add" | "remove";

export interface WishlistOperation {
  type: WishlistOperationType;
  campaignId: string;
  queuedAt: number;
  /**
   * Number of failed flush attempts for this operation. Additive and optional
   * so queues persisted by older builds (without the field) remain readable —
   * a missing value is treated as `0`.
   */
  attempts?: number;
}

interface PersistedQueue {
  operations: WishlistOperation[];
}

export interface WishlistSyncQueueOptions {
  namespace?: string;
  clock?: () => number;
}

/**
 * Durable queue of pending wishlist operations.
 *
 * `enqueue` collapses any earlier operation for the same campaign — the final
 * desired state wins — which gives a deterministic, duplicate-free flush.
 */
export class WishlistSyncQueue {
  private readonly namespace: string;
  private readonly clock: () => number;

  constructor(
    private readonly storage: KeyValueStorage,
    options: WishlistSyncQueueOptions = {},
  ) {
    this.namespace = options.namespace ?? "fundable.offline.wishlist.queue";
    this.clock = options.clock ?? Date.now;
  }

  key(): string {
    return `${this.namespace}.pending`;
  }

  async pending(): Promise<WishlistOperation[]> {
    const state = await readJSON<PersistedQueue>(this.storage, this.key());
    return state?.operations ?? [];
  }

  async enqueue(
    type: WishlistOperationType,
    campaignId: string,
  ): Promise<WishlistOperation[]> {
    const operations = await this.pending();
    const operation: WishlistOperation = {
      type,
      campaignId,
      queuedAt: this.clock(),
    };
    // Drop any operation for the same campaign: only the latest state matters.
    const merged = operations.filter((op) => op.campaignId !== campaignId);
    merged.push(operation);
    await this.persist(merged);
    return merged;
  }

  /** Remove the given campaign ids from the queue. */
  async markSynced(campaignIds: readonly string[]): Promise<void> {
    if (campaignIds.length === 0) return;
    const sent = new Set(campaignIds);
    const operations = (await this.pending()).filter(
      (op) => !sent.has(op.campaignId),
    );
    await this.persist(operations);
  }

  /**
   * Increment the attempt counter of the given campaign ids. Operations stay
   * queued; the counter feeds retry telemetry and never affects flush order.
   */
  async markFailed(campaignIds: readonly string[]): Promise<void> {
    if (campaignIds.length === 0) return;
    const failed = new Set(campaignIds);
    const operations = (await this.pending()).map((op) =>
      failed.has(op.campaignId)
        ? { ...op, attempts: (op.attempts ?? 0) + 1 }
        : op,
    );
    await this.persist(operations);
  }

  async clear(): Promise<void> {
    await this.persist([]);
  }

  private async persist(operations: WishlistOperation[]): Promise<void> {
    await writeJSON<PersistedQueue>(this.storage, this.key(), { operations });
  }
}

/** Transport that applies a wishlist mutation to the server. */
export interface WishlistRemote {
  add(campaignId: string): Promise<void>;
  remove(campaignId: string): Promise<void>;
}

export interface WishlistSyncEngineOptions {
  wishlist: OfflineWishlist;
  queue: WishlistSyncQueue;
  remote: WishlistRemote;
  onSyncError?: (error: unknown, operation: WishlistOperation) => void;
  /**
   * Optional privacy-safe telemetry sink. When omitted the engine records
   * nothing, preserving the pre-telemetry behavior.
   */
  telemetry?: SyncTelemetry;
  /** Injectable clock used for flush latency. Defaults to `Date.now`. */
  clock?: () => number;
}

export interface SyncResult {
  attempted: number;
  synced: number;
  failed: number;
}

/**
 * Coordinates local wishlist mutations with the queued server sync.
 */
export class WishlistSyncEngine {
  private readonly wishlist: OfflineWishlist;
  private readonly queue: WishlistSyncQueue;
  private readonly remote: WishlistRemote;
  private readonly onSyncError?: (
    error: unknown,
    operation: WishlistOperation,
  ) => void;
  private readonly telemetry?: SyncTelemetry;
  private readonly clock: () => number;

  constructor(options: WishlistSyncEngineOptions) {
    this.wishlist = options.wishlist;
    this.queue = options.queue;
    this.remote = options.remote;
    this.onSyncError = options.onSyncError;
    this.telemetry = options.telemetry;
    this.clock = options.clock ?? Date.now;
  }

  /** Persist locally and queue an add. Returns whether it was newly added. */
  async add(campaignId: string): Promise<boolean> {
    const change = await this.wishlist.add(campaignId);
    await this.queue.enqueue("add", campaignId);
    return change.added;
  }

  /** Persist locally and queue a remove. Returns whether it was present. */
  async remove(campaignId: string): Promise<boolean> {
    const existed = await this.wishlist.has(campaignId);
    await this.wishlist.remove(campaignId);
    await this.queue.enqueue("remove", campaignId);
    return existed;
  }

  /**
   * Flush pending operations. Successfully applied operations are dropped from
   * the queue; failures stay queued for the next reconnect. Order is preserved
   * and each campaign is written at most once.
   */
  async sync(): Promise<SyncResult> {
    const startedAt = this.clock();
    const operations = await this.queue.pending();
    const retried = operations.filter((op) => (op.attempts ?? 0) > 0).length;
    const synced: string[] = [];
    const failedIds: string[] = [];

    for (const operation of operations) {
      try {
        if (operation.type === "add") {
          await this.remote.add(operation.campaignId);
        } else {
          await this.remote.remove(operation.campaignId);
        }
        synced.push(operation.campaignId);
      } catch (error) {
        failedIds.push(operation.campaignId);
        this.record("failure", {
          failureClass: classifySyncError(error),
          attempt: (operation.attempts ?? 0) + 1,
        });
        this.onSyncError?.(error, operation);
      }
    }

    await this.queue.markFailed(failedIds);
    await this.queue.markSynced(synced);
    this.record("flush", {
      queueDepth: operations.length,
      synced: synced.length,
      failed: failedIds.length,
      latencyMs: Math.max(0, this.clock() - startedAt),
      retries: retried,
    });
    return {
      attempted: operations.length,
      synced: synced.length,
      failed: failedIds.length,
    };
  }

  /**
   * Record into the telemetry sink without letting a faulty sink break the
   * flush — telemetry is best-effort by design.
   */
  private record<E extends keyof SyncTelemetryEventMap>(
    event: E,
    metrics: SyncTelemetryEventMap[E],
  ): void {
    try {
      this.telemetry?.record(event, metrics);
    } catch {
      /* telemetry must never break sync */
    }
  }
}

// ── Connectivity ─────────────────────────────────────────────────────────────

export type ConnectivityListener = (online: boolean) => void;

export interface ConnectivitySource {
  subscribe(listener: ConnectivityListener): () => void;
}

export interface ConnectivityMonitor extends ConnectivitySource {
  isOnline(): boolean;
  /** Update state from a host-provided signal (e.g. NetInfo / socket). */
  setOnline(online: boolean): void;
}

/**
 * Wraps an optional {@link ConnectivitySource} and exposes an imperative
 * `setOnline` so native signals (NetInfo, websocket lifecycle) can drive it.
 */
export function createConnectivityMonitor(
  source?: ConnectivitySource,
): ConnectivityMonitor {
  const listeners = new Set<ConnectivityListener>();
  let online = false;

  const emit = (next: boolean): void => {
    if (next === online) return;
    online = next;
    for (const listener of listeners) listener(online);
  };

  if (source) {
    source.subscribe((next) => emit(next));
  }

  return {
    isOnline: () => online,
    setOnline: emit,
    subscribe(listener: ConnectivityListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A manually-driven connectivity source, handy for tests and socket wiring. */
export function createManualConnectivitySource(
  initial = false,
): ConnectivitySource & { set(online: boolean): void } {
  const listeners = new Set<ConnectivityListener>();
  let online = initial;
  return {
    set(next: boolean): void {
      online = next;
      for (const listener of listeners) listener(online);
    },
    subscribe(listener: ConnectivityListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface ReconnectSyncOptions {
  engine: WishlistSyncEngine;
  /** Called after a successful flush when the connection returns. */
  onReconnect?: () => void | Promise<void>;
}

/**
 * Subscribe to connectivity transitions and flush the wishlist queue whenever
 * the connection is restored (offline → online only).
 *
 * @returns an unsubscribe function.
 */
export function bindSyncOnReconnect(
  monitor: ConnectivityMonitor,
  options: ReconnectSyncOptions,
): () => void {
  return monitor.subscribe((online) => {
    if (!online) return;
    void options
      .engine
      .sync()
      .then(() => options.onReconnect?.())
      .catch(() => {
        /* failures remain queued for the next reconnect */
      });
  });
}
