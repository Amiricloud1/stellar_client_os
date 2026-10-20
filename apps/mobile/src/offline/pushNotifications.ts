/**
 * Push token lifecycle + per-device notification preferences (issue #90).
 *
 * The mobile client must reconcile tokens that rotate (the OS re-issues
 * them), get revoked (permission withdrawn, delivery rejected by the
 * provider), or survive a reinstall. This module owns that reconciliation as
 * pure, storage-backed state so it is unit-testable off-device:
 *
 *   - `registerDevice` records the current token + stable device id, rotating
 *     the stored token when it changes and keeping the old one so the server
 *     can retire it.
 *   - `setPermission` / `revokeToken` invalidate the local token when
 *     permission is denied or the OS drops the token.
 *   - `setPreference` / `getPreferences` persist per-device opt-ins.
 *   - `reconcile` pushes local state to the server and applies its verdict
 *     (`keep` / `revoke` / `supersede` / `reregister`), covering reinstall
 *     (unknown device) and duplicate device (server has a newer token).
 *
 * Network transport is injected (`PushRemote`), so tests are deterministic
 * and independent of live funds.
 */

import { type KeyValueStorage, readJSON, writeJSON } from "./storage";

/** Notification categories a sponsor can opt into per device. */
export type PushPreferenceKey =
  | "campaignUpdates"
  | "milestones"
  | "sponsorActivity"
  | "productNews";

export type PushPreferences = Record<PushPreferenceKey, boolean>;

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  campaignUpdates: true,
  milestones: true,
  sponsorActivity: true,
  productNews: false,
};

export type PushPermissionState = "granted" | "denied" | "undetermined";

/** Locally persisted push registration state for this install. */
export interface PushState {
  /** Stable per-install device id (regenerated on reinstall). */
  deviceId: string;
  /** Current push token, or null when none / revoked. */
  token: string | null;
  /** Token previously registered with the server, kept until retired. */
  previousToken: string | null;
  permission: PushPermissionState;
  preferences: PushPreferences;
  /** Bumped on every change so callers can detect drift. */
  revision: number;
  updatedAt: number;
}

/** Server verdict applied during reconciliation. */
export type PushReconcileResult =
  /** Server accepted our token; nothing to change locally. */
  | { action: "keep" }
  /** Server retired our token (revoked/expired); drop it and re-register. */
  | { action: "revoke"; reason?: string }
  /**
   * Duplicate device: the server already has a newer token for this device
   * id. Adopt it so this install stops retrying with the stale token.
   */
  | { action: "supersede"; token: string }
  /**
   * Reinstall detected server-side: our device id is unknown, so reset local
   * identity; the caller re-runs `registerDevice` with the OS token.
   */
  | { action: "reregister"; reason?: string };

/** Transport for server-side registration/reconciliation (injectable). */
export interface PushRemote {
  /**
   * Register (or rotate) the token for a device. Implementations should
   * treat a rotation for the same device id as an update, not a duplicate.
   */
  register(input: {
    deviceId: string;
    token: string;
    previousToken: string | null;
    preferences: PushPreferences;
  }): Promise<void>;
  /** Ask the server to stop delivering to a revoked/rotated token. */
  revoke(token: string, reason: string): Promise<void>;
}

export interface PushManagerOptions {
  namespace?: string;
  clock?: () => number;
  /** Random source for device ids; injectable for deterministic tests. */
  randomId?: () => string;
}

export class PushTokenManager {
  private readonly namespace: string;
  private readonly clock: () => number;
  private readonly randomId: () => string;

  constructor(
    private readonly storage: KeyValueStorage,
    options: PushManagerOptions = {},
  ) {
    this.namespace = options.namespace ?? "fundable.offline.push";
    this.clock = options.clock ?? Date.now;
    this.randomId =
      options.randomId ??
      (() => `dev-${Math.random().toString(36).slice(2, 12)}`);
  }

  key(): string {
    return `${this.namespace}.state`;
  }

  /** Current state, creating a fresh install record on first use. */
  async getState(): Promise<PushState> {
    const persisted = await readJSON<PersistedPushState>(
      this.storage,
      this.key(),
    );
    if (persisted?.state) return persisted.state;
    return {
      deviceId: this.randomId(),
      token: null,
      previousToken: null,
      permission: "undetermined",
      preferences: { ...DEFAULT_PUSH_PREFERENCES },
      revision: 1,
      updatedAt: this.clock(),
    };
  }

