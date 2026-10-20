import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignRepository } from "../campaignCache";
import { getOfflineServices, resetOfflineServices } from "../index";
import { createMemoryStorage, type KeyValueStorage } from "../storage";
import {
  WishlistSyncEngine,
  WishlistSyncQueue,
  bindSyncOnReconnect,
  createConnectivityMonitor,
  createManualConnectivitySource,
  type WishlistRemote,
} from "../sync";
import { OfflineWishlist } from "../wishlist";
import {
  createPrivacySafeSyncTelemetry,
  type SyncTelemetryEventMap,
} from "../telemetry";
import type { CampaignSummary } from "../types";

/**
 * Full mobile offline lifecycle with deterministic fixtures:
 * cache → offline queue → app restart → server conflict → reconnect flush.
 *
 * The device fixture below keeps one `KeyValueStorage` alive across "app
 * restarts" (rebuilding the offline services over the same store), which is
 * exactly how the layer behaves with a persisted native backend such as
 * AsyncStorage. Platform gaps — native storage, NetInfo, and the
 * CampaignDetailScreen WebSocket lifecycle — are documented in OFFLINE.md and
 * are intentionally out of scope for this node-run suite.
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

/** A "device" whose persisted storage survives app restarts. */
function createDevice() {
  const storage: KeyValueStorage = createMemoryStorage();
  return {
    storage,
    /** Simulate an app restart: brand-new services over the same store. */
    restart() {
      resetOfflineServices();
      return getOfflineServices(storage);
    },
  };
}

afterEach(() => {
  resetOfflineServices();
});

