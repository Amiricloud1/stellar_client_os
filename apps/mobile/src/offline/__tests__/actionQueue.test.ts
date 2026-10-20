import { describe, expect, it, vi } from "vitest";
import {
  IdempotentActionQueue,
  flushActionQueue,
  generateOperationId,
  type ActionHandler,
} from "../actionQueue";
import { createMemoryStorage } from "../storage";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let idCounter = 0;
function deterministicId(): string {
  return `op-${++idCounter}`;
}

function makeQueue(storage = createMemoryStorage()) {
  idCounter = 0;
  return new IdempotentActionQueue(storage, {
    clock: () => 1_000,
    idGenerator: deterministicId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// generateOperationId
// ─────────────────────────────────────────────────────────────────────────────

describe("generateOperationId", () => {
  it("produces a non-empty string", () => {
    expect(generateOperationId()).toBeTruthy();
  });

  it("generates unique IDs across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, generateOperationId));
    expect(ids.size).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IdempotentActionQueue — basic operations
// ─────────────────────────────────────────────────────────────────────────────

describe("IdempotentActionQueue", () => {
  it("enqueues an action with a stable operationId and pending status", async () => {
    const queue = makeQueue();
    const action = await queue.enqueue("wishlist/add", { campaignId: "c1" });

    expect(action.operationId).toBe("op-1");
    expect(action.type).toBe("wishlist/add");
    expect(action.payload).toEqual({ campaignId: "c1" });
    expect(action.status).toBe("pending");
    expect(action.attemptCount).toBe(0);
    expect(action.enqueuedAt).toBe(1_000);
  });

  it("persists across storage boundary (simulates app restart)", async () => {
    const storage = createMemoryStorage();
    const queue = makeQueue(storage);
    await queue.enqueue("wishlist/add", { campaignId: "c1" });
    await queue.enqueue("wishlist/remove", { campaignId: "c2" });

    // New instance over the same storage.
    const reloaded = new IdempotentActionQueue(storage);
    const actions = await reloaded.all();
    expect(actions).toHaveLength(2);
    expect(actions[0]!.type).toBe("wishlist/add");
    expect(actions[1]!.type).toBe("wishlist/remove");
  });

  it("preserves the original operationId when a custom one is supplied", async () => {
    const queue = makeQueue();
    const action = await queue.enqueue("any", {}, "my-stable-id");
    expect(action.operationId).toBe("my-stable-id");
  });

  it("markInFlight increments attemptCount and sets status", async () => {
    const queue = makeQueue();
    const action = await queue.enqueue("t", {});
    await queue.markInFlight(action.operationId);

    const [updated] = await queue.all();
    expect(updated!.status).toBe("in-flight");
    expect(updated!.attemptCount).toBe(1);
  });

  it("dequeue removes only the specified operation", async () => {
    const queue = makeQueue();
    const a1 = await queue.enqueue("t", { campaignId: "c1" });
    await queue.enqueue("t", { campaignId: "c2" });

    await queue.dequeue(a1.operationId);

    const remaining = await queue.all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.payload).toEqual({ campaignId: "c2" });
  });

  it("dequeue is a no-op for an unknown operationId", async () => {
    const queue = makeQueue();
    await queue.enqueue("t", {});
    await queue.dequeue("unknown-id");
    expect(await queue.all()).toHaveLength(1);
  });

  it("markFailed sets status to failed without removing", async () => {
    const queue = makeQueue();
    const action = await queue.enqueue("t", {});
    await queue.markFailed(action.operationId);

    const [updated] = await queue.all();
    expect(updated!.status).toBe("failed");
  });

  it("clear removes all actions", async () => {
    const queue = makeQueue();
    await queue.enqueue("t", {});
    await queue.enqueue("t", {});
    await queue.clear();
    expect(await queue.all()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// flushActionQueue — idempotency across crashes
// ─────────────────────────────────────────────────────────────────────────────

describe("flushActionQueue", () => {
  it("flushes all pending actions and removes them from the queue", async () => {
    const queue = makeQueue();
    await queue.enqueue("wishlist/add", { campaignId: "c1" });
    await queue.enqueue("wishlist/add", { campaignId: "c2" });

    const applied: string[] = [];
    const handler: ActionHandler = vi.fn(async (action) => {
      applied.push(action.operationId);
    });

    const result = await flushActionQueue(queue, handler);

    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(applied).toEqual(["op-1", "op-2"]);
    expect(await queue.all()).toHaveLength(0);
  });

  it("stable operationId is forwarded to handler on retry after crash", async () => {
    const storage = createMemoryStorage();

    // ── Simulated crash: enqueue but never flush ──
    const before = new IdempotentActionQueue(storage, {
      clock: () => 1_000,
      idGenerator: () => "stable-op-id",
    });
    await before.enqueue("wishlist/add", { campaignId: "c1" });

    // Crash happens here (process restarts, same storage).

    const after = new IdempotentActionQueue(storage);
    const seenIds: string[] = [];
    const handler: ActionHandler = vi.fn(async (action) => {
      seenIds.push(action.operationId);
    });

    await flushActionQueue(after, handler);

    // The handler must receive the original stable ID, not a new one.
    expect(seenIds).toEqual(["stable-op-id"]);
  });

  it("failed actions stay queued; successful ones are removed", async () => {
    const queue = makeQueue();
    const a1 = await queue.enqueue("t", { campaignId: "c1" });
    await queue.enqueue("t", { campaignId: "c2" });

    const handler: ActionHandler = vi.fn(async (action) => {
      if (action.operationId === a1.operationId) {
        throw new Error("network error");
      }
    });
    const onError = vi.fn();

    const result = await flushActionQueue(queue, handler, onError);

    expect(result).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
    expect(onError).toHaveBeenCalledTimes(1);

    const remaining = await queue.all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.operationId).toBe(a1.operationId);
    expect(remaining[0]!.status).toBe("failed");
  });

  it("retries previously-failed actions on next flush", async () => {
    const queue = makeQueue();
    await queue.enqueue("t", { campaignId: "c1" });

    let callCount = 0;
    const handler: ActionHandler = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("first attempt fails");
    });

    const first = await flushActionQueue(queue, handler);
    expect(first).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    expect(await queue.all()).toHaveLength(1);

    const second = await flushActionQueue(queue, handler);
    expect(second).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await queue.all()).toHaveLength(0);
  });

  it("does not re-run in-flight or already-processed operations", async () => {
    const queue = makeQueue();
    const a = await queue.enqueue("t", {});

    // Manually mark as in-flight (crash mid-flush simulation).
    await queue.markInFlight(a.operationId);

    const handler = vi.fn(async () => {});
    // A subsequent flush should NOT pick up the in-flight operation
    // (it's not pending/failed).
    const result = await flushActionQueue(queue, handler);
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("increments attemptCount on each replay", async () => {
    const queue = makeQueue();
    await queue.enqueue("t", {});

    const handler: ActionHandler = vi.fn(async () => {
      throw new Error("always fails");
    });

    await flushActionQueue(queue, handler);
    await flushActionQueue(queue, handler);

    const [action] = await queue.all();
    // markInFlight is called twice (once per flush).
    expect(action!.attemptCount).toBe(2);
  });

  it("handles an empty queue without error", async () => {
    const queue = makeQueue();
    const result = await flushActionQueue(queue, vi.fn());
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });
});
