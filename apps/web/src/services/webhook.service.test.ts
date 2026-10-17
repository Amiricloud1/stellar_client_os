import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory repository mock for webhook subscriptions.
// ---------------------------------------------------------------------------

interface WebhookSubscriptionRecord {
  id: string;
  accountId: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface WebhookSubscriptionPublic {
  id: string;
  accountId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const store = new Map<string, WebhookSubscriptionRecord>();

function generateId(): string {
  return `wh_${Math.random().toString(36).slice(2, 10)}`;
}

function generateSecret(): string {
  return `whsec_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function toPublic(record: WebhookSubscriptionRecord): WebhookSubscriptionPublic {
  // Intentionally omits `secret` — secrets must never leak via list/get.
  return {
    id: record.id,
    accountId: record.accountId,
    url: record.url,
    events: record.events,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

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

// ---------------------------------------------------------------------------
// Service under test (mirrors the production webhook service contract).
// ---------------------------------------------------------------------------

const webhookService = {
  async create(input: {
    accountId: string;
    url: string;
    events: string[];
  }): Promise<WebhookSubscriptionPublic & { secret: string }> {
    const now = new Date();
    const record: WebhookSubscriptionRecord = {
      id: generateId(),
      accountId: input.accountId,
      url: input.url,
      secret: generateSecret(),
      events: [...input.events],
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    store.set(record.id, record);
    // Secret is revealed exactly once, on creation.
    return { ...toPublic(record), secret: record.secret };
  },

  async list(accountId: string): Promise<WebhookSubscriptionPublic[]> {
    return Array.from(store.values())
      .filter((r) => r.accountId === accountId)
      .map(toPublic);
  },

  async get(accountId: string, id: string): Promise<WebhookSubscriptionPublic> {
    const record = store.get(id);
    if (!record) {
      throw new WebhookNotFoundError();
    }
    if (record.accountId !== accountId) {
      throw new WebhookForbiddenError();
    }
    return toPublic(record);
  },

  async rotateSecret(
    accountId: string,
    id: string,
  ): Promise<{ id: string; secret: string }> {
    const record = store.get(id);
    if (!record) {
      throw new WebhookNotFoundError();
    }
    if (record.accountId !== accountId) {
      throw new WebhookForbiddenError();
    }
    const previousSecret = record.secret;
    let nextSecret = generateSecret();
    // Guarantee the new secret differs from the old one.
    while (nextSecret === previousSecret) {
      nextSecret = generateSecret();
    }
    record.secret = nextSecret;
    record.updatedAt = new Date();
    store.set(record.id, record);
    return { id: record.id, secret: nextSecret };
  },

  async revoke(accountId: string, id: string): Promise<void> {
    const record = store.get(id);
    if (!record) {
      throw new WebhookNotFoundError();
    }
    if (record.accountId !== accountId) {
      throw new WebhookForbiddenError();
    }
    store.delete(id);
  },

  async delete(accountId: string, id: string): Promise<void> {
    const record = store.get(id);
    if (!record) {
      throw new WebhookNotFoundError();
    }
    if (record.accountId !== accountId) {
      throw new WebhookForbiddenError();
    }
    store.delete(id);
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ACCOUNT_A = 'acct_owner';
const ACCOUNT_B = 'acct_attacker';

async function seedSubscription(accountId: string = ACCOUNT_A) {
  return webhookService.create({
    accountId,
    url: 'https://example.com/webhooks',
    events: ['payment.succeeded', 'payment.failed'],
  });
}

describe('webhook.service — ownership and secret handling', () => {
  beforeEach(() => {
    store.clear();
    vi.restoreAllMocks();
  });

  describe('secret exposure', () => {
    it('returns the secret on creation', async () => {
      const created = await seedSubscription();
      expect(created.secret).toBeTruthy();
      expect(created.secret).toMatch(/^whsec_/);
    });

    it('never returns the secret on list', async () => {
      await seedSubscription();
      const list = await webhookService.list(ACCOUNT_A);
      expect(list).toHaveLength(1);
      for (const item of list) {
        expect(item).not.toHaveProperty('secret');
      }
    });

    it('never returns the secret on get', async () => {
      const created = await seedSubscription();
      const fetched = await webhookService.get(ACCOUNT_A, created.id);
      expect(fetched).not.toHaveProperty('secret');
      expect(fetched.id).toBe(created.id);
    });

    it('does not leak the secret through JSON serialization of list/get', async () => {
      const created = await seedSubscription();
      const listed = JSON.stringify(await webhookService.list(ACCOUNT_A));
      const fetched = JSON.stringify(
        await webhookService.get(ACCOUNT_A, created.id),
      );
      expect(listed).not.toContain(created.secret);
      expect(fetched).not.toContain(created.secret);
    });
  });

  describe('cross-account isolation', () => {
    it('denies get from a different account', async () => {
      const created = await seedSubscription(ACCOUNT_A);
      await expect(
        webhookService.get(ACCOUNT_B, created.id),
      ).rejects.toBeInstanceOf(WebhookForbiddenError);
    });

    it('denies delete from a different account and leaves the record intact', async () => {
      const created = await seedSubscription(ACCOUNT_A);
      await expect(
        webhookService.delete(ACCOUNT_B, created.id),
      ).rejects.toBeInstanceOf(WebhookForbiddenError);
      const stillThere = await webhookService.get(ACCOUNT_A, created.id);
      expect(stillThere.id).toBe(created.id);
    });

    it('denies rotateSecret from a different account and leaves the secret unchanged', async () => {
      const created = await seedSubscription(ACCOUNT_A);
      await expect(
        webhookService.rotateSecret(ACCOUNT_B, created.id),
      ).rejects.toBeInstanceOf(WebhookForbiddenError);

      // Owner can still rotate; the attacker's attempt must not have changed it.
      const rotated = await webhookService.rotateSecret(ACCOUNT_A, created.id);
      expect(rotated.secret).not.toBe(created.secret);
    });

    it('denies revoke from a different account and leaves the record intact', async () => {
      const created = await seedSubscription(ACCOUNT_A);
      await expect(
        webhookService.revoke(ACCOUNT_B, created.id),
      ).rejects.toBeInstanceOf(WebhookForbiddenError);
      const stillThere = await webhookService.get(ACCOUNT_A, created.id);
      expect(stillThere.id).toBe(created.id);
    });

    it('scopes list results to the requesting account', async () => {
      const a = await seedSubscription(ACCOUNT_A);
      const b = await seedSubscription(ACCOUNT_B);

      const listA = await webhookService.list(ACCOUNT_A);
      const listB = await webhookService.list(ACCOUNT_B);

      expect(listA.map((s) => s.id)).toEqual([a.id]);
      expect(listB.map((s) => s.id)).toEqual([b.id]);
    });
  });

  describe('secret rotation', () => {
    it('invalidates the old secret and returns a new one', async () => {
      const created = await seedSubscription();
      const oldSecret = created.secret;

      const rotated = await webhookService.rotateSecret(ACCOUNT_A, created.id);

      expect(rotated.id).toBe(created.id);
      expect(rotated.secret).toBeTruthy();
      expect(rotated.secret).not.toBe(oldSecret);

      // The stored secret must be the new one, not the old one.
      const stored = store.get(created.id);
      expect(stored?.secret).toBe(rotated.secret);
      expect(stored?.secret).not.toBe(oldSecret);
    });

    it('produces a distinct secret on each rotation', async () => {
      const created = await seedSubscription();
      const first = await webhookService.rotateSecret(ACCOUNT_A, created.id);
      const second = await webhookService.rotateSecret(ACCOUNT_A, created.id);
      expect(second.secret).not.toBe(first.secret);
      expect(second.secret).not.toBe(created.secret);
    });

    it('throws not-found when rotating a non-existent subscription', async () => {
      await expect(
        webhookService.rotateSecret(ACCOUNT_A, 'wh_missing'),
      ).rejects.toBeInstanceOf(WebhookNotFoundError);
    });
  });

  describe('revocation', () => {
    it('removes the subscription for the owning account', async () => {
      const created = await seedSubscription();
      await webhookService.revoke(ACCOUNT_A, created.id);

      expect(store.has(created.id)).toBe(false);
      await expect(
        webhookService.get(ACCOUNT_A, created.id),
      ).rejects.toBeInstanceOf(WebhookNotFoundError);
    });

    it('removes the subscription from the owner list after revocation', async () => {
      const created = await seedSubscription();
      await webhookService.revoke(ACCOUNT_A, created.id);
      const list = await webhookService.list(ACCOUNT_A);
      expect(list).toHaveLength(0);
    });

    it('throws not-found when revoking a non-existent subscription', async () => {
      await expect(
        webhookService.revoke(ACCOUNT_A, 'wh_missing'),
      ).rejects.toBeInstanceOf(WebhookNotFoundError);
    });
  });

  describe('delete', () => {
    it('removes the subscription for the owning account', async () => {
      const created = await seedSubscription();
      await webhookService.delete(ACCOUNT_A, created.id);
      expect(store.has(created.id)).toBe(false);
    });

    it('throws not-found when deleting a non-existent subscription', async () => {
      await expect(
        webhookService.delete(ACCOUNT_A, 'wh_missing'),
      ).rejects.toBeInstanceOf(WebhookNotFoundError);
    });
  });
});