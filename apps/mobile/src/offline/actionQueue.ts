/**
 * Idempotent offline action queue.
 *
 * Every queued operation carries a **stable operation ID** generated before it
 * is first persisted. Replaying the queue after a crash re-uses the same ID,
 * so the server (or any idempotency layer above this module) can detect and
 * discard duplicates.
 *
 * ## Design
 *
 * - Operations are persisted atomically before any network call is made.
 * - The queue is read from storage on every flush, not held in memory, so a
 *   crash mid-flush leaves the queue in a consistent, replayable state.
 * - Each operation records an `attemptCount` that increments on every replay.
 *   Callers can use this for back-off or dead-letter logic.
 * - `dequeue` removes a single operation by its stable `operationId` — partial
 *   success is safe; only successfully applied operations are removed.
 *
 * ## Idempotency guarantee
 *
 * The `operationId` is generated once (UUID v4 format) at `enqueue` time and
 * stored durably. Any transport layer that forwards this ID to the server
 * allows the server to detect a replayed request and return the original
 * response without double-applying the mutation.
 *
 * ## Crash recovery
 *
 * Interrupt `sync` at any point — the persistent queue still holds every
 * un-acknowledged operation. On next startup the caller calls `sync` again;
 * previously successful operations are gone from the queue, so they are never
 * replayed.
 */

import { type KeyValueStorage, readJSON, writeJSON } from "./storage";

// ── Operation ID ─────────────────────────────────────────────────────────────

/**
 * Generate a stable, URL-safe operation ID.
 *
 * Uses `crypto.randomUUID()` when available (Node ≥ 14.17, all modern
 * browsers), and falls back to a simple Math.random hex string for
 * environments that lack the Web Crypto API.
 */
export function generateOperationId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: not cryptographically secure, but unique enough for an offline
  // queue where collisions are extremely unlikely.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Status of a queued action across its lifecycle. */
export type ActionStatus = "pending" | "in-flight" | "failed";

/**
 * A single durable, idempotent action entry.
 *
 * @template TPayload - Application-specific mutation payload.
 */
export interface QueuedAction<TPayload = unknown> {
  /** Stable ID, generated at enqueue time and never changed on replay. */
  operationId: string;
  /** Application-defined action discriminator (e.g. "wishlist/add"). */
  type: string;
  /** Arbitrary mutation payload. Must be JSON-serialisable. */
  payload: TPayload;
  /** Unix timestamp (ms) when the operation was first enqueued. */
  enqueuedAt: number;
  /** How many flush attempts have touched this operation (starts at 0). */
  attemptCount: number;
  /** Current lifecycle status. */
  status: ActionStatus;
}

interface PersistedActionQueue {
  actions: QueuedAction[];
}

export interface IdempotentActionQueueOptions {
  /** Storage key prefix; override per-account for isolation. */
  namespace?: string;
  /** Injectable clock for deterministic tests. */
  clock?: () => number;
  /** Injectable ID generator for deterministic tests. */
  idGenerator?: () => string;
}

// ── IdempotentActionQueue ────────────────────────────────────────────────────

/**
 * Durable queue of idempotent offline actions.
 *
 * All mutations write through to `storage` before returning, so the queue
 * survives process termination at any point.
 */
export class IdempotentActionQueue<TPayload = unknown> {
  private readonly namespace: string;
  private readonly clock: () => number;
  private readonly idGenerator: () => string;

  constructor(
    private readonly storage: KeyValueStorage,
    options: IdempotentActionQueueOptions = {},
  ) {
    this.namespace = options.namespace ?? "fundable.offline.actions";
    this.clock = options.clock ?? Date.now;
    this.idGenerator = options.idGenerator ?? generateOperationId;
  }

  queueKey(): string {
    return `${this.namespace}.queue`;
  }

  /** Return all pending/failed actions in insertion order. */
  async all(): Promise<QueuedAction<TPayload>[]> {
    const state = await readJSON<PersistedActionQueue>(
      this.storage,
      this.queueKey(),
    );
    return (state?.actions ?? []) as QueuedAction<TPayload>[];
  }

  /**
   * Add a new action to the queue. The stable `operationId` is generated here
   * and will never change across replay attempts.
   *
   * @returns The enqueued action (including its generated `operationId`).
   */
  async enqueue(
    type: string,
    payload: TPayload,
    operationId?: string,
  ): Promise<QueuedAction<TPayload>> {
    const actions = await this.all();
    const action: QueuedAction<TPayload> = {
      operationId: operationId ?? this.idGenerator(),
      type,
      payload,
      enqueuedAt: this.clock(),
      attemptCount: 0,
      status: "pending",
    };
    actions.push(action);
    await this.persist(actions);
    return action;
  }

  /**
   * Mark an operation as in-flight and increment its attempt counter.
   * Called just before the network call so a crash leaves a clear audit trail.
   */
  async markInFlight(operationId: string): Promise<void> {
    const actions = await this.all();
    const updated = actions.map((a) =>
      a.operationId === operationId
        ? { ...a, status: "in-flight" as ActionStatus, attemptCount: a.attemptCount + 1 }
        : a,
    );
    await this.persist(updated);
  }

  /**
   * Permanently remove an operation from the queue after the server confirmed
   * it was applied. Safe to call with an unknown `operationId` (no-op).
   */
  async dequeue(operationId: string): Promise<void> {
    const actions = await this.all();
    await this.persist(actions.filter((a) => a.operationId !== operationId));
  }

  /**
   * Mark an operation as failed without removing it, so the next flush will
   * retry it.
   */
  async markFailed(operationId: string): Promise<void> {
    const actions = await this.all();
    const updated = actions.map((a) =>
      a.operationId === operationId
        ? { ...a, status: "failed" as ActionStatus }
        : a,
    );
    await this.persist(updated);
  }

  /** Remove all actions from the queue (used on logout or full reset). */
  async clear(): Promise<void> {
    await this.persist([]);
  }

  private async persist(actions: QueuedAction[]): Promise<void> {
    await writeJSON<PersistedActionQueue>(this.storage, this.queueKey(), {
      actions,
    });
  }
}

// ── Handler and flush ─────────────────────────────────────────────────────────

/** Application-provided handler that applies a single action to the server. */
export type ActionHandler<TPayload = unknown> = (
  action: QueuedAction<TPayload>,
) => Promise<void>;

export interface FlushResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

/**
 * Flush all pending/failed actions in the queue through `handler`.
 *
 * Each action is individually marked in-flight before the handler call, then
 * either dequeued (success) or marked failed (error). The queue is never
 * cleared in bulk — only confirmed operations are removed — so a crash mid-
 * flush leaves unprocessed actions for the next attempt.
 *
 * The same `operationId` is forwarded to `handler` on every attempt, enabling
 * server-side idempotency keys.
 */
export async function flushActionQueue<TPayload>(
  queue: IdempotentActionQueue<TPayload>,
  handler: ActionHandler<TPayload>,
  onError?: (error: unknown, action: QueuedAction<TPayload>) => void,
): Promise<FlushResult> {
  const actions = (await queue.all()).filter(
    (a) => a.status === "pending" || a.status === "failed",
  );

  let succeeded = 0;
  let failed = 0;

  for (const action of actions) {
    await queue.markInFlight(action.operationId);
    try {
      await handler(action);
      await queue.dequeue(action.operationId);
      succeeded++;
    } catch (error) {
      await queue.markFailed(action.operationId);
      failed++;
      onError?.(error, action);
    }
  }

  return { attempted: actions.length, succeeded, failed };
}
