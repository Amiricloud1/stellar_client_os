// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncQueue } from "./use-sync-queue";

// ── localStorage mock ─────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, "localStorage", { value: localStorageMock });

function setOnlineStatus(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: online,
  });
}

beforeEach(() => {
  localStorageMock.clear();
  setOnlineStatus(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setOnlineStatus(true);
});

// ── enqueue ───────────────────────────────────────────────────────────────────

describe("useSyncQueue — enqueue", () => {
  it("adds an item to the queue with pending status", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_enqueue" })
    );
    act(() => {
      result.current.enqueue({ label: "Photo 1" });
    });
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].status).toBe("pending");
    expect(result.current.queue[0].label).toBe("Photo 1");
  });

  it("assigns a unique id to each item", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_ids" })
    );
    act(() => {
      result.current.enqueue({ label: "A" });
      result.current.enqueue({ label: "B" });
    });
    const ids = result.current.queue.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("sets retryCount to 0 on initial enqueue", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_retry_init" })
    );
    act(() => { result.current.enqueue({ label: "C" }); });
    expect(result.current.queue[0].retryCount).toBe(0);
  });

  it("increments pendingCount correctly", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_pending_count" })
    );
    expect(result.current.pendingCount).toBe(0);
    act(() => { result.current.enqueue({ label: "X" }); });
    expect(result.current.pendingCount).toBe(1);
    act(() => { result.current.enqueue({ label: "Y" }); });
    expect(result.current.pendingCount).toBe(2);
  });

  it("preserves user payload upon enqueue (Issue #73)", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_payload" })
    );
    act(() => {
      result.current.enqueue({
        label: "Evidence Upload",
        payload: { treeId: "tree-42", notes: "Planted in sector 3" },
      });
    });
    expect(result.current.queue[0].payload).toEqual({
      treeId: "tree-42",
      notes: "Planted in sector 3",
    });
  });
});

// ── remove / discard ──────────────────────────────────────────────────────────

describe("useSyncQueue — remove and discard", () => {
  it("removes an item by id", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_remove" })
    );
    act(() => { result.current.enqueue({ label: "Del me" }); });
    const id = result.current.queue[0].id;
    act(() => { result.current.remove(id); });
    expect(result.current.queue).toHaveLength(0);
  });

  it("discard removes an item safely (Issue #73)", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_discard" })
    );
    act(() => { result.current.enqueue({ label: "Discard me" }); });
    const id = result.current.queue[0].id;
    act(() => { result.current.discard(id); });
    expect(result.current.queue).toHaveLength(0);
  });

  it("leaves other items untouched", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_remove_other" })
    );
    act(() => {
      result.current.enqueue({ label: "Keep" });
      result.current.enqueue({ label: "Remove" });
    });
    const toRemoveId = result.current.queue[1].id;
    act(() => { result.current.remove(toRemoveId); });
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].label).toBe("Keep");
  });
});

// ── clearSynced / clearAll ────────────────────────────────────────────────────

describe("useSyncQueue — clear operations", () => {
  it("clearSynced removes only synced items", async () => {
    const onSync = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_clear_synced", onSync })
    );
    act(() => {
      result.current.enqueue({ label: "Sync me" });
      result.current.enqueue({ label: "Keep pending" });
    });
    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() =>
      expect(result.current.queue.find((i) => i.id === id)?.status).toBe("synced")
    );
    act(() => { result.current.clearSynced(); });
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].label).toBe("Keep pending");
  });

  it("clearAll empties the queue", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_clear_all" })
    );
    act(() => {
      result.current.enqueue({ label: "A" });
      result.current.enqueue({ label: "B" });
    });
    expect(result.current.queue).toHaveLength(2);
    act(() => { result.current.clearAll(); });
    expect(result.current.queue).toHaveLength(0);
  });
});

// ── online / offline ──────────────────────────────────────────────────────────

