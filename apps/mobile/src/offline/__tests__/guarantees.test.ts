import { describe, expect, it, vi } from "vitest";
import { CampaignCache } from "../campaignCache";
import { createMemoryStorage } from "../storage";
import { WishlistSyncEngine, WishlistSyncQueue, type WishlistRemote } from "../sync";
import { OfflineWishlist } from "../wishlist";
import type { CampaignSummary } from "../types";

/**
 * Pins the OFFLINE.md sync guarantees (G1/G2/G4/G5/G6):
 * key scoping, freshness boundaries, last-write-wins collapse,
 * partial-failure retention, and per-entry deletion.
 * Deterministic: injectable clock, memory storage, mocked remote.
 */
const summary = (id: string): CampaignSummary => ({
  id,
  name: `Campaign ${id}`,
  status: "active",
  goalAmount: "1000",
  raisedAmount: "10",
  treeCount: 5,
  sponsorCount: 1,
});

describe("offline sync guarantees", () => {
  it("G1: cache keys are namespace-scoped (list + detail + wishlist + queue)", async () => {
    const storage = createMemoryStorage();
    const cache = new CampaignCache(storage, { clock: () => 1 });
    const wishlist = new OfflineWishlist(storage);
    const queue = new WishlistSyncQueue(storage);

    await cache.saveList([summary("a")]);
    await cache.saveDetail("a", {
      ...summary("a"),
      sponsors: [],
      verificationProgress: 10,
    });
    await wishlist.add("a");
    await queue.enqueue("add", "a");

    expect(cache.listKey()).toBe("fundable.offline.cache.campaigns.list");
    expect(cache.detailKey("a")).toBe("fundable.offline.cache.campaigns.detail.a");
    expect(wishlist.key()).toBe("fundable.offline.wishlist.ids");
    expect(queue.key()).toBe("fundable.offline.wishlist.queue.pending");

    const keys = await storage.getAllKeys?.();
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
  });

  it("G2: isFresh boundary — fresh at exactly maxAge, stale after, null is stale", () => {
    const cache = new CampaignCache(createMemoryStorage(), { clock: () => 10_000 });

    expect(cache.isFresh(9_000, 1_000)).toBe(true); // exactly maxAge → fresh
    expect(cache.isFresh(8_999, 1_000)).toBe(false); // 1ms over → stale
    expect(cache.isFresh(null, 1_000)).toBe(false); // nothing cached → stale
  });

  it("G4: add → remove → add collapses to a single add", async () => {
    const storage = createMemoryStorage();
    const queue = new WishlistSyncQueue(storage, { clock: () => 5 });
    await queue.enqueue("add", "camp-9");
    await queue.enqueue("remove", "camp-9");
    await queue.enqueue("add", "camp-9");

    expect(await queue.pending()).toEqual([
      { type: "add", campaignId: "camp-9", queuedAt: 5 },
    ]);
  });

  it("G5: partial failure keeps only the failed op queued (success path drops)", async () => {
    const storage = createMemoryStorage();
    const wishlist = new OfflineWishlist(storage);
    const queue = new WishlistSyncQueue(storage);
    const remote: WishlistRemote = {
      add: vi.fn(async (id: string) => {
        if (id === "bad") throw new Error("server rejected");
      }),
      remove: vi.fn(async () => {}),
    };
    const onSyncError = vi.fn();
    const engine = new WishlistSyncEngine({ wishlist, queue, remote, onSyncError });

    await engine.add("good");
    await engine.add("bad");

    const result = await engine.sync();
    expect(result).toEqual({ attempted: 2, synced: 1, failed: 1 });
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(await queue.pending()).toHaveLength(1);
    expect((await queue.pending())[0].campaignId).toBe("bad");
  });

  it("G6: removeDetail deletes one entry and keeps the list + siblings", async () => {
    const storage = createMemoryStorage();
    const cache = new CampaignCache(storage, { clock: () => 3 });

    await cache.saveList([summary("a")]);
    await cache.saveDetail("a", { ...summary("a"), sponsors: [], verificationProgress: 1 });
    await cache.saveDetail("b", { ...summary("b"), sponsors: [], verificationProgress: 2 });

    await cache.removeDetail("a");

    expect(await cache.readList()).not.toBeNull();
    expect(await cache.readDetail("a")).toBeNull();
    expect(await cache.readDetail("b")).not.toBeNull();
  });

  it("G6: deleting a missing detail is a no-op (no throw)", async () => {
    const cache = new CampaignCache(createMemoryStorage());
    await expect(cache.removeDetail("ghost")).resolves.toBeUndefined();
  });
});