describe("mobile offline lifecycle", () => {
  it("carries cache, queue and wishlist across a restart, resolves conflicts, flushes on reconnect", async () => {
    const device = createDevice();
    const telemetryEvents: Array<{
      event: keyof SyncTelemetryEventMap;
      metrics: unknown;
    }> = [];
    const telemetry = createPrivacySafeSyncTelemetry({
      onEvent: (event, metrics) => telemetryEvents.push({ event, metrics }),
    });

    // Server view of the world: the sponsor's wishlist on the backend.
    const serverWishlist = new Set(["c2"]);
    const conflictOnce = new Set<string>(["remove:c2"]);
    const applied: string[] = [];
    const remote: WishlistRemote = {
      add: async (id) => {
        serverWishlist.add(id);
        applied.push(`add:${id}`);
      },
      remove: async (id) => {
        if (conflictOnce.delete(`remove:${id}`)) {
          // Transient conflict: the server has a newer revision this round.
          throw Object.assign(new Error("revision conflict"), { status: 409 });
        }
        serverWishlist.delete(id);
        applied.push(`remove:${id}`);
      },
    };

    // ── 1. Online: browse once, the cache is populated. ─────────────────────
    const services = device.restart();
    const repository = new CampaignRepository(services.cache);
    await repository.loadList(async () => [summary("c1"), summary("c2")]);
    await repository.loadDetail("c1", async () => ({
      ...summary("c1"),
      sponsors: [],
      verificationProgress: 0.5,
    }));

    const engine = new WishlistSyncEngine({
      wishlist: services.wishlist,
      queue: services.queue,
      remote,
      telemetry,
    });
    // c2 is wishlisted locally too, matching the server before going offline.
    await engine.add("c2");

    // ── 2. Offline: reads fall back to cache, edits queue locally. ─────────
    const offlineList = await repository.loadList(async () => {
      throw new Error("offline");
    });
    expect(offlineList.fromCache).toBe(true);
    expect(offlineList.data.map((c) => c.id)).toEqual(["c1", "c2"]);

    const offlineDetail = await repository.loadDetail(
      "c1",
      async () => {
        throw new Error("offline");
      },
      { fallback: { ...summary("c1"), sponsors: [], verificationProgress: 0 } },
    );
    expect(offlineDetail.fromCache).toBe(true);

    await engine.remove("c2"); // local draft: remove c2
    await engine.add("c1"); // local draft: add c1
    await engine.add("c1"); // repeated edit collapses (deterministic merge)
    expect(applied).toEqual([]);
    expect(await services.queue.pending()).toHaveLength(2);

    // ── 3. Restart: durable state survives, drafts are not lost. ───────────
    const reopened = device.restart();
    expect(await reopened.wishlist.list()).toEqual(["c1"]);
    expect(await reopened.queue.pending()).toHaveLength(2);
    const reopenedRepository = new CampaignRepository(reopened.cache);
    const afterRestart = await reopenedRepository.loadList(async () => {
      throw new Error("still offline");
    });
    expect(afterRestart.fromCache).toBe(true);

    // ── 4. Reconnect: flush hits a conflict; the op survives for retry. ────
    const restartedEngine = new WishlistSyncEngine({
      wishlist: reopened.wishlist,
      queue: reopened.queue,
      remote,
      telemetry,
    });
    const source = createManualConnectivitySource(false);
    const monitor = createConnectivityMonitor(source);
    const onReconnect = vi.fn();
    const unbind = bindSyncOnReconnect(monitor, {
      engine: restartedEngine,
      onReconnect,
    });

    telemetryEvents.length = 0;
    monitor.setOnline(true);

    // First reconnect: c1's add applies, c2's remove hits the 409 and the
    // failed op stays queued for the next reconnect.
    await vi.waitFor(() => {
      expect(applied).toEqual(["add:c1"]);
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(async () => {
      expect(await reopened.queue.pending()).toHaveLength(1);
    });

    // ── 5. Second reconnect: the retried op converges. ─────────────────────
    monitor.setOnline(false);
    monitor.setOnline(true);

    await vi.waitFor(async () => {
      expect(await reopened.queue.pending()).toEqual([]);
    });
    await vi.waitFor(() => {
      expect(applied).toEqual(["add:c1", "remove:c2"]);
    });
    expect(serverWishlist.has("c2")).toBe(false); // local latest state wins
    expect(await reopened.wishlist.list()).toEqual(["c1"]);
    await vi.waitFor(() => {
      expect(onReconnect).toHaveBeenCalledTimes(2);
    });

    // Telemetry observed the retry without leaking any draft/wallet data.
    const failureEvents = telemetryEvents.filter((e) => e.event === "failure");
    expect(failureEvents).toEqual([
      { event: "failure", metrics: { failureClass: "conflict", attempt: 1 } },
    ]);
    const flushDepths = telemetryEvents
      .filter((e) => e.event === "flush")
      .map((e) => (e.metrics as SyncTelemetryEventMap["flush"]).queueDepth);
    expect(flushDepths).toEqual([2, 1]);
    for (const { metrics } of telemetryEvents) {
      expect(JSON.stringify(metrics)).not.toMatch(
        /campaignId|wishlist|wallet|drafts/,
      );
    }

    unbind();
  });

  it("recovers from a corrupted queue payload without blocking future syncs", async () => {
    const device = createDevice();
    const queue = new WishlistSyncQueue(device.storage);
    await device.storage.setItem(queue.key(), "{not json");

    expect(await queue.pending()).toEqual([]); // corrupt → treated as empty

    const calls: string[] = [];
    const remote: WishlistRemote = {
      add: vi.fn(async (id: string) => {
        calls.push(`add:${id}`);
      }),
      remove: vi.fn(async (id: string) => {
        calls.push(`remove:${id}`);
      }),
    };
    const engine = new WishlistSyncEngine({
      wishlist: new OfflineWishlist(device.storage),
      queue,
      remote,
    });

    await engine.add("c9");
    expect(await engine.sync()).toEqual({
      attempted: 1,
      synced: 1,
      failed: 0,
    });
    expect(calls).toEqual(["add:c9"]);
  });

  it("flushes nothing on reconnect when the queue is empty", async () => {
    const device = createDevice();
    const services = device.restart();
    const remote: WishlistRemote = {
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const engine = new WishlistSyncEngine({
      wishlist: services.wishlist,
      queue: services.queue,
      remote,
    });
    const monitor = createConnectivityMonitor(createManualConnectivitySource());
    bindSyncOnReconnect(monitor, { engine });

    monitor.setOnline(true);
    await vi.waitFor(() => {
      expect(remote.add).not.toHaveBeenCalled();
      expect(remote.remove).not.toHaveBeenCalled();
    });
    expect(await services.queue.pending()).toEqual([]);
  });
});