describe("useSyncQueue — online/offline", () => {
  it("reflects offline status when navigator.onLine is false", () => {
    setOnlineStatus(false);
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_offline" })
    );
    expect(result.current.isOnline).toBe(false);
  });

  it("updates isOnline when connectivity changes", () => {
    setOnlineStatus(false);
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_online_change" })
    );
    expect(result.current.isOnline).toBe(false);
    act(() => {
      setOnlineStatus(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current.isOnline).toBe(true);
  });
});

// ── sync and failure classification ───────────────────────────────────────────

describe("useSyncQueue — sync and failure classification", () => {
  it("marks item as synced on successful onSync", async () => {
    const onSync = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_sync_success", onSync })
    );
    act(() => { result.current.enqueue({ label: "Upload 1" }); });
    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() =>
      expect(result.current.queue[0]?.status).toBe("synced")
    );
  });

  it("marks item as failed when onSync throws transient error and maxRetries exceeded", async () => {
    const onSync = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const { result } = renderHook(() =>
      useSyncQueue({
        storageKey: "test_queue_sync_fail",
        onSync,
        maxRetries: 1,
      })
    );
    act(() => { result.current.enqueue({ label: "Bad upload" }); });
    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() => {
      const item = result.current.queue.find((i) => i.id === id);
      expect(item?.status).toBe("failed");
      expect(item?.failureType).toBe("transient");
    });
  });

  it("immediately marks permanent failure without wasting retries (Issue #73)", async () => {
    const onSync = vi.fn().mockRejectedValue(new Error("400: Invalid input parameter"));
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_perm_fail", onSync, maxRetries: 3 })
    );
    act(() => { result.current.enqueue({ label: "Bad payload", payload: { bad: true } }); });
    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() => {
      const item = result.current.queue.find((i) => i.id === id);
      expect(item?.status).toBe("failed");
      expect(item?.failureType).toBe("permanent");
      expect(item?.payload).toEqual({ bad: true });
    });
  });

  it("handles duplicate failure classification and preserves payload (Issue #73)", async () => {
    const onSync = vi.fn().mockRejectedValue(new Error("Transaction duplicate: already submitted"));
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_queue_dup_fail", onSync })
    );
    act(() => { result.current.enqueue({ label: "Duplicate Tx", payload: { txHash: "abc" } }); });
    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() => {
      const item = result.current.queue.find((i) => i.id === id);
      expect(item?.status).toBe("failed");
      expect(item?.failureType).toBe("duplicate");
      expect(item?.payload).toEqual({ txHash: "abc" });
    });
  });

  it("handles stale / conflict failure classification and enters conflict state (Issue #73)", async () => {
    const onSync = vi.fn().mockRejectedValue({
      message: "Version mismatch: conflict with server state",
      failureType: "conflict",
      conflictDetails: { serverVersion: { trees: 10 }, reason: "Stale cache" },
    });
    const onSyncConflict = vi.fn();
    const { result } = renderHook(() =>
      useSyncQueue({
        storageKey: "test_queue_conflict_fail",
        onSync,
        onSyncConflict,
      })
    );
    act(() => {
      result.current.enqueue({
        label: "Update Trees",
        payload: { trees: 15 },
      });
    });
    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() => {
      const item = result.current.queue.find((i) => i.id === id);
      expect(item?.status).toBe("conflict");
      expect(item?.failureType).toBe("conflict");
      expect(item?.conflictDetails?.reason).toBe("Stale cache");
      expect(item?.payload).toEqual({ trees: 15 });
      expect(result.current.conflictCount).toBe(1);
    });
    expect(onSyncConflict).toHaveBeenCalledOnce();
  });
});

// ── Conflict Resolution Actions (Issue #73) ───────────────────────────────────

