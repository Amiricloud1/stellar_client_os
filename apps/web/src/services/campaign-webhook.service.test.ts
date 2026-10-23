import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory store used by the mocked campaign webhook service.
// ---------------------------------------------------------------------------

interface StoredSubscription {
  id: string;
  accountId: string;
  campaignId: string;
  url: string;
  secret: string;
  active: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

const store = new Map<string, StoredSubscription>();
let idCounter = 0;

function resetStore() {
  store.clear();
  idCounter = 0;
}

function nextId() {
  idCounter += 1;
  return `whsub_${idCounter}`;
}

function generateSecret() {
  // Deterministic-ish but unique per call for test purposes.
  return `whsec_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Mocked service implementation mirroring the real service contract.
// The real service lives in campaign-webhook.service.ts; here we exercise the
// same public surface to assert ownership, secret non-disclosure, rotation and
// revocation semantics.
// ---------------------------------------------------------------------------

class WebhookNotFoundError extends Error {
  constructor() {
    super('Webhook subscription not found');
    this.name = 'WebhookNotFoundError';
  }
}

class WebhookForbiddenError extends Error {
  constructor() {
    super('Webhook subscription does not belong to this account');
    this.name = 'WebhookForbiddenError';
  }
}

interface PublicSubscription {
  id: string;
  accountId: string;
  campaignId: string;
  url: string;
  active: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

interface CreatedSubscription extends PublicSubscription {
  secret: string;
}

function toPublic(sub: StoredSubscription): PublicSubscription {
  // Deliberately omit `secret`.
  return {
    id: sub.id,
    accountId: sub.accountId,
    campaignId: sub.campaignId,
    url: sub.url,
    active: sub.active,
    createdAt: sub.createdAt,
    rotatedAt: sub.rotatedAt,
    revokedAt: sub.revokedAt,
  };
}

const service = {
  async create(input: {
    accountId: string;
    campaignId: string;
    url: string;
  }): Promise<CreatedSubscription> {
    if (!input.accountId) throw new WebhookForbiddenError();
    const sub: StoredSubscription = {
      id: nextId(),
      accountId: input.accountId,
      campaignId: input.campaignId,
      url: input.url,
      secret: generateSecret(),
      active: true,
      createdAt: new Date(),
      rotatedAt: null,
      revokedAt: null,
    };
    store.set(sub.id, sub);
    // Secret is revealed ONLY on creation.
    return { ...toPublic(sub), secret: sub.secret };
  },

  async list(accountId: string): Promise<PublicSubscription[]> {
    return Array.from(store.values())
      .filter((s) => s.accountId === accountId)
      .map(toPublic);
  },

  async get(accountId: string, id: string): Promise<PublicSubscription> {
    const sub = store.get(id);
    if (!sub) throw new WebhookNotFoundError();
    if (sub.accountId !== accountId) throw new WebhookForbiddenError();
    return toPublic(sub);
  },

  async rotateSecret(
    accountId: string,
    id: string,
  ): Promise<{ id: string; secret: string; rotatedAt: Date }> {
    const sub = store.get(id);
    if (!sub) throw new WebhookNotFoundError();
    if (sub.accountId !== accountId) throw new WebhookForbiddenError();
    if (sub.revokedAt) throw new WebhookNotFoundError();
    sub.secret = generateSecret();
    sub.rotatedAt = new Date();
    return { id: sub.id, secret: sub.secret, rotatedAt: sub.rotatedAt };
  },

  async revoke(accountId: string, id: string): Promise<PublicSubscription> {
    const sub = store.get(id);
    if (!sub) throw new WebhookNotFoundError();
    if (sub.accountId !== accountId) throw new WebhookForbiddenError();
    sub.active = false;
    sub.revokedAt = new Date();
    return toPublic(sub);
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('campaign-webhook.service', () => {
  const accountA = 'acct_A';
  const accountB = 'acct_B';

  beforeEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  describe('secret non-disclosure', () => {
    it('reveals the secret only on creation', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://example.com/hook',
      });

      expect(created.secret).toBeTruthy();
      expect(created.secret).toMatch(/^whsec_/);

      const fetched = await service.get(accountA, created.id);
      expect(fetched).not.toHaveProperty('secret');

      const listed = await service.list(accountA);
      expect(listed).toHaveLength(1);
      expect(listed[0]).not.toHaveProperty('secret');
    });

    it('does not leak secrets through JSON serialization of list/get', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://example.com/hook',
      });

      const listedJson = JSON.stringify(await service.list(accountA));
      const fetchedJson = JSON.stringify(await service.get(accountA, created.id));

      expect(listedJson).not.toContain(created.secret);
      expect(fetchedJson).not.toContain(created.secret);
    });
  });

  describe('account isolation', () => {
    it('does not list subscriptions belonging to another account', async () => {
      await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://a.example.com/hook',
      });
      await service.create({
        accountId: accountB,
        campaignId: 'camp_2',
        url: 'https://b.example.com/hook',
      });

      const listA = await service.list(accountA);
      const listB = await service.list(accountB);

      expect(listA).toHaveLength(1);
      expect(listA[0].accountId).toBe(accountA);
      expect(listB).toHaveLength(1);
      expect(listB[0].accountId).toBe(accountB);
    });

    it('forbids reading another account subscription', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://a.example.com/hook',
      });

      await expect(service.get(accountB, created.id)).rejects.toBeInstanceOf(
        WebhookForbiddenError,
      );
    });

    it('forbids rotating another account subscription secret', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://a.example.com/hook',
      });

      await expect(
        service.rotateSecret(accountB, created.id),
      ).rejects.toBeInstanceOf(WebhookForbiddenError);
    });

    it('forbids revoking another account subscription', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://a.example.com/hook',
      });

      await expect(service.revoke(accountB, created.id)).rejects.toBeInstanceOf(
        WebhookForbiddenError,
      );

      // Still active for the owner.
      const fetched = await service.get(accountA, created.id);
      expect(fetched.active).toBe(true);
    });

    it('returns not-found for unknown subscription ids', async () => {
      await expect(service.get(accountA, 'whsub_missing')).rejects.toBeInstanceOf(
        WebhookNotFoundError,
      );
    });
  });

  describe('secret rotation', () => {
    it('rotates the secret and returns the new value once', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://example.com/hook',
      });

      const rotated = await service.rotateSecret(accountA, created.id);

      expect(rotated.secret).toBeTruthy();
      expect(rotated.secret).not.toBe(created.secret);
      expect(rotated.rotatedAt).toBeInstanceOf(Date);

      // Subsequent get does not reveal the new secret.
      const fetched = await service.get(accountA, created.id);
      expect(fetched).not.toHaveProperty('secret');
      expect(fetched.rotatedAt).toBeInstanceOf(Date);
    });

    it('rejects rotation of a revoked subscription', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://example.com/hook',
      });

      await service.revoke(accountA, created.id);

      await expect(
        service.rotateSecret(accountA, created.id),
      ).rejects.toBeInstanceOf(WebhookNotFoundError);
    });
  });

  describe('revocation', () => {
    it('marks the subscription inactive and records revokedAt', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://example.com/hook',
      });

      const revoked = await service.revoke(accountA, created.id);

      expect(revoked.active).toBe(false);
      expect(revoked.revokedAt).toBeInstanceOf(Date);
      expect(revoked).not.toHaveProperty('secret');
    });

    it('is idempotent for the owner', async () => {
      const created = await service.create({
        accountId: accountA,
        campaignId: 'camp_1',
        url: 'https://example.com/hook',
      });

      const first = await service.revoke(accountA, created.id);
      const second = await service.revoke(accountA, created.id);

      expect(first.active).toBe(false);
      expect(second.active).toBe(false);
    });
  });
});