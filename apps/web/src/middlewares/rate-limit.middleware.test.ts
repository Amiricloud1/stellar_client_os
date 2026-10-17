import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  createRateLimitMiddleware,
  resolveClientIp,
  getRouteClassPolicy,
  type RateLimitPolicy,
  type RateLimitStore,
} from './rate-limit.middleware';

type MockRes = Response & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status: (code: number) => MockRes;
  setHeader: (name: string, value: string | number) => MockRes;
  json: (body: unknown) => MockRes;
  end: () => MockRes;
};

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/',
    ip: '203.0.113.10',
    headers: {},
    socket: { remoteAddress: '203.0.113.10' },
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): MockRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string | number) {
      res.headers[name.toLowerCase()] = String(value);
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as MockRes;
  return res;
}

function createMockNext(): NextFunction & { calls: number } {
  const fn = vi.fn() as unknown as NextFunction & { calls: number };
  Object.defineProperty(fn, 'calls', {
    get() {
      return (fn as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    },
  });
  return fn;
}

class InMemoryStore implements RateLimitStore {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = this.now();
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) {
      const entry = { count: 1, resetAt: now + windowMs };
      this.hits.set(key, entry);
      return { ...entry };
    }
    existing.count += 1;
    return { ...existing };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }
}

describe('resolveClientIp', () => {
  const trustedProxies = ['10.0.0.0/8', '192.168.0.0/16'];

  it('uses socket address when no forwarded header is present', () => {
    const req = createMockReq({
      ip: '203.0.113.10',
      socket: { remoteAddress: '203.0.113.10' } as never,
      headers: {},
    });
    expect(resolveClientIp(req, { trustedProxies })).toBe('203.0.113.10');
  });

  it('honours X-Forwarded-For when the peer is a trusted proxy', () => {
    const req = createMockReq({
      ip: '10.1.2.3',
      socket: { remoteAddress: '10.1.2.3' } as never,
      headers: { 'x-forwarded-for': '198.51.100.7, 10.1.2.3' },
    });
    expect(resolveClientIp(req, { trustedProxies })).toBe('198.51.100.7');
  });

  it('ignores X-Forwarded-For when the peer is untrusted', () => {
    const req = createMockReq({
      ip: '203.0.113.10',
      socket: { remoteAddress: '203.0.113.10' } as never,
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(resolveClientIp(req, { trustedProxies })).toBe('203.0.113.10');
  });

  it('walks the forwarded chain skipping trusted hops', () => {
    const req = createMockReq({
      ip: '10.1.2.3',
      socket: { remoteAddress: '10.1.2.3' } as never,
      headers: { 'x-forwarded-for': '198.51.100.7, 192.168.1.1, 10.1.2.3' },
    });
    expect(resolveClientIp(req, { trustedProxies })).toBe('198.51.100.7');
  });

  it('falls back to the leftmost forwarded value when all hops are trusted', () => {
    const req = createMockReq({
      ip: '10.1.2.3',
      socket: { remoteAddress: '10.1.2.3' } as never,
      headers: { 'x-forwarded-for': '10.9.9.9, 10.1.2.3' },
    });
    expect(resolveClientIp(req, { trustedProxies })).toBe('10.9.9.9');
  });

  it('ignores malformed forwarded entries', () => {
    const req = createMockReq({
      ip: '10.1.2.3',
      socket: { remoteAddress: '10.1.2.3' } as never,
      headers: { 'x-forwarded-for': 'not-an-ip, 198.51.100.7' },
    });
    expect(resolveClientIp(req, { trustedProxies })).toBe('198.51.100.7');
  });
});

describe('getRouteClassPolicy', () => {
  it('returns a stricter policy for auth routes than read routes', () => {
    const auth = getRouteClassPolicy('auth');
    const read = getRouteClassPolicy('read');
    expect(auth.limit).toBeLessThan(read.limit);
    expect(auth.windowMs).toBeGreaterThanOrEqual(read.windowMs);
  });

  it('returns a policy for every known route class', () => {
    const classes = ['auth', 'write', 'read', 'public'] as const;
    for (const cls of classes) {
      const policy = getRouteClassPolicy(cls);
      expect(policy.limit).toBeGreaterThan(0);
      expect(policy.windowMs).toBeGreaterThan(0);
    }
  });
});

describe('createRateLimitMiddleware', () => {
  let now: number;
  let clock: () => number;
  let store: InMemoryStore;

  beforeEach(() => {
    now = 1_700_000_000_000;
    clock = () => now;
    store = new InMemoryStore(clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function build(policy: RateLimitPolicy, trustedProxies: string[] = []) {
    return createRateLimitMiddleware({
      policy,
      store,
      now: clock,
      trustedProxies,
      routeClass: 'read',
    });
  }

  it('allows requests under the limit and sets standard RateLimit-* headers', async () => {
    const policy: RateLimitPolicy = { limit: 3, windowMs: 60_000 };
    const mw = build(policy);
    const req = createMockReq();
    const res = createMockRes();
    const next = createMockNext();

    await mw(req, res, next);

    expect(next.calls).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('3');
    expect(res.headers['ratelimit-remaining']).toBe('2');
    expect(res.headers['ratelimit-reset']).toBeDefined();
    expect(res.headers['ratelimit-policy']).toBe('3;w=60');
  });

  it('rejects requests over the limit with 429 and Retry-After', async () => {
    const policy: RateLimitPolicy = { limit: 2, windowMs: 60_000 };
    const mw = build(policy);
    const req = createMockReq();
    const next = createMockNext();

    await mw(req, createMockRes(), next);
    await mw(req, createMockRes(), next);

    const res = createMockRes();
    await mw(req, res, next);

    expect(next.calls).toBe(2);
    expect(res.statusCode).toBe(429);
    expect(res.headers['ratelimit-limit']).toBe('2');
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toMatchObject({ error: 'rate_limited' });
  });

  it('reports accurate reset timing as the window elapses', async () => {
    const policy: RateLimitPolicy = { limit: 5, windowMs: 60_000 };
    const mw = build(policy);
    const req = createMockReq();

    const res1 = createMockRes();
    await mw(req, res1, createMockNext());
    const reset1 = Number(res1.headers['ratelimit-reset']);
    expect(reset1).toBe(Math.ceil((now + 60_000) / 1000));

    now += 30_000;
    const res2 = createMockRes();
    await mw(req, res2, createMockNext());
    const reset2 = Number(res2.headers['ratelimit-reset']);
    expect(reset2).toBe(reset1);
    expect(res2.headers['ratelimit-remaining']).toBe('3');
  });

  it('resets the counter after the window expires', async () => {
    const policy: RateLimitPolicy = { limit: 1, windowMs: 10_000 };
    const mw = build(policy);
    const req = createMockReq();

    await mw(req, createMockRes(), createMockNext());
    const blocked = createMockRes();
    await mw(req, blocked, createMockNext());
    expect(blocked.statusCode).toBe(429);

    now += 10_001;
    const res = createMockRes();
    const next = createMockNext();
    await mw(req, res, next);
    expect(next.calls).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-remaining']).toBe('0');
  });

  it('computes Retry-After from the remaining window on 429', async () => {
    const policy: RateLimitPolicy = { limit: 1, windowMs: 30_000 };
    const mw = build(policy);
    const req = createMockReq();

    await mw(req, createMockRes(), createMockNext());
    now += 12_000;
    const res = createMockRes();
    await mw(req, res, createMockNext());

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('18');
  });

  it('keys limits by resolved client IP behind a trusted proxy', async () => {
    const policy: RateLimitPolicy = { limit: 1, windowMs: 60_000 };
    const mw = build(policy, ['10.0.0.0/8']);

    const proxyReq = (forwarded: string) =>
      createMockReq({
        ip: '10.1.2.3',
        socket: { remoteAddress: '10.1.2.3' } as never,
        headers: { 'x-forwarded-for': forwarded },
      });

    const first = createMockRes();
    await mw(proxyReq('198.51.100.7'), first, createMockNext());
    expect(first.statusCode).toBe(200);

    const second = createMockRes();
    await mw(proxyReq('198.51.100.7'), second, createMockNext());
    expect(second.statusCode).toBe(429);

    const other = createMockRes();
    await mw(proxyReq('198.51.100.8'), other, createMockNext());
    expect(other.statusCode).toBe(200);
  });

  it('does not let untrusted peers spoof identity via X-Forwarded-For', async () => {
    const policy: RateLimitPolicy = { limit: 1, windowMs: 60_000 };
    const mw = build(policy, ['10.0.0.0/8']);

    const spoof = (forwarded: string) =>
      createMockReq({
        ip: '203.0.113.10',
        socket: { remoteAddress: '203.0.113.10' } as never,
        headers: { 'x-forwarded-for': forwarded },
      });

    await mw(spoof('198.51.100.7'), createMockRes(), createMockNext());
    const res = createMockRes();
    await mw(spoof('198.51.100.8'), res, createMockNext());
    expect(res.statusCode).toBe(429);
  });

  it('applies route-class specific limits', async () => {
    const authMw = createRateLimitMiddleware({
      policy: getRouteClassPolicy('auth'),
      store,
      now: clock,
      trustedProxies: [],
      routeClass: 'auth',
    });
    const readMw = createRateLimitMiddleware({
      policy: getRouteClassPolicy('read'),
      store,
      now: clock,
      trustedProxies: [],
      routeClass: 'read',
    });

    const authPolicy = getRouteClassPolicy('auth');
    const readPolicy = getRouteClassPolicy('read');

    const authReq = createMockReq({ path: '/auth/login' });
    for (let i = 0; i < authPolicy.limit; i += 1) {
      await authMw(authReq, createMockRes(), createMockNext());
    }
    const authBlocked = createMockRes();
    await authMw(authReq, authBlocked, createMockNext());
    expect(authBlocked.statusCode).toBe(429);

    const readReq = createMockReq({ path: '/items' });
    const readRes = createMockRes();
    await readMw(readReq, readRes, createMockNext());
    expect(readRes.statusCode).toBe(200);
    expect(readRes.headers['ratelimit-limit']).toBe(String(readPolicy.limit));
  });

  it('keeps route classes isolated in the store', async () => {
    const policy: RateLimitPolicy = { limit: 1, windowMs: 60_000 };
    const authMw = createRateLimitMiddleware({
      policy,
      store,
      now: clock,
      trustedProxies: [],
      routeClass: 'auth',
    });
    const readMw = createRateLimitMiddleware({
      policy,
      store,
      now: clock,
      trustedProxies: [],
      routeClass: 'read',
    });

    const req = createMockReq();
    await authMw(req, createMockRes(), createMockNext());
    const readRes = createMockRes();
    await readMw(req, readRes, createMockNext());
    expect(readRes.statusCode).toBe(200);
  });
});