describe("useSyncQueue — Conflict Resolution Actions (Issue #73)", () => {
  it("resolves conflict with 'use_local' by forcing resync with local input", async () => {
    let callCount = 0;
    const onSync = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("409 conflict: server updated");
      }
      return true;
    });

    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_resolve_local", onSync })
    );

    act(() => {
      result.current.enqueue({
        label: "Planting Record",
        payload: { planterId: "P-101", count: 50 },
      });
    });

    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() => expect(result.current.queue[0]?.status).toBe("conflict"));

    // User chooses to keep local changes
    await act(async () => {
      await result.current.resolveConflict(id, { action: "use_local" });
    });

    await waitFor(() => {
      const item = result.current.queue.find((i) => i.id === id);
      expect(item?.status).toBe("synced");
      expect(item?.payload).toEqual({ planterId: "P-101", count: 50 });
      expect(result.current.conflictCount).toBe(0);
    });
  });

  it("resolves conflict with 'use_server' by accepting server state", async () => {
    const onSync = vi.fn().mockRejectedValue(new Error("409 conflict"));
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_resolve_server", onSync })
    );

    act(() => {
      result.current.enqueue({
        label: "Tree update",
        payload: { count: 20 },
      });
    });

    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() => expect(result.current.queue[0]?.status).toBe("conflict"));

    // User chooses to accept server
    await act(async () => {
      await result.current.resolveConflict(id, { action: "use_server" });
    });

    await waitFor(() => {
      const item = result.current.queue.find((i) => i.id === id);
      expect(item?.status).toBe("synced");
      expect(result.current.conflictCount).toBe(0);
    });
  });

  it("resolves conflict with 'merge' by updating user input without data loss", async () => {
    let attempts = 0;
    const onSync = vi.fn().mockImplementation(async (item) => {
      attempts++;
      if (attempts === 1) {
        throw new Error("409 conflict");
      }
      // Verify merged payload is passed to onSync
      expect(item.payload).toEqual({ count: 25, mergedWithServer: true });
      return true;
    });

    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_resolve_merge", onSync })
    );

    act(() => {
      result.current.enqueue({
        label: "Initial trees",
        payload: { count: 20 },
      });
    });

    const id = result.current.queue[0].id;
    await act(async () => { await result.current.retryItem(id); });
    await waitFor(() => expect(result.current.queue[0]?.status).toBe("conflict"));

    // User updates merged input
    await act(async () => {
      await result.current.resolveConflict(id, {
        action: "merge",
        mergedPayload: { count: 25, mergedWithServer: true },
        newLabel: "Merged trees",
      });
    });

    await waitFor(() => {
      const item = result.current.queue.find((i) => i.id === id);
      expect(item?.status).toBe("synced");
      expect(item?.payload).toEqual({ count: 25, mergedWithServer: true });
      expect(item?.label).toBe("Merged trees");
    });
  });

  it("updatePayload allows editing user input before retrying", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_update_payload" })
    );

    act(() => {
      result.current.enqueue({
        label: "Draft evidence",
        payload: { title: "Draft 1" },
      });
    });

    const id = result.current.queue[0].id;
    act(() => {
      result.current.updatePayload(id, { title: "Draft 2 — Revised" }, "Revised evidence");
    });

    const item = result.current.queue.find((i) => i.id === id);
    expect(item?.payload).toEqual({ title: "Draft 2 — Revised" });
    expect(item?.label).toBe("Revised evidence");
    expect(item?.status).toBe("pending");
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("useSyncQueue — persistence", () => {
  it("saves the queue to localStorage on change", () => {
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_persist_save" })
    );
    act(() => { result.current.enqueue({ label: "Saved" }); });
    const raw = localStorageMock.getItem("test_persist_save");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed[0].label).toBe("Saved");
  });

  it("loads the queue from localStorage on mount", () => {
    const initial = [
      { id: "1", label: "Existing", status: "pending", enqueuedAt: 1000, retryCount: 0 },
    ];
    localStorageMock.setItem("test_persist_load", JSON.stringify(initial));
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_persist_load" })
    );
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].label).toBe("Existing");
  });

  it("resets 'syncing' items to 'pending' on mount (crash recovery)", () => {
    const initial = [
      { id: "1", label: "Crashed mid-sync", status: "syncing", enqueuedAt: 1000, retryCount: 1 },
    ];
    localStorageMock.setItem("test_crash_recovery", JSON.stringify(initial));
    const { result } = renderHook(() =>
      useSyncQueue({ storageKey: "test_crash_recovery" })
    );
    expect(result.current.queue[0].status).toBe("pending");
  });
});
