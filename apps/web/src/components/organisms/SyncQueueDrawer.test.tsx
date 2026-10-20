// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SyncQueueDrawer } from "./SyncQueueDrawer";
import type { SyncQueueItem, SyncQueueState } from "@/hooks/use-sync-queue";

function createMockSyncQueue(overrides: Partial<SyncQueueState> = {}): SyncQueueState {
  return {
    queue: [],
    pendingItems: [],
    syncingItems: [],
    failedItems: [],
    conflictItems: [],
    syncedItems: [],
    pendingCount: 0,
    conflictCount: 0,
    isSyncing: false,
    isOnline: true,
    enqueue: vi.fn(),
    remove: vi.fn(),
    discard: vi.fn(),
    retryAll: vi.fn().mockResolvedValue(undefined),
    retryItem: vi.fn().mockResolvedValue(undefined),
    resolveConflict: vi.fn().mockResolvedValue(undefined),
    updatePayload: vi.fn(),
    clearSynced: vi.fn(),
    clearAll: vi.fn(),
    ...overrides,
  };
}

describe("SyncQueueDrawer — Conflicts and Recovery (Issue #73)", () => {
  it("renders empty state when queue is empty", () => {
    const syncQueue = createMockSyncQueue();
    render(<SyncQueueDrawer open={true} onClose={vi.fn()} syncQueue={syncQueue} />);

    expect(screen.getByText(/All uploads are synced/i)).toBeTruthy();
  });

  it("renders conflict badge, details, and resolution actions", () => {
    const conflictItem: SyncQueueItem = {
      id: "item-conflict-1",
      label: "Planting Record #42",
      description: "Batch 42 at site A",
      status: "conflict",
      enqueuedAt: Date.now(),
      retryCount: 1,
      error: "409 Version mismatch",
      failureType: "conflict",
      payload: { trees: 100, species: "Oak" },
      conflictDetails: {
        reason: "Server version was updated by another planter",
        conflictedAt: Date.now(),
        serverVersion: { trees: 90 },
      },
    };

    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    const syncQueue = createMockSyncQueue({
      queue: [conflictItem],
      conflictItems: [conflictItem],
      conflictCount: 1,
      pendingCount: 1,
      resolveConflict,
      discard,
    });

    render(<SyncQueueDrawer open={true} onClose={vi.fn()} syncQueue={syncQueue} />);

    expect(screen.getByText("Planting Record #42")).toBeTruthy();
    expect(screen.getByText(/Conflict: Data collision/i)).toBeTruthy();
    expect(screen.getByText("409 Version mismatch")).toBeTruthy();

    // Verify all 4 conflict resolution actions are rendered
    const keepLocalBtn = screen.getByRole("button", { name: /keep local/i });
    const acceptServerBtn = screen.getByRole("button", { name: /accept server/i });
    const editBtn = screen.getByRole("button", { name: /edit user input/i });
    const discardBtn = screen.getByRole("button", { name: /discard conflicting item/i });

    expect(keepLocalBtn).toBeTruthy();
    expect(acceptServerBtn).toBeTruthy();
    expect(editBtn).toBeTruthy();
    expect(discardBtn).toBeTruthy();

    // Click Keep Local
    fireEvent.click(keepLocalBtn);
    expect(resolveConflict).toHaveBeenCalledWith("item-conflict-1", { action: "use_local" });

    // Click Accept Server
    fireEvent.click(acceptServerBtn);
    expect(resolveConflict).toHaveBeenCalledWith("item-conflict-1", { action: "use_server" });

    // Click Discard
    fireEvent.click(discardBtn);
    expect(discard).toHaveBeenCalledWith("item-conflict-1");
  });

  it("allows inline payload editing without losing user input on conflict", async () => {
    const conflictItem: SyncQueueItem = {
      id: "item-edit-1",
      label: "Evidence Note",
      status: "conflict",
      enqueuedAt: Date.now(),
      retryCount: 1,
      error: "409 Conflict",
      failureType: "conflict",
      payload: { note: "Initial note" },
    };

    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const syncQueue = createMockSyncQueue({
      queue: [conflictItem],
      conflictItems: [conflictItem],
      conflictCount: 1,
      pendingCount: 1,
      resolveConflict,
    });

    render(<SyncQueueDrawer open={true} onClose={vi.fn()} syncQueue={syncQueue} />);

    const editBtn = screen.getByRole("button", { name: /edit user input/i });
    act(() => { fireEvent.click(editBtn); });

    // Form inputs should appear with initial user input preserved
    const textarea = screen.getByPlaceholderText("{ ...user input }") as HTMLTextAreaElement;
    expect(textarea.value).toContain("Initial note");

    act(() => {
      fireEvent.change(textarea, { target: { value: JSON.stringify({ note: "Merged note" }) } });
    });

    const mergeBtn = screen.getByRole("button", { name: /save merged payload/i });
    await act(async () => {
      fireEvent.click(mergeBtn);
    });

    expect(resolveConflict).toHaveBeenCalledWith("item-edit-1", {
      action: "merge",
      mergedPayload: { note: "Merged note" },
      newLabel: "Evidence Note",
    });
  });

  it("handles duplicate failure with discard and force retry actions", () => {
    const duplicateItem: SyncQueueItem = {
      id: "item-dup-1",
      label: "Donation Tx",
      status: "failed",
      enqueuedAt: Date.now(),
      retryCount: 1,
      error: "Transaction duplicate: already submitted",
      failureType: "duplicate",
      payload: { txHash: "0x1234" },
    };

    const retryItem = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    const syncQueue = createMockSyncQueue({
      queue: [duplicateItem],
      failedItems: [duplicateItem],
      pendingCount: 1,
      retryItem,
      discard,
    });

    render(<SyncQueueDrawer open={true} onClose={vi.fn()} syncQueue={syncQueue} />);

    expect(screen.getByText(/Duplicate submission already confirmed/i)).toBeTruthy();

    const forceRetryBtn = screen.getByRole("button", { name: /force retry/i });
    const discardBtn = screen.getByRole("button", { name: /discard failed item/i });

    fireEvent.click(forceRetryBtn);
    expect(retryItem).toHaveBeenCalledWith("item-dup-1", { force: true });

    fireEvent.click(discardBtn);
    expect(discard).toHaveBeenCalledWith("item-dup-1");
  });

  it("handles permanent failures with discard and edit actions", () => {
    const permanentItem: SyncQueueItem = {
      id: "item-perm-1",
      label: "Invalid Batch",
      status: "failed",
      enqueuedAt: Date.now(),
      retryCount: 1,
      error: "400 Invalid coordinates",
      failureType: "permanent",
      payload: { lat: 999, lng: 999 },
    };

    const updatePayload = vi.fn();
    const discard = vi.fn();
    const syncQueue = createMockSyncQueue({
      queue: [permanentItem],
      failedItems: [permanentItem],
      pendingCount: 1,
      updatePayload,
      discard,
    });

    render(<SyncQueueDrawer open={true} onClose={vi.fn()} syncQueue={syncQueue} />);

    expect(screen.getByText(/Permanent error: manual edit required/i)).toBeTruthy();

    const editBtn = screen.getByRole("button", { name: /edit payload/i });
    act(() => { fireEvent.click(editBtn); });

    const textarea = screen.getByPlaceholderText("{ ...user input }");
    act(() => {
      fireEvent.change(textarea, { target: { value: JSON.stringify({ lat: 10, lng: 20 }) } });
    });

    const saveBtn = screen.getByRole("button", { name: /save input changes/i });
    act(() => { fireEvent.click(saveBtn); });

    expect(updatePayload).toHaveBeenCalledWith(
      "item-perm-1",
      { lat: 10, lng: 20 },
      "Invalid Batch"
    );
  });
});
