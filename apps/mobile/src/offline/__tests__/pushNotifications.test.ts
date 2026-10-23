import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../storage";
import {
  type PushManagerOptions,
  type PushReconcileResult,
  type PushRemote,
  PushTokenManager,
} from "../pushNotifications";

const clock = () => 1_000;

function makeStorage() {
  return createMemoryStorage();
}

function makeManager(storage = makeStorage(), options: PushManagerOptions = {}) {
  return new PushTokenManager(storage, { clock, ...options });
}

describe("PushTokenManager install state", () => {
  it("creates a fresh install with no token", async () => {
    const manager = makeManager();
    const state = await manager.getState();

    expect(state.token).toBeNull();
    expect(state.permission).toBe("undetermined");
    expect(state.deviceId).toMatch(/^dev-/);
    expect(state.revision).toBe(1);
    expect(state.previousToken).toBeNull();
  });

  it("is deterministic when a custom randomId is supplied", async () => {
    const a = makeManager(makeStorage(), { randomId: () => "dev-fixed" });
    const b = makeManager(makeStorage(), { randomId: () => "dev-fixed" });
    expect(await a.getState().then((s) => s.deviceId)).toBe(
      await b.getState().then((s) => s.deviceId),
    );
  });
});

describe("PushTokenManager registration", () => {
  it("registers a fresh token", async () => {
    const manager = makeManager();
    const outcome = await manager.registerDevice("token-a");

    expect(outcome).toEqual({ status: "registered", token: "token-a" });
    const state = await manager.getState();
    expect(state.token).toBe("token-a");
    expect(state.permission).toBe("granted");
  });

  it("rotates the token and keeps the previous one", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");

    const outcome = await manager.registerDevice("token-b");

    expect(outcome).toEqual({
      status: "rotated",
      token: "token-b",
      previousToken: "token-a",
    });
    const state = await manager.getState();
    expect(state.token).toBe("token-b");
    expect(state.previousToken).toBe("token-a");
  });

  it("is unchanged when the same token is re-registered", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");

    const outcome = await manager.registerDevice("token-a");

    expect(outcome).toEqual({ status: "unchanged", token: "token-a" });
    const state = await manager.getState();
    expect(state.previousToken).toBeNull();
  });

  it("blocks registration when permission is denied", async () => {
    const manager = makeManager();
    await manager.setPermission("denied");

    const outcome = await manager.registerDevice("token-a");

    expect(outcome).toEqual({ status: "blocked", permission: "denied" });
    expect((await manager.getState()).token).toBeNull();
  });

  it("blocks registration when the token is empty", async () => {
    const manager = makeManager();
    const outcome = await manager.registerDevice("");

    expect(outcome.status).toBe("blocked");
    expect((outcome as { permission: string }).permission).toBe("undetermined");
  });
});

describe("PushTokenManager permission + revocation", () => {
  it("setPermission denying withdraws the token locally", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");
    await manager.setPermission("denied");

    const state = await manager.getState();
    expect(state.permission).toBe("denied");
    expect(state.token).toBeNull();

describe("PushTokenManager preferences", () => {
  it("toggles per-device preferences", async () => {
    const manager = makeManager();
    const state = await manager.setPreference("productNews", true);

    expect(state.preferences.productNews).toBe(true);
    expect(state.preferences.campaignUpdates).toBe(true);
    expect(await manager.getPreferences()).toEqual(
      expect.objectContaining({ productNews: true }),
    );
  });

  it("is a no-op when the preference already matches", async () => {
    const manager = makeManager();
    const first = await manager.setPreference("productNews", false);
    const second = await manager.setPreference("productNews", false);
    expect(first.revision).toBe(2);
    expect(second.revision).toBe(2);
  });
});

describe("PushTokenManager reconciliation", () => {
  function remoteWith(calls: string[], shouldFail = false): PushRemote {
    return {
      register: vi.fn(async () => {
        calls.push("register");
        if (shouldFail) throw new Error("down");
      }),
      revoke: vi.fn(async () => {
        calls.push("revoke");
      }),
    };
  }

  it("keeps the token when the server accepts it", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");
    const remote = remoteWith([]);

    const { state, outcome } = await manager.reconcile(
      remote,
      async () => ({ action: "keep" } as PushReconcileResult),
    );

    expect(outcome.action).toBe("keep");
    expect(state.token).toBe("token-a");
    expect(remote.register).toHaveBeenCalledWith({
      deviceId: state.deviceId,
      token: "token-a",
      previousToken: null,
      preferences: expect.anything(),
    });
  });

  it("revokes locally when the server retires the token", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");
    const remote = remoteWith([]);

    const { state, outcome } = await manager.reconcile(
      remote,
      async () => ({ action: "revoke", reason: "expired" } as const),
    );

    expect(outcome.action).toBe("revoke");
    expect(state.token).toBeNull();
    expect(state.previousToken).toBe("token-a");
    expect(remote.revoke).toHaveBeenCalledWith("token-a", "rotated");
  });

  it("adopts the newer token on duplicate device", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");
    const remote = remoteWith([]);

    const { state, outcome } = await manager.reconcile(
      remote,
      async () => ({ action: "supersede", token: "token-b" } as const),
    );

    expect(outcome.action).toBe("supersede");
    expect(state.token).toBe("token-b");
    expect(state.previousToken).toBe("token-a");
  });

  it("resets device identity on reinstall", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");
    const remote = remoteWith([]);
    const firstDeviceId = (await manager.getState()).deviceId;

    const { state, outcome } = await manager.reconcile(
      remote,
      async () => ({ action: "reregister", reason: "unknown device" } as const),
    );

    expect(outcome.action).toBe("reregister");
    expect(state.token).toBeNull();
    expect(state.deviceId).not.toBe(firstDeviceId);
    expect(state.previousToken).toBe("token-a");
  });

  it("does not register when there is no local token", async () => {
    const manager = makeManager();
    const remote = remoteWith([]);

    await manager.reconcile(
      remote,
      async () => ({ action: "keep" } as PushReconcileResult),
    );

    expect(remote.register).not.toHaveBeenCalled();
  });
});

    expect(state.previousToken).toBe("token-a");
  });

  it("revokeToken drops the token but keeps the previous one", async () => {
    const manager = makeManager();
    await manager.registerDevice("token-a");
    await manager.registerDevice("token-b");
    await manager.revokeToken("delivery rejected");

    const state = await manager.getState();
    expect(state.token).toBeNull();
    expect(state.previousToken).toBe("token-b");
  });

  it("revokeToken with nothing stored is a no-op", async () => {
    const manager = makeManager();
    const state = await manager.revokeToken("n/a");
    expect(state.token).toBeNull();
    expect(state.previousToken).toBeNull();
  });
});
