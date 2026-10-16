import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../storage";
import {
  WishlistSyncEngine,
  WishlistSyncQueue,
  type WishlistRemote,
} from "../sync";
import { OfflineWishlist } from "../wishlist";
import {
  classifySyncError,
  createPrivacySafeSyncTelemetry,
  sanitizeSyncTelemetryEvent,
  type SyncFlushMetrics,
  type SyncFailureMetrics,
  type SyncTelemetryEventMap,
} from "../telemetry";

/** Fields that must never reach a telemetry payload. */
const FORBIDDEN_FIELDS = [
  "campaignId",
  "campaignIds",
  "wishlist",
  "drafts",
  "wallet",
  "walletAddress",
  "address",
  "message",
  "error",
];

function forbiddenKeysIn(payload: unknown): string[] {
  const serialized = JSON.stringify(payload);
  return FORBIDDEN_FIELDS.filter((field) =>
    serialized.includes(`"${field}"`),
  );
}

describe("classifySyncError", () => {
  it("classifies network failures", () => {
    expect(classifySyncError(new TypeError("Failed to fetch"))).toBe("network");
    expect(
      classifySyncError(Object.assign(new Error("down"), { code: "ECONNREFUSED" })),
    ).toBe("network");
    expect(
      classifySyncError(Object.assign(new Error("dns"), { code: "EAI_AGAIN" })),
    ).toBe("network");
  });

  it("classifies timeouts", () => {
    expect(
      classifySyncError(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ).toBe("timeout");
    expect(
      classifySyncError(Object.assign(new Error("slow"), { code: "ETIMEDOUT" })),
    ).toBe("timeout");
  });

  it("classifies http statuses", () => {
    expect(classifySyncError({ status: 401 })).toBe("auth");
    expect(classifySyncError({ status: 403 })).toBe("auth");
    expect(classifySyncError({ statusCode: 409 })).toBe("conflict");
    expect(classifySyncError({ status: 500 })).toBe("server");
    expect(classifySyncError({ status: 400 })).toBe("server");
  });

  it("falls back to unknown for anything else", () => {
    expect(classifySyncError(new Error("boom"))).toBe("unknown");
    expect(classifySyncError(null)).toBe("unknown");
    expect(classifySyncError(undefined)).toBe("unknown");
    expect(classifySyncError("offline")).toBe("unknown");
  });

  it("never reads the error message", () => {
    // A message stuffed with user data must not change the classification.
    const error = Object.assign(new Error("wallet GABC... secret SXYZ..."), {
      status: 409,
    });
    expect(classifySyncError(error)).toBe("conflict");
  });
});

describe("sanitizeSyncTelemetryEvent", () => {
  it("drops non-allowlisted fields from flush payloads", () => {
    const polluted = {
      queueDepth: 3,
      synced: 2,
      failed: 1,
      latencyMs: 40,
      retries: 1,
      campaignId: "camp-1",
      campaignIds: ["camp-1", "camp-2"],
      walletAddress: "GABC",
      drafts: [{ campaignId: "camp-1" }],
      message: "wallet GABC",
    } as unknown as SyncTelemetryEventMap["flush"];

    const clean = sanitizeSyncTelemetryEvent("flush", polluted);

    expect(clean).toEqual({
      queueDepth: 3,
      synced: 2,
      failed: 1,
      latencyMs: 40,
      retries: 1,
    });
    expect(forbiddenKeysIn(clean)).toEqual([]);
  });

  it("drops non-allowlisted fields from failure payloads", () => {
    const polluted = {
      failureClass: "conflict",
      attempt: 2,
      campaignId: "camp-1",
      message: "409 for campaign camp-1",
    } as unknown as SyncTelemetryEventMap["failure"];

    const clean = sanitizeSyncTelemetryEvent("failure", polluted);

    expect(clean).toEqual({ failureClass: "conflict", attempt: 2 });
    expect(forbiddenKeysIn(clean)).toEqual([]);
  });

  it("coerces non-finite or negative counters to zero", () => {
    const dirty = {
      queueDepth: Number.NaN,
      synced: -1,
      failed: Number.POSITIVE_INFINITY,
      latencyMs: 12.9,
      retries: "3",
    } as unknown as SyncFlushMetrics;

    expect(sanitizeSyncTelemetryEvent("flush", dirty)).toEqual({
      queueDepth: 0,
      synced: 0,
      failed: 0,
      latencyMs: 12,
      retries: 0,
    });
  });

  it("replaces unknown failure classes and keeps attempt at least 1", () => {
    const dirty = {
      failureClass: "catastrophe",
      attempt: 0,
    } as unknown as SyncFailureMetrics;

    expect(sanitizeSyncTelemetryEvent("failure", dirty)).toEqual({
      failureClass: "unknown",
      attempt: 1,
    });
  });
});

describe("createPrivacySafeSyncTelemetry", () => {
  it("forwards sanitized events when enabled", () => {
    const onEvent = vi.fn();
    const telemetry = createPrivacySafeSyncTelemetry({ onEvent });

    telemetry.record("failure", {
      failureClass: "network",
      attempt: 1,
      // @ts-expect-error exercising runtime pollution of the payload
      campaignId: "camp-1",
    });

    expect(onEvent).toHaveBeenCalledWith("failure", {
      failureClass: "network",
      attempt: 1,
    });
  });

  it("drops every event when opted out", () => {
    const onEvent = vi.fn();
    const telemetry = createPrivacySafeSyncTelemetry({
      onEvent,
      enabled: false,
    });

    telemetry.record("flush", {
      queueDepth: 5,
      synced: 5,
      failed: 0,
      latencyMs: 10,
      retries: 0,
    });
    telemetry.record("failure", { failureClass: "server", attempt: 1 });

    expect(onEvent).not.toHaveBeenCalled();
  });
});

function createRemote(failures = new Map<string, () => Error>()): {
  remote: WishlistRemote;
  calls: string[];
} {
  const calls: string[] = [];
  const remote: WishlistRemote = {
    add: vi.fn(async (campaignId: string) => {
      const failure = failures.get(`add:${campaignId}`);
      if (failure) throw failure();
      calls.push(`add:${campaignId}`);
    }),
    remove: vi.fn(async (campaignId: string) => {
      const failure = failures.get(`remove:${campaignId}`);
      if (failure) throw failure();
      calls.push(`remove:${campaignId}`);
    }),
  };
  return { remote, calls };
}

describe("WishlistSyncEngine telemetry integration", () => {
  it("emits sanitized flush and failure events with deterministic latency", async () => {
    const storage = createMemoryStorage();
    const queue = new WishlistSyncQueue(storage, { clock: () => 0 });
    const events: Array<{ event: string; metrics: unknown }> = [];
    const telemetry = createPrivacySafeSyncTelemetry({
      onEvent: (event, metrics) => events.push({ event, metrics }),
    });
    const { remote } = createRemote(
      new Map([
        [
          "add:camp-2",
          () => Object.assign(new Error("conflict"), { status: 409 }),
        ],
      ]),
    );
    // Deterministic clock: flush starts at 1000, ends at 1125.
    const ticks = [1000, 1125];
    const engine = new WishlistSyncEngine({
      wishlist: new OfflineWishlist(storage),
      queue,
      remote,
      telemetry,
      clock: () => ticks.shift() ?? 1125,
    });

    await engine.add("camp-1");
    await engine.add("camp-2");
    const result = await engine.sync();

    expect(result).toEqual({ attempted: 2, synced: 1, failed: 1 });
    expect(events).toEqual([
      {
        event: "failure",
        metrics: { failureClass: "conflict", attempt: 1 },
      },
      {
        event: "flush",
        metrics: {
          queueDepth: 2,
          synced: 1,
          failed: 1,
          latencyMs: 125,
          retries: 0,
        },
      },
    ]);
    for (const { metrics } of events) {
      expect(forbiddenKeysIn(metrics)).toEqual([]);
    }

    // The failed operation is tracked as a retry on the next flush.
    const pending = await queue.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(1);
  });

  it("counts retries at flush start", async () => {
    const storage = createMemoryStorage();
    const queue = new WishlistSyncQueue(storage);
    const events: Array<{ event: string; metrics: unknown }> = [];
    const telemetry = createPrivacySafeSyncTelemetry({
      onEvent: (event, metrics) => events.push({ event, metrics }),
    });
    const { remote } = createRemote();
    const engine = new WishlistSyncEngine({
      wishlist: new OfflineWishlist(storage),
      queue,
      remote,
      telemetry,
    });

    await engine.add("camp-1");
    (remote.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("offline"), { name: "TypeError" }),
    );
    await engine.sync();
    events.length = 0;

    const retryResult = await engine.sync();
    expect(retryResult).toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(events).toEqual([
      {
        event: "flush",
        metrics: {
          queueDepth: 1,
          synced: 1,
          failed: 0,
          latencyMs: 0,
          retries: 1,
        },
      },
    ]);
  });

  it("emits a zeroed flush event for an empty queue", async () => {
    const storage = createMemoryStorage();
    const events: unknown[] = [];
    const telemetry = createPrivacySafeSyncTelemetry({
      onEvent: (_event, metrics) => events.push(metrics),
    });
    const { remote } = createRemote();
    const engine = new WishlistSyncEngine({
      wishlist: new OfflineWishlist(storage),
      queue: new WishlistSyncQueue(storage),
      remote,
      telemetry,
    });

    expect(await engine.sync()).toEqual({
      attempted: 0,
      synced: 0,
      failed: 0,
    });
    expect(events).toEqual([
      { queueDepth: 0, synced: 0, failed: 0, latencyMs: 0, retries: 0 },
    ]);
    expect(remote.add).not.toHaveBeenCalled();
    expect(remote.remove).not.toHaveBeenCalled();
  });

  it("clamps negative latency to zero when the clock regresses", async () => {
    const storage = createMemoryStorage();
    const events: SyncFlushMetrics[] = [];
    const telemetry = createPrivacySafeSyncTelemetry({
      onEvent: (_event, metrics) => events.push(metrics as SyncFlushMetrics),
    });
    const { remote } = createRemote();
    const ticks = [1000, 400];
    const engine = new WishlistSyncEngine({
      wishlist: new OfflineWishlist(storage),
      queue: new WishlistSyncQueue(storage),
      remote,
      telemetry,
      clock: () => ticks.shift() ?? 400,
    });

    await engine.sync();
    expect(events[0]?.latencyMs).toBe(0);
  });

  it("keeps syncing when the telemetry sink itself throws", async () => {
    const storage = createMemoryStorage();
    const telemetry = {
      record: vi.fn(() => {
        throw new Error("sink offline");
      }),
    };
    const { remote, calls } = createRemote();
    const engine = new WishlistSyncEngine({
      wishlist: new OfflineWishlist(storage),
      queue: new WishlistSyncQueue(storage),
      remote,
      telemetry,
    });

    await engine.add("camp-1");
    expect(await engine.sync()).toEqual({
      attempted: 1,
      synced: 1,
      failed: 0,
    });
    expect(calls).toEqual(["add:camp-1"]);
  });

  it("records nothing when no telemetry sink is configured", async () => {
    const storage = createMemoryStorage();
    const { remote } = createRemote();
    const engine = new WishlistSyncEngine({
      wishlist: new OfflineWishlist(storage),
      queue: new WishlistSyncQueue(storage),
      remote,
    });

    await engine.add("camp-1");
    expect(await engine.sync()).toEqual({
      attempted: 1,
      synced: 1,
      failed: 0,
    });
  });
});

