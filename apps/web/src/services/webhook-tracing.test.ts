import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebhookService } from './webhook.service';
import { SpanRecorder, runWithTrace, extractTraceContext } from '@/lib/tracing';
import fs from 'fs/promises';
import path from 'path';

describe('Webhook Delivery Distributed Tracing & Redaction', () => {
  const tmpDir = path.join(process.cwd(), 'scratch', 'test_webhooks_' + Date.now());
  const subsPath = path.join(tmpDir, 'subs.json');
  const dlqPath = path.join(tmpDir, 'dlq.json');
  const dedupePath = path.join(tmpDir, 'dedupe.json');

  let service: WebhookService;

  beforeEach(async () => {
    SpanRecorder.getInstance().clear();
    await fs.mkdir(tmpDir, { recursive: true });

    service = new WebhookService({
      subscriptionsPath: subsPath,
      deadLetterPath: dlqPath,
      deduplicationPath: dedupePath,
      maxRetries: 2,
      baseDelay: 10,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('propagates W3C traceparent and request correlation headers during webhook delivery', async () => {
    await service.createSubscription('https://partner.example.com/webhook', ['stream.created'], 'test_secret_key');

    let interceptedHeaders: Headers | Record<string, string> | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      interceptedHeaders = init?.headers as Headers | Record<string, string>;
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    });

    const rootTrace = extractTraceContext({
      'x-request-id': 'req_root_9999',
    });

    await runWithTrace(rootTrace, async () => {
      await service.dispatchEvent('stream.created', {
        streamId: 'stream_123',
        amount: '1000',
      });
      await service.awaitPendingDeliveries();
    });

    expect(interceptedHeaders).toBeDefined();
    const headers = interceptedHeaders as Record<string, string>;
    expect(headers['x-request-id']).toBe('req_root_9999');
    expect(headers['x-correlation-id']).toBe('req_root_9999');
    expect(headers['traceparent']).toMatch(new RegExp(`^00-${rootTrace.traceId}-[0-9a-f]{16}-01$`));

    const spans = SpanRecorder.getInstance().getSpans();
    const webhookSpan = spans.find((s) => s.name === 'webhook.deliver');
    expect(webhookSpan).toBeDefined();
    expect(webhookSpan?.status).toBe('ok');
    expect(webhookSpan?.traceId).toBe(rootTrace.traceId);
  });

  it('redacts wallet secret keys and PII in failed webhook attempts and DLQ logs', async () => {
    await service.createSubscription('https://failing.example.com/webhook', ['campaign.created'], 'test_secret_key');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('Internal Server Error', { status: 500 });
    });

    const secretKey = 'S' + 'C'.repeat(55);
    const eventPayload = {
      campaignId: 'camp_sec_01',
      adminEmail: 'sec-admin@fundable.org',
      walletSecret: secretKey,
    };

    await service.dispatchEvent('campaign.created', eventPayload);
    await service.awaitPendingDeliveries();

    const deadLetters = await service.getDeadLetters();
    expect(deadLetters.length).toBeGreaterThan(0);

    const record = deadLetters[0];
    const dlqPayload = record.payload as Record<string, unknown>;

    // Wallet secret key and personal identifier must be redacted in stored DLQ
    expect(dlqPayload.walletSecret).toBe('[REDACTED_SECRET]');
    expect(dlqPayload.adminEmail).toBe('[REDACTED_EMAIL]');
    expect(dlqPayload.campaignId).toBe('camp_sec_01');

    const spans = SpanRecorder.getInstance().getSpans();
    const failedSpan = spans.find((s) => s.name === 'webhook.deliver');
    expect(failedSpan).toBeDefined();
    expect(failedSpan?.status).toBe('error');
    expect(failedSpan?.attributes['http.status_code']).toBe(500);
  });
});