  /** Record the OS permission verdict (e.g. after a prompt or Settings). */
  async setPermission(permission: PushPermissionState): Promise<PushState> {
    const state = await this.getState();
    if (state.permission === permission) return state;
    const next: PushState = { ...state, permission };
    if (permission !== "granted") {
      // Withdrawn permission invalidates the token locally; the server copy
      // is retired lazily via `reconcile`.
      next.token = null;
      next.previousToken = state.token ?? state.previousToken;
    }
    return this.persist(next);
  }

  /**
   * Record a push token from the OS. Rotates the stored token when it
   * differs, keeping the old one as `previousToken` for server-side retire.
   */
  async registerDevice(token: string): Promise<RegisterOutcome> {
    const state = await this.getState();
    if (state.permission === "denied") {
      return { status: "blocked", permission: "denied" };
    }
    if (!token) {
      return { status: "blocked", permission: state.permission };
    }
    if (state.token === token) {
      return { status: "unchanged", token };
    }
    const previousToken = state.token;
    const next: PushState = {
      ...state,
      token,
      previousToken,
      // Permission becomes implicitly granted once a token arrives.
      permission:
        state.permission === "undetermined" ? "granted" : state.permission,
    };
    await this.persist(next);
    return previousToken
      ? { status: "rotated", token, previousToken }
      : { status: "registered", token };
  }

  /**
   * Revoke the local token (permission withdrawn, OS invalidated the token,
   * or the server rejected delivery). The previous token is preserved so the
   * server can be told to retire it during reconciliation.
   */
  async revokeToken(reason: string): Promise<PushState> {
    void reason; // carried for caller logging; state itself is shared.
    const state = await this.getState();
    if (!state.token && !state.previousToken) return state;
    const next: PushState = {
      ...state,
      previousToken: state.token ?? state.previousToken,
      token: null,
    };
    return this.persist(next);
  }

  /** Persist a per-device preference change. */
  async setPreference(
    key: PushPreferenceKey,
    enabled: boolean,
  ): Promise<PushState> {
    const state = await this.getState();
    if (state.preferences[key] === enabled) return state;
    const next: PushState = {
      ...state,
      preferences: { ...state.preferences, [key]: enabled },
    };
    return this.persist(next);
  }

  async getPreferences(): Promise<PushPreferences> {
    return (await this.getState()).preferences;
  }

  /**
   * Push local state to the server, then apply its reconciliation verdict.
   *
   * Order matters: we always send the freshest local token first so the
   * server can distinguish rotation from reinstall, then apply the verdict
   * (`keep` / `revoke` / `supersede` / `reregister`) to local state.
   */
  async reconcile(
    remote: PushRemote,
    serverVerdict: (input: {
      deviceId: string;
      token: string | null;
      previousToken: string | null;
      preferences: PushPreferences;
    }) => Promise<PushReconcileResult>,
  ): Promise<{ state: PushState; outcome: PushReconcileResult }> {
    const state = await this.getState();

    if (state.token) {
      await remote.register({
        deviceId: state.deviceId,
        token: state.token,
        previousToken: state.previousToken,
        preferences: state.preferences,
      });
      if (state.previousToken) {
        await remote.revoke(state.previousToken, "rotated").catch(() => {});
      }
    }

    const verdict = await serverVerdict({
      deviceId: state.deviceId,
      token: state.token,
      previousToken: state.previousToken,
      preferences: state.preferences,
    });

    let next: PushState = state;
    switch (verdict.action) {
      case "revoke":
        next = {
          ...state,
          previousToken: state.token ?? state.previousToken,
          token: null,
        };
        break;
      case "supersede":
        next = {
          ...state,
          token: verdict.token,
          previousToken: state.token,
        };
        break;
      case "reregister":
        // Simulate a reinstall: fresh device identity, no token. The caller
        // re-runs `registerDevice` with the OS token afterwards.
        next = {
          ...state,
          deviceId: this.randomId(),
          token: null,
          previousToken: state.token,
        };
        break;
      case "keep":
        next = state;
        break;
    }
    const persisted = next === state ? state : await this.persist(next);
    return { state: persisted, outcome: verdict };
  }

  private async persist(state: PushState): Promise<PushState> {
    const next: PushState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: this.clock(),
    };
    await writeJSON<PersistedPushState>(this.storage, this.key(), {
      version: 1,
      state: next,
    });
    return next;
  }
}

interface PersistedPushState {
  version: 1;
  state: PushState;
}

/** Outcome of a `registerDevice` call. */
export type RegisterOutcome =
  | { status: "registered"; token: string }
  | { status: "rotated"; token: string; previousToken: string }
  | { status: "unchanged"; token: string }
  /** Registration blocked: no permission or empty token. */
  | { status: "blocked"; permission: PushPermissionState };
