import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractTraceContext,
  injectTraceHeaders,
  createChildContext,
  runWithTrace,
  getActiveTrace,
  generateTraceId,
  generateSpanId,
} from './trace-context';
import { Span, SpanRecorder, withSpan } from './span';
import {
  sanitizeString,
  sanitizeObject,
  sanitizeHeaders,
  sanitizeSpanAttributes,
  isSensitiveKey,
} from './sanitizer';
import { withApiTracing } from './trace-middleware';
import { NextRequest } from 'next/server';

describe('Distributed Tracing & Context Propagation', () => {
  beforeEach(() => {
    SpanRecorder.getInstance().clear();
  });

  describe('TraceContext', () => {
    it('extracts valid W3C traceparent and request correlation headers', () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const parentSpanId = '00f067aa0ba902b7';
      const headers = {
        traceparent: `00-${traceId}-${parentSpanId}-01`,
        'x-request-id': 'req_custom_123',
        'x-correlation-id': 'corr_abc_456',
      };

      const ctx = extractTraceContext(headers);

      expect(ctx.traceId).toBe(traceId);
      expect(ctx.parentSpanId).toBe(parentSpanId);
      expect(ctx.traceFlags).toBe('01');
      expect(ctx.requestId).toBe('req_custom_123');
      expect(ctx.correlationId).toBe('corr_abc_456');
      expect(ctx.spanId).toHaveLength(16);
    });

    it('generates new trace IDs and request ID when headers are missing', () => {
      const ctx = extractTraceContext({});

      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.requestId).toMatch(/^req_[0-9a-f]{16}$/);
      expect(ctx.correlationId).toBe(ctx.requestId);
      expect(ctx.parentSpanId).toBeUndefined();
    });

    it('handles malformed traceparent gracefully by falling back to new context', () => {
      const headers = {
        traceparent: 'malformed-traceparent-value',
      };

      const ctx = extractTraceContext(headers);

      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.parentSpanId).toBeUndefined();
    });

    it('creates child context preserving traceId and correlationId with fresh spanId', () => {
      const parent = extractTraceContext({});
      const child = createChildContext(parent);

      expect(child.traceId).toBe(parent.traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
      expect(child.requestId).toBe(parent.requestId);
      expect(child.correlationId).toBe(parent.correlationId);
      expect(child.spanId).not.toBe(parent.spanId);
      expect(child.spanId).toHaveLength(16);
    });

    it('injects W3C traceparent and correlation headers into outgoing header map', () => {
      const ctx = extractTraceContext({
        'x-request-id': 'req_test_888',
      });
      const outgoing = injectTraceHeaders(ctx, { 'Content-Type': 'application/json' });

      expect(outgoing['Content-Type']).toBe('application/json');
      expect(outgoing['traceparent']).toBe(`00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`);
      expect(outgoing['x-request-id']).toBe('req_test_888');
      expect(outgoing['x-trace-id']).toBe(ctx.traceId);
      expect(outgoing['x-correlation-id']).toBe('req_test_888');
    });

    it('propagates active trace context via AsyncLocalStorage across async boundaries', async () => {
      const ctx = extractTraceContext({});

      expect(getActiveTrace()).toBeUndefined();

      await runWithTrace(ctx, async () => {
        expect(getActiveTrace()).toEqual(ctx);

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(getActiveTrace()).toEqual(ctx);
      });

      expect(getActiveTrace()).toBeUndefined();
    });
  });

  describe('Span Lifecycle & Latency Measurement', () => {
    it('measures latency and records span status and attributes', async () => {
      const ctx = extractTraceContext({});
      const span = new Span(ctx, 'stellar.rpc.simulate');

      span.setAttribute('rpc.method', 'simulateTransaction');
      await new Promise((resolve) => setTimeout(resolve, 15));
      const data = span.end('ok');

      expect(data.name).toBe('stellar.rpc.simulate');
      expect(data.status).toBe('ok');
      expect(data.durationMs).toBeGreaterThanOrEqual(10);
      expect(data.attributes['rpc.method']).toBe('simulateTransaction');

      const recorded = SpanRecorder.getInstance().getSpans();
      expect(recorded).toHaveLength(1);
      expect(recorded[0].spanId).toBe(ctx.spanId);
    });

    it('records sanitized exception on failure with withSpan helper', async () => {
      const secretKey = 'S' + 'B'.repeat(55);
      await expect(
        withSpan('test.operation', async () => {
          throw new Error(`Failed with secret seed: ${secretKey}`);
        })
      ).rejects.toThrow();

      const spans = SpanRecorder.getInstance().getSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toBe('error');
      expect(spans[0].error?.message).toContain('[REDACTED_SECRET_KEY]');
      expect(spans[0].error?.message).not.toContain(secretKey);
    });
  });

  describe('Data Exclusion and Sanitization (Security Scope)', () => {
    const dummySecret = 'SB000000000000000000000000000000000000000000000000000000';
    const dummyPublic = 'GB000000000000000000000000000000000000000000000000000000';

    it('redacts Stellar secret keys unconditionally', () => {
      const input = `Stellar secret seed: ${dummySecret} used for sign`;
      const sanitized = sanitizeString(input);

      expect(sanitized).not.toContain(dummySecret);
      expect(sanitized).toContain('[REDACTED_SECRET_KEY]');
    });

    it('masks or truncates Stellar public keys', () => {
      const input = `Account address: ${dummyPublic}`;
      const sanitized = sanitizeString(input);

      expect(sanitized).not.toContain(dummyPublic);
      expect(sanitized).toContain('GB00...0000');
    });

    it('redacts personal identifiers (PII): emails, phone numbers, and SSN/Tax IDs', () => {
      const input = 'Contact alice.doe@example.com at +1 (555) 234-5678 or SSN 123-45-6789';
      const sanitized = sanitizeString(input);

      expect(sanitized).not.toContain('alice.doe@example.com');
      expect(sanitized).toContain('[REDACTED_EMAIL]');
      expect(sanitized).not.toContain('123-45-6789');
      expect(sanitized).toContain('[REDACTED_TAX_ID]');
      expect(sanitized).toContain('[REDACTED_PHONE]');
    });

    it('redacts bearer tokens and query parameter credentials', () => {
      const input = 'https://api.stellar.org/rpc?apiKey=super_secret_key&token=mytoken123 with Bearer eyJhbGciOi...';
      const sanitized = sanitizeString(input);

      expect(sanitized).toContain('apiKey=[REDACTED]');
      expect(sanitized).toContain('token=[REDACTED]');
      expect(sanitized).toContain('Bearer [REDACTED_TOKEN]');
    });

    it('redacts sensitive object keys in nested payloads', () => {
      const payload = {
        campaignId: 'camp_123',
        creator: {
          email: 'founder@example.org',
          private_key: dummySecret,
          mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        webhook_secret: 'whsec_999999999',
        stats: {
          donations: 500,
        },
      };

      const sanitized = sanitizeObject(payload);

      expect(sanitized.creator.private_key).toBe('[REDACTED_SECRET]');
      expect(sanitized.creator.mnemonic).toBe('[REDACTED_SECRET]');
      expect(sanitized.webhook_secret).toBe('[REDACTED_SECRET]');
      expect(sanitized.creator.email).toBe('[REDACTED_EMAIL]');
      expect(sanitized.campaignId).toBe('camp_123');
      expect(sanitized.stats.donations).toBe(500);
    });

    it('sanitizes headers to exclude authorization and cookies', () => {
      const headers = {
        Authorization: 'Bearer secret_token_xyz',
        Cookie: 'session_id=12345; auth=token',
        'X-Request-Id': 'req_safe_999',
      };

      const sanitized = sanitizeHeaders(headers);

      expect(sanitized['authorization']).toBe('[REDACTED_HEADER]');
      expect(sanitized['cookie']).toBe('[REDACTED_HEADER]');
      expect(sanitized['x-request-id']).toBe('req_safe_999');
    });

    it('identifies sensitive key variants accurately', () => {
      expect(isSensitiveKey('secretKey')).toBe(true);
      expect(isSensitiveKey('private_key')).toBe(true);
      expect(isSensitiveKey('seed_phrase')).toBe(true);
      expect(isSensitiveKey('api_key')).toBe(true);
      expect(isSensitiveKey('webhook_secret')).toBe(true);
      expect(isSensitiveKey('campaignId')).toBe(false);
      expect(isSensitiveKey('status')).toBe(false);
    });
  });

  describe('withApiTracing Middleware Wrapper', () => {
    it('correlates incoming API request and injects headers on response', async () => {
      const mockHandler = vi.fn().mockImplementation(async () => {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const wrapped = withApiTracing('testEndpoint', mockHandler);

      const req = new NextRequest('https://app.fundable.org/api/campaigns', {
        headers: {
          'x-request-id': 'req_incoming_123',
        },
      });

      const response = await wrapped(req);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe('req_incoming_123');
      expect(response.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      const spans = SpanRecorder.getInstance().getSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('api.testEndpoint');
      expect(spans[0].status).toBe('ok');
      expect(spans[0].attributes['http.status_code']).toBe(200);
    });
  });
});
