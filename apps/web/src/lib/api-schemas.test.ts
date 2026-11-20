import { describe, expect, it } from 'vitest';
import {
  parseRequest,
  pathIdSchema,
  paginationQuerySchema,
  createItemBodySchema,
  updateItemBodySchema,
  searchQuerySchema,
  exportJobBodySchema,
  exportJobStatusQuerySchema,
  exportArtifactQuerySchema,
  webhookRedeliveryBodySchema,
  batchReadQuerySchema,
  batchReadResponseSchema,
} from './api-schemas';

describe('pathIdSchema', () => {
  it('accepts a valid non-empty id', () => {
    const result = pathIdSchema.safeParse({ id: 'abc123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('abc123');
    }
  });

  it('rejects an empty string id', () => {
    const result = pathIdSchema.safeParse({ id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing id', () => {
    const result = pathIdSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a wrong type id', () => {
    const result = pathIdSchema.safeParse({ id: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects an id exceeding max length', () => {
    const result = pathIdSchema.safeParse({ id: 'a'.repeat(129) });
    expect(result.success).toBe(false);
  });

  it('accepts an id at max length boundary', () => {
    const result = pathIdSchema.safeParse({ id: 'a'.repeat(128) });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = pathIdSchema.safeParse({ id: 'abc', extra: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('paginationQuerySchema', () => {
  it('accepts empty query with defaults', () => {
    const result = paginationQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBeDefined();
      expect(result.data.offset).toBeDefined();
    }
  });

  it('coerces numeric strings', () => {
    const result = paginationQuerySchema.safeParse({ limit: '10', offset: '5' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.offset).toBe(5);
    }
  });

  it('rejects non-numeric strings', () => {
    const result = paginationQuerySchema.safeParse({ limit: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects negative limit', () => {
    const result = paginationQuerySchema.safeParse({ limit: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects limit above max boundary', () => {
    const result = paginationQuerySchema.safeParse({ limit: '1000' });
    expect(result.success).toBe(false);
  });

  it('accepts limit at max boundary', () => {
    const result = paginationQuerySchema.safeParse({ limit: '100' });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = paginationQuerySchema.safeParse({ limit: '10', foo: 'bar' });
    expect(result.success).toBe(false);
  });
});

describe('createItemBodySchema', () => {
  it('accepts a valid body', () => {
    const result = createItemBodySchema.safeParse({ name: 'Widget' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = createItemBodySchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing name', () => {
    const result = createItemBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a wrong type name', () => {
    const result = createItemBodySchema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
  });

  it('rejects a name exceeding max length', () => {
    const result = createItemBodySchema.safeParse({ name: 'a'.repeat(257) });
    expect(result.success).toBe(false);
  });

  it('accepts a name at max length boundary', () => {
    const result = createItemBodySchema.safeParse({ name: 'a'.repeat(256) });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = createItemBodySchema.safeParse({ name: 'Widget', rogue: true });
    expect(result.success).toBe(false);
  });
});

describe('updateItemBodySchema', () => {
  it('accepts a partial update', () => {
    const result = updateItemBodySchema.safeParse({ name: 'Updated' });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (no-op update)', () => {
    const result = updateItemBodySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = updateItemBodySchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a wrong type name', () => {
    const result = updateItemBodySchema.safeParse({ name: false });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = updateItemBodySchema.safeParse({ name: 'Updated', rogue: 1 });
    expect(result.success).toBe(false);
  });
});

describe('searchQuerySchema', () => {
  it('accepts a valid query', () => {
    const result = searchQuerySchema.safeParse({ q: 'hello' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty query string', () => {
    const result = searchQuerySchema.safeParse({ q: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing query', () => {
    const result = searchQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects a wrong type query', () => {
    const result = searchQuerySchema.safeParse({ q: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a query exceeding max length', () => {
    const result = searchQuerySchema.safeParse({ q: 'a'.repeat(257) });
    expect(result.success).toBe(false);
  });

  it('accepts a query at max length boundary', () => {
    const result = searchQuerySchema.safeParse({ q: 'a'.repeat(256) });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = searchQuerySchema.safeParse({ q: 'hello', rogue: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('parseRequest', () => {
  it('returns ok with parsed data on success', () => {
    const result = parseRequest(createItemBodySchema, { name: 'Widget' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ name: 'Widget' });
    }
  });

  it('returns a 400 error shape on failure', () => {
    const result = parseRequest(createItemBodySchema, { name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe('invalid_request');
      expect(typeof result.error.message).toBe('string');
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(Array.isArray(result.error.issues)).toBe(true);
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns a 400 error shape for unknown keys', () => {
    const result = parseRequest(createItemBodySchema, { name: 'Widget', rogue: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error.code).toBe('invalid_request');
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns a 400 error shape for wrong types', () => {
    const result = parseRequest(paginationQuerySchema, { limit: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error.code).toBe('invalid_request');
    }
  });

  it('includes issue paths in the error shape', () => {
    const result = parseRequest(createItemBodySchema, { name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.error.issues[0];
      expect(issue).toBeDefined();
      expect(Array.isArray(issue.path)).toBe(true);
      expect(typeof issue.message).toBe('string');
    }
  });
});

describe('exportJobBodySchema', () => {
  it('accepts a valid export request', () => {
    const result = exportJobBodySchema.safeParse({ campaignId: 'camp_1', format: 'csv' });
    expect(result.success).toBe(true);
  });

  it('defaults format to csv', () => {
    const result = exportJobBodySchema.safeParse({ campaignId: 'camp_1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.format).toBe('csv');
    }
  });

  it('rejects a missing campaignId', () => {
    const result = exportJobBodySchema.safeParse({ format: 'csv' });
    expect(result.success).toBe(false);
  });

  it('rejects an unsupported format', () => {
    const result = exportJobBodySchema.safeParse({ campaignId: 'camp_1', format: 'xml' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = exportJobBodySchema.safeParse({ campaignId: 'camp_1', rogue: true });
    expect(result.success).toBe(false);
  });
});

describe('exportJobStatusQuerySchema', () => {
  it('accepts an empty query', () => {
    const result = exportJobStatusQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('coerces includeArtifact boolean strings', () => {
    const result = exportJobStatusQuerySchema.safeParse({ includeArtifact: 'true' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeArtifact).toBe(true);
    }
  });

  it('rejects unknown keys via .strict()', () => {
    const result = exportJobStatusQuerySchema.safeParse({ rogue: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('exportArtifactQuerySchema', () => {
  it('accepts a valid signed token', () => {
    const result = exportArtifactQuerySchema.safeParse({ token: 'signed-token' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing token (unauthorized artifact access)', () => {
    const result = exportArtifactQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects an empty token', () => {
    const result = exportArtifactQuerySchema.safeParse({ token: '' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = exportArtifactQuerySchema.safeParse({ token: 't', rogue: 1 });
    expect(result.success).toBe(false);
  });
});

describe('webhookRedeliveryBodySchema', () => {
  it('accepts a valid redelivery request', () => {
    const result = webhookRedeliveryBodySchema.safeParse({
      destinationId: 'dest_1',
      eventId: 'evt_1',
      reason: 'operator retry after outage',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing reason (audit trail required)', () => {
    const result = webhookRedeliveryBodySchema.safeParse({
      destinationId: 'dest_1',
      eventId: 'evt_1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty reason', () => {
    const result = webhookRedeliveryBodySchema.safeParse({
      destinationId: 'dest_1',
      eventId: 'evt_1',
      reason: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing destinationId', () => {
    const result = webhookRedeliveryBodySchema.safeParse({ eventId: 'evt_1', reason: 'r' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = webhookRedeliveryBodySchema.safeParse({
      destinationId: 'dest_1',
      eventId: 'evt_1',
      reason: 'r',
      rogue: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('batchReadQuerySchema', () => {
  it('accepts a bounded batch of ids', () => {
    const result = batchReadQuerySchema.safeParse({ ids: 'a,b,c' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ids).toEqual(['a', 'b', 'c']);
    }
  });

  it('rejects an empty ids list', () => {
    const result = batchReadQuerySchema.safeParse({ ids: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an oversized batch', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id${i}`).join(',');
    const result = batchReadQuerySchema.safeParse({ ids });
    expect(result.success).toBe(false);
  });

  it('accepts a batch at the max boundary', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id${i}`).join(',');
    const result = batchReadQuerySchema.safeParse({ ids });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = batchReadQuerySchema.safeParse({ ids: 'a', rogue: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('batchReadResponseSchema', () => {
  it('accepts a success envelope', () => {
    const result = batchReadResponseSchema.safeParse({
      items: [{ id: 'a' }],
      errors: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a partial-error envelope', () => {
    const result = batchReadResponseSchema.safeParse({
      items: [{ id: 'a' }],
      errors: [{ id: 'b', code: 'not_found', message: 'missing' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an error entry missing a code', () => {
    const result = batchReadResponseSchema.safeParse({
      items: [],
      errors: [{ id: 'b', message: 'missing' }],
    });
    expect(result.success).toBe(false);
  });
});