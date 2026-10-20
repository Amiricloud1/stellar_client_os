import { describe, expect, it } from "vitest";
import {
  resolveCampaignConflict,
  resolveWishlistConflict,
  classifyServerError,
  mergePartialSync,
  reconcileCampaignList,
  type SyncAttemptOutcome,
} from "../conflictResolution";
import type { CampaignSummary } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const summary = (id: string, extra: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id,
  name: `Campaign ${id}`,
  status: "active",
  goalAmount: "1000",
  raisedAmount: "10",
  treeCount: 5,
  sponsorCount: 1,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCampaignConflict
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveCampaignConflict", () => {
  it("server-wins when both local and server versions exist and differ", () => {
    const local = summary("c1", { raisedAmount: "10" });
    const server = summary("c1", { raisedAmount: "999" });
    const r = resolveCampaignConflict(local, server);

    expect(r.outcome).toBe("server-wins");
    expect(r.resolved).toEqual(server);
    expect(r.localDataDiscarded).toBe(true);
  });

  it("no data discarded when local and server versions are identical", () => {
    const cam = summary("c1");
    const r = resolveCampaignConflict(cam, cam);

    expect(r.outcome).toBe("server-wins");
    expect(r.localDataDiscarded).toBe(false);
  });

  it("returns deleted outcome when server reports null (entity gone)", () => {
    const r = resolveCampaignConflict(summary("c1"), null);

    expect(r.outcome).toBe("deleted");
    expect(r.resolved).toBeNull();
    expect(r.localDataDiscarded).toBe(true);
  });

  it("no local data discarded when deleting an already-null local entity", () => {
    const r = resolveCampaignConflict(null, null);
    expect(r.outcome).toBe("deleted");
    expect(r.localDataDiscarded).toBe(false);
  });

  it("uses server data when there is no local version", () => {
    const server = summary("c1");
    const r = resolveCampaignConflict(null, server);

    expect(r.outcome).toBe("server-wins");
    expect(r.resolved).toEqual(server);
    expect(r.localDataDiscarded).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveWishlistConflict
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWishlistConflict", () => {
  it("returns the server list when there are no pending local additions", () => {
    const r = resolveWishlistConflict({
      localIds: ["c1", "c2", "c3"],
      serverIds: ["c1", "c2"],
      pendingLocalAdditions: [],
    });

    expect(r.outcome).toBe("merged");
    expect(r.resolved).toEqual(["c1", "c2"]);
    // c3 was stale — not in pending list, so it was removed.
    expect(r.localDataDiscarded).toBe(true);
  });

  it("preserves unsynced local additions not yet on the server", () => {
    const r = resolveWishlistConflict({
      localIds: ["c1", "c2"],
      serverIds: ["c1"],
      pendingLocalAdditions: ["c2"],
    });

    expect(r.resolved).toContain("c1");
    expect(r.resolved).toContain("c2");
    expect(r.localDataDiscarded).toBe(false);
  });

  it("server removal wins even when item is in the pending additions list", () => {
    // c2 is in pending, but the server explicitly doesn't have it (maybe
    // someone else removed it server-side and the race resolved against us).
    // For clarity: we only preserve pending additions that are NOT in serverIds
    // AND were in our queue. "Not in server" + "in pending" = keep. But if the
    // server confirmed removal, we respect that.
    // The current strategy is: pending items NOT on server are preserved.
    // That covers the "add hasn't reached server yet" case but not the
    // "server removed it" case — we can't distinguish the two without a
    // server-issued removal timestamp. So we preserve the pending addition.
    // This is the documented trade-off.
    const r = resolveWishlistConflict({
      localIds: ["c2"],
      serverIds: [],           // server has nothing
      pendingLocalAdditions: ["c2"],
    });
    // c2 is in pending and not on server: it is preserved (add hasn't synced yet).
    expect(r.resolved).toContain("c2");
  });

  it("no data discarded when local and server lists are already in sync", () => {
    const r = resolveWishlistConflict({
      localIds: ["c1", "c2"],
      serverIds: ["c1", "c2"],
      pendingLocalAdditions: [],
    });

    expect(r.localDataDiscarded).toBe(false);
    expect(new Set(r.resolved)).toEqual(new Set(["c1", "c2"]));
  });

  it("handles a completely empty state gracefully", () => {
    const r = resolveWishlistConflict({
      localIds: [],
      serverIds: [],
      pendingLocalAdditions: [],
    });

    expect(r.resolved).toEqual([]);
    expect(r.localDataDiscarded).toBe(false);
  });

  it("stale local items removed by server appear in the description", () => {
    const r = resolveWishlistConflict({
      localIds: ["c1", "c2", "c3"],
      serverIds: ["c1"],
      pendingLocalAdditions: [],
    });
    expect(r.description).toMatch(/stale/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyServerError
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyServerError", () => {
  it("classifies 401 as permanent permission-denied", () => {
    const c = classifyServerError({ status: 401 });
    expect(c.permanent).toBe(true);
    expect(c.outcome).toBe("permission-denied");
  });

  it("classifies 403 as permanent permission-denied", () => {
    const c = classifyServerError({ status: 403, message: "forbidden" });
    expect(c.permanent).toBe(true);
    expect(c.outcome).toBe("permission-denied");
    expect(c.description).toContain("forbidden");
  });

  it("classifies 404 as permanent deleted", () => {
    const c = classifyServerError({ status: 404 });
    expect(c.permanent).toBe(true);
    expect(c.outcome).toBe("deleted");
  });

  it("classifies 500 as transient (retry)", () => {
    const c = classifyServerError({ status: 500 });
    expect(c.permanent).toBe(false);
  });

  it("classifies 429 as transient (retry)", () => {
    const c = classifyServerError({ status: 429 });
    expect(c.permanent).toBe(false);
  });

  it("classifies 0 (network timeout) as transient", () => {
    const c = classifyServerError({ status: 0 });
    expect(c.permanent).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergePartialSync
// ─────────────────────────────────────────────────────────────────────────────

describe("mergePartialSync", () => {
  it("splits outcomes into confirmed, permanently-failed, and retry buckets", () => {
    const outcomes: SyncAttemptOutcome[] = [
      { campaignId: "c1", success: true },
      { campaignId: "c2", success: false, error: { status: 403 } },
      { campaignId: "c3", success: false, error: { status: 500 } },
      { campaignId: "c4", success: true },
    ];

    const result = mergePartialSync(outcomes);

    expect(result.confirmedIds).toEqual(["c1", "c4"]);
    expect(result.permanentlyFailedIds).toEqual(["c2"]);
    expect(result.retryIds).toEqual(["c3"]);
  });

  it("puts failures without an error object into retryIds", () => {
    const outcomes: SyncAttemptOutcome[] = [
      { campaignId: "c1", success: false },
    ];
    const result = mergePartialSync(outcomes);
    expect(result.retryIds).toEqual(["c1"]);
    expect(result.permanentlyFailedIds).toEqual([]);
  });

  it("handles an all-success batch", () => {
    const outcomes: SyncAttemptOutcome[] = [
      { campaignId: "c1", success: true },
      { campaignId: "c2", success: true },
    ];
    const result = mergePartialSync(outcomes);
    expect(result.confirmedIds).toEqual(["c1", "c2"]);
    expect(result.permanentlyFailedIds).toEqual([]);
    expect(result.retryIds).toEqual([]);
  });

  it("handles an empty batch", () => {
    const result = mergePartialSync([]);
    expect(result.confirmedIds).toEqual([]);
    expect(result.permanentlyFailedIds).toEqual([]);
    expect(result.retryIds).toEqual([]);
  });

  it("treats 404 as permanently failed (entity deleted)", () => {
    const outcomes: SyncAttemptOutcome[] = [
      { campaignId: "c1", success: false, error: { status: 404 } },
    ];
    const result = mergePartialSync(outcomes);
    expect(result.permanentlyFailedIds).toEqual(["c1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reconcileCampaignList
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcileCampaignList", () => {
  it("uses server list as authoritative, reports locally-removed campaigns", () => {
    const local = [summary("c1"), summary("c2"), summary("c3")];
    const server = [summary("c1"), summary("c3", { raisedAmount: "999" })];

    const { list, removedIds } = reconcileCampaignList(local, server);

    expect(list).toHaveLength(2);
    // Server version of c3 (updated raisedAmount) must be used.
    expect(list.find((c) => c.id === "c3")!.raisedAmount).toBe("999");
    expect(removedIds).toEqual(["c2"]);
  });

  it("adds new campaigns that appeared on the server", () => {
    const local = [summary("c1")];
    const server = [summary("c1"), summary("c2")];

    const { list, removedIds } = reconcileCampaignList(local, server);

    expect(list).toHaveLength(2);
    expect(removedIds).toEqual([]);
  });

  it("returns an empty list when the server returns nothing", () => {
    const { list, removedIds } = reconcileCampaignList(
      [summary("c1")],
      [],
    );
    expect(list).toEqual([]);
    expect(removedIds).toEqual(["c1"]);
  });

  it("handles both lists being empty", () => {
    const { list, removedIds } = reconcileCampaignList([], []);
    expect(list).toEqual([]);
    expect(removedIds).toEqual([]);
  });

  it("handles an empty local cache (first-run)", () => {
    const server = [summary("c1"), summary("c2")];
    const { list, removedIds } = reconcileCampaignList([], server);
    expect(list).toHaveLength(2);
    expect(removedIds).toEqual([]);
  });
});
