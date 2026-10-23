import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * API contract tests.
 *
 * These tests load the OpenAPI document that ships with the web app and assert
 * that representative route handlers conform to the documented surface:
 *   - documented path/method exists
 *   - documented success and error status codes are produced
 *   - response bodies conform to documented schemas
 *   - auth requirements are enforced
 *   - pagination parameters behave as documented
 *
 * Handlers are invoked with mocked services so the suite is deterministic and
 * independent of live funds or a running database.
 */

// ---------------------------------------------------------------------------
// OpenAPI loading
// ---------------------------------------------------------------------------

type JsonSchema = {
  type?: string;
  format?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  nullable?: boolean;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
};

type OperationObject = {
  operationId?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: JsonSchema }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: JsonSchema }>;
    }
  >;
  security?: Array<Record<string, string[]>>;
};

type PathItemObject = {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: JsonSchema }>;
};

type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, unknown>;
  };
};

const SPEC_PATH = resolve(__dirname, '../../../openapi/openapi.json');

function loadSpec(): OpenApiDocument {
  const raw = readFileSync(SPEC_PATH, 'utf8');
  return JSON.parse(raw) as OpenApiDocument;
}

const spec = loadSpec();

function getOperation(path: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete'): OperationObject {
  const item = spec.paths[path];
  if (!item) {
    throw new Error(`Documented path not found in OpenAPI spec: ${path}`);
  }
  const op = item[method];
  if (!op) {
    throw new Error(`Documented method not found in OpenAPI spec: ${method.toUpperCase()} ${path}`);
  }
  return op;
}

function resolveRef(schema: JsonSchema): JsonSchema {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/components\/schemas\//, '');
    const resolved = spec.components?.schemas?.[name];
    if (!resolved) {
      throw new Error(`Unresolvable $ref in OpenAPI spec: ${schema.$ref}`);
    }
    return resolved;
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Minimal JSON-schema validator (subset sufficient for the documented surface)
// ---------------------------------------------------------------------------

function validate(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  const resolved = resolveRef(schema);

  if (value === null || value === undefined) {
    if (resolved.nullable) return errors;
    if (resolved.type && resolved.type !== 'null') {
      errors.push(`${path}: expected ${resolved.type}, got ${value === null ? 'null' : 'undefined'}`);
    }
    return errors;
  }

  if (resolved.oneOf) {
    const matches = resolved.oneOf.filter((s) => validate(value, s, path).length === 0);
    if (matches.length !== 1) {
      errors.push(`${path}: value does not match exactly one oneOf branch`);
    }
    return errors;
  }

  if (resolved.anyOf) {
    const matches = resolved.anyOf.filter((s) => validate(value, s, path).length === 0);
    if (matches.length === 0) {
      errors.push(`${path}: value does not match any anyOf branch`);
    }
    return errors;
  }

  if (resolved.allOf) {
    for (const sub of resolved.allOf) {
      errors.push(...validate(value, sub, path));
    }
  }

  if (resolved.enum) {
    if (!resolved.enum.includes(value)) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(resolved.enum)}`);
    }
  }

  switch (resolved.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        break;
      }
      const obj = value as Record<string, unknown>;
      for (const req of resolved.required ?? []) {
        if (!(req in obj)) {
          errors.push(`${path}: missing required property "${req}"`);
        }
      }
      for (const [key, propSchema] of Object.entries(resolved.properties ?? {})) {
        if (key in obj) {
          errors.push(...validate(obj[key], propSchema, `${path}.${key}`));
        }
      }
      if (resolved.additionalProperties === false) {
        const allowed = new Set(Object.keys(resolved.properties ?? {}));
        for (const key of Object.keys(obj)) {
          if (!allowed.has(key)) {
            errors.push(`${path}: unexpected property "${key}"`);
          }
        }
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        break;
      }
      if (resolved.items) {
        value.forEach((item, i) => {
          errors.push(...validate(item, resolved.items as JsonSchema, `${path}[${i}]`));
        });
      }
      break;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string`);
        break;
      }
      if (resolved.minLength !== undefined && value.length < resolved.minLength) {
        errors.push(`${path}: string shorter than minLength ${resolved.minLength}`);
      }
      if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
        errors.push(`${path}: string longer than maxLength ${resolved.maxLength}`);
      }
      if (resolved.pattern && !new RegExp(resolved.pattern).test(value)) {
        errors.push(`${path}: string does not match pattern ${resolved.pattern}`);
      }
      break;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path}: expected integer`);
        break;
      }
      if (resolved.minimum !== undefined && value < resolved.minimum) {
        errors.push(`${path}: number below minimum ${resolved.minimum}`);
      }
      if (resolved.maximum !== undefined && value > resolved.maximum) {
        errors.push(`${path}: number above maximum ${resolved.maximum}`);
      }
      break;
    }
    case 'number': {
      if (typeof value !== 'number') {
        errors.push(`${path}: expected number`);
        break;
      }
      if (resolved.minimum !== undefined && value < resolved.minimum) {
        errors.push(`${path}: number below minimum ${resolved.minimum}`);
      }
      if (resolved.maximum !== undefined && value > resolved.maximum) {
        errors.push(`${path}: number above maximum ${resolved.maximum}`);
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push(`${path}: expected boolean`);
      }
      break;
    }
    default:
      break;
  }

  return errors;
}

function assertConforms(value: unknown, schema: JsonSchema | undefined, label: string): void {
  if (!schema) {
    throw new Error(`No documented schema for ${label}`);
  }
  const errors = validate(value, schema);
  if (errors.length > 0) {
    throw new Error(`Response for ${label} does not conform to documented schema:\n${errors.join('\n')}`);
  }
}

function documentedResponseSchema(op: OperationObject, status: number): JsonSchema | undefined {
  const entry = op.responses[String(status)];
  if (!entry) return undefined;
  return entry.content?.['application/json']?.schema;
}

function documentedRequestBodySchema(op: OperationObject): JsonSchema | undefined {
  return op.requestBody?.content?.['application/json']?.schema;
}

// ---------------------------------------------------------------------------
// Mocked services
// ---------------------------------------------------------------------------

type Campaign = {
  id: string;
  title: string;
  description: string;
  goalAmount: number;
  raisedAmount: number;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
};

type Contribution = {
  id: string;
  campaignId: string;
  amount: number;
  donorId: string;
  createdAt: string;
};

type Donation = {
  id: string;
  campaignId: string;
  amount: number;
  status: 'pending' | 'confirmed' | 'failed';
  createdAt: string;
};

const nowIso = '2024-01-01T00:00:00.000Z';

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp_1',
    title: 'Test Campaign',
    description: 'A campaign used for contract tests',
    goalAmount: 1000,
    raisedAmount: 0,
    status: 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

const campaignStore = new Map<string, Campaign>();
const contributionStore: Contribution[] = [];
const donationStore: Donation[] = [];

const mockCampaignService = {
  list: vi.fn(async ({ page, pageSize }: { page: number; pageSize: number }) => {
    const all = Array.from(campaignStore.values());
    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);
    return { items, page, pageSize, total: all.length };
  }),
  create: vi.fn(async (input: { title: string; description: string; goalAmount: number }) => {
    const campaign = makeCampaign({
      id: `camp_${campaignStore.size + 1}`,
      title: input.title,
      description: input.description,
      goalAmount: input.goalAmount,
    });
    campaignStore.set(campaign.id, campaign);
    return campaign;
  }),
  get: vi.fn(async (id: string) => campaignStore.get(id) ?? null),
  update: vi.fn(async (id: string, patch: Partial<Campaign>) => {
    const existing = campaignStore.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: nowIso };
    campaignStore.set(id, updated);
    return updated;
  }),
};

const mockVerificationService = {
  verify: vi.fn(async (campaignId: string) => {
    const campaign = campaignStore.get(campaignId);
    if (!campaign) return null;
    return { campaignId, verified: true, verifiedAt: nowIso };
  }),
};

const mockContributionService = {
  list: vi.fn(async (campaignId: string, { page, pageSize }: { page: number; pageSize: number }) => {
    const all = contributionStore.filter((c) => c.campaignId === campaignId);
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), page, pageSize, total: all.length };
  }),
};

const mockDonationService = {
  list: vi.fn(async (campaignId: string, { page, pageSize }: { page: number; pageSize: number }) => {
    const all = donationStore.filter((d) => d.campaignId === campaignId);
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), page, pageSize, total: all.length };
  }),
};

const mockProgressService = {
  get: vi.fn(async (campaignId: string) => {
    const campaign = campaignStore.get(campaignId);
    if (!campaign) return null;
    const raised = contributionStore
      .filter((c) => c.campaignId === campaignId)
      .reduce((sum, c) => sum + c.amount, 0);
    return {
      campaignId,
      goalAmount: campaign.goalAmount,
      raisedAmount: raised,
      percentComplete: campaign.goalAmount === 0 ? 0 : Math.min(100, (raised / campaign.goalAmount) * 100),
    };
  }),
};

const mockHealthService = {
  check: vi.fn(async () => ({ status: 'ok' as const, uptime: 1234 })),
};

// ---------------------------------------------------------------------------
// Route handlers (representative, thin wrappers over mocked services)
// ---------------------------------------------------------------------------

type HandlerRequest = {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
};

type HandlerResponse = {
  status: number;
  body: unknown;
};

const ADMIN_TOKEN = 'admin-secret';

function isAdmin(req: HandlerRequest): boolean {
  return req.headers?.authorization === `Bearer ${ADMIN_TOKEN}`;
}

function parsePagination(query: Record<string, string | undefined> = {}): { page: number; pageSize: number } {
  const page = query.page !== undefined ? Number(query.page) : 1;
  const pageSize = query.pageSize !== undefined ? Number(query.pageSize) : 20;
  return { page, pageSize };
}

function validatePagination({ page, pageSize }: { page: number; pageSize: number }): string | null {
  if (!Number.isInteger(page) || page < 1) return 'page must be an integer >= 1';
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return 'pageSize must be an integer between 1 and 100';
  }
  return null;
}

async function handleCampaignsList(req: HandlerRequest): Promise<HandlerResponse> {
  const pagination = parsePagination(req.query);
  const error = validatePagination(pagination);
  if (error) {
    return { status: 400, body: { error: 'invalid_pagination', message: error } };
  }
  const result = await mockCampaignService.list(pagination);
  return { status: 200, body: result };
}

async function handleCampaignsCreate(req: HandlerRequest): Promise<HandlerResponse> {
  if (!isAdmin(req)) {
    return { status: 401, body: { error: 'unauthorized', message: 'Admin authentication required' } };
  }
  const body = req.body as { title?: unknown; description?: unknown; goalAmount?: unknown } | undefined;
  if (
    !body ||
    typeof body.title !== 'string' ||
    body.title.length === 0 ||
    typeof body.description !== 'string' ||
    typeof body.goalAmount !== 'number' ||
    body.goalAmount <= 0
  ) {
    return { status: 400, body: { error: 'invalid_body', message: 'Invalid campaign payload' } };
  }
  const campaign = await mockCampaignService.create({
    title: body.title,
    description: body.description,
    goalAmount: body.goalAmount,
  });
  return { status: 201, body: campaign };
}

async function handleCampaignGet(req: HandlerRequest, id: string): Promise<HandlerResponse> {
  const campaign = await mockCampaignService.get(id);
  if (!campaign) {
    return { status: 404, body: { error: 'not_found', message: 'Campaign not found' } };
  }
  return { status: 200, body: campaign };
}

async function handleCampaignPatch(req: HandlerRequest, id: string): Promise<HandlerResponse> {
  if (!isAdmin(req)) {
    return { status: 401, body: { error: 'unauthorized', message: 'Admin authentication required' } };
  }
  const body = req.body as Partial<Campaign> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'invalid_body', message: 'Invalid campaign patch' } };
  }
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length === 0)) {
    return { status: 400, body: { error: 'invalid_body', message: 'Invalid title' } };
  }
  const updated = await mockCampaignService.update(id, body);
  if (!updated) {
    return { status: 404, body: { error: 'not_found', message: 'Campaign not found' } };
  }
  return { status: 200, body: updated };
}

async function handleVerification(req: HandlerRequest, id: string): Promise<HandlerResponse> {
  if (!isAdmin(req)) {
    return { status: 401, body: { error: 'unauthorized', message: 'Admin authentication required' } };
  }
  const result = await mockVerificationService.verify(id);
  if (!result) {
    return { status: 404, body: { error: 'not_found', message: 'Campaign not found' } };
  }
  return { status: 200, body: result };
}

async function handleContributionsList(req: HandlerRequest, id: string): Promise<HandlerResponse> {
  const pagination = parsePagination(req.query);
  const error = validatePagination(pagination);
  if (error) {
    return { status: 400, body: { error: 'invalid_pagination', message: error } };
  }
  const campaign = await mockCampaignService.get(id);
  if (!campaign) {
    return { status: 404, body: { error: 'not_found', message: 'Campaign not found' } };
  }
  const result = await mockContributionService.list(id, pagination);
  return { status: 200, body: result };
}

async function handleDonationsList(req: HandlerRequest, id: string): Promise<HandlerResponse> {
  const pagination = parsePagination(req.query);
  const error = validatePagination(pagination);
  if (error) {
    return { status: 400, body: { error: 'invalid_pagination', message: error } };
  }
  const campaign = await mockCampaignService.get(id);
  if (!campaign) {
    return { status: 404, body: { error: 'not_found', message: 'Campaign not found' } };
  }
  const result = await mockDonationService.list(id, pagination);
  return { status: 200, body: result };
}

async function handleProgress(req: HandlerRequest, id: string): Promise<HandlerResponse> {
  const result = await mockProgressService.get(id);
  if (!result) {
    return { status: 404, body: { error: 'not_found', message: 'Campaign not found' } };
  }
  return { status: 200, body: result };
}

async function handleHealthz(): Promise<HandlerResponse> {
  const result = await mockHealthService.check();
  return { status: 200, body: result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAPI contract', () => {
  beforeEach(() => {
    campaignStore.clear();
    contributionStore.length = 0;
    donationStore.length = 0;
    vi.clearAllMocks();
  });

  describe('spec integrity', () => {
    it('loads a valid OpenAPI 3 document', () => {
      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.info.title).toBeTruthy();
      expect(spec.paths).toBeTypeOf('object');
    });

    it('documents all representative paths and methods', () => {
      const expected: Array<[string, 'get' | 'post' | 'patch']> = [
        ['/campaigns', 'get'],
        ['/campaigns', 'post'],
        ['/campaigns/{id}', 'get'],
        ['/campaigns/{id}', 'patch'],
        ['/campaigns/{id}/verification', 'post'],
        ['/campaigns/{id}/contributions', 'get'],
        ['/campaigns/{id}/donations', 'get'],
        ['/campaigns/{id}/progress', 'get'],
        ['/healthz', 'get'],
      ];
      for (const [path, method] of expected) {
        expect(() => getOperation(path, method)).not.toThrow();
      }
    });
  });

  describe('GET /campaigns', () => {
    const op = getOperation('/campaigns', 'get');

    it('documents pagination parameters', () => {
      const names = (op.parameters ?? []).map((p) => p.name);
      expect(names).toContain('page');
      expect(names).toContain('pageSize');
    });

    it('returns 200 with a documented list schema', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleCampaignsList({ method: 'GET', path: '/campaigns' });
      expect(res.status).toBe(200);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'GET /campaigns 200');
    });

    it('honors documented pagination parameters', async () => {
      for (let i = 0; i < 5; i++) {
        campaignStore.set(`camp_${i}`, makeCampaign({ id: `camp_${i}` }));
      }
      const res = await handleCampaignsList({
        method: 'GET',
        path: '/campaigns',
        query: { page: '2', pageSize: '2' },
      });
      expect(res.status).toBe(200);
      const body = res.body as { items: Campaign[]; page: number; pageSize: number; total: number };
      expect(body.page).toBe(2);
      expect(body.pageSize).toBe(2);
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(5);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'GET /campaigns 200 (paged)');
    });

    it('returns documented 400 for invalid pagination', async () => {
      const res = await handleCampaignsList({
        method: 'GET',
        path: '/campaigns',
        query: { page: '0' },
      });
      expect(res.status).toBe(400);
      assertConforms(res.body, documentedResponseSchema(op, 400), 'GET /campaigns 400');
    });

    it('returns documented 400 for out-of-range pageSize', async () => {
      const res = await handleCampaignsList({
        method: 'GET',
        path: '/campaigns',
        query: { pageSize: '1000' },
      });
      expect(res.status).toBe(400);
      assertConforms(res.body, documentedResponseSchema(op, 400), 'GET /campaigns 400 (pageSize)');
    });
  });

  describe('POST /campaigns', () => {
    const op = getOperation('/campaigns', 'post');

    it('documents a request body and admin security', () => {
      expect(documentedRequestBodySchema(op)).toBeDefined();
      expect(op.security && op.security.length > 0).toBe(true);
    });

    it('returns documented 201 for a valid body', async () => {
      const body = { title: 'New Campaign', description: 'desc', goalAmount: 500 };
      assertConforms(body, documentedRequestBodySchema(op), 'POST /campaigns request');
      const res = await handleCampaignsCreate({
        method: 'POST',
        path: '/campaigns',
        body,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(201);
      assertConforms(res.body, documentedResponseSchema(op, 201), 'POST /campaigns 201');
    });

    it('returns documented 401 when unauthenticated', async () => {
      const res = await handleCampaignsCreate({
        method: 'POST',
        path: '/campaigns',
        body: { title: 'x', description: 'y', goalAmount: 1 },
      });
      expect(res.status).toBe(401);
      assertConforms(res.body, documentedResponseSchema(op, 401), 'POST /campaigns 401');
    });

    it('returns documented 400 for an invalid body', async () => {
      const res = await handleCampaignsCreate({
        method: 'POST',
        path: '/campaigns',
        body: { title: '', description: 'y', goalAmount: -1 },
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(400);
      assertConforms(res.body, documentedResponseSchema(op, 400), 'POST /campaigns 400');
    });
  });

  describe('GET /campaigns/{id}', () => {
    const op = getOperation('/campaigns/{id}', 'get');

    it('returns documented 200 for an existing campaign', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleCampaignGet({ method: 'GET', path: '/campaigns/camp_1' }, 'camp_1');
      expect(res.status).toBe(200);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'GET /campaigns/{id} 200');
    });

    it('returns documented 404 for a missing campaign', async () => {
      const res = await handleCampaignGet({ method: 'GET', path: '/campaigns/missing' }, 'missing');
      expect(res.status).toBe(404);
      assertConforms(res.body, documentedResponseSchema(op, 404), 'GET /campaigns/{id} 404');
    });
  });

  describe('PATCH /campaigns/{id}', () => {
    const op = getOperation('/campaigns/{id}', 'patch');

    it('returns documented 200 for a valid patch', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleCampaignPatch(
        {
          method: 'PATCH',
          path: '/campaigns/camp_1',
          body: { title: 'Updated' },
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
        'camp_1',
      );
      expect(res.status).toBe(200);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'PATCH /campaigns/{id} 200');
    });

    it('returns documented 401 when unauthenticated', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleCampaignPatch(
        { method: 'PATCH', path: '/campaigns/camp_1', body: { title: 'Updated' } },
        'camp_1',
      );
      expect(res.status).toBe(401);
      assertConforms(res.body, documentedResponseSchema(op, 401), 'PATCH /campaigns/{id} 401');
    });

    it('returns documented 400 for an invalid patch body', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleCampaignPatch(
        {
          method: 'PATCH',
          path: '/campaigns/camp_1',
          body: { title: '' },
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
        'camp_1',
      );
      expect(res.status).toBe(400);
      assertConforms(res.body, documentedResponseSchema(op, 400), 'PATCH /campaigns/{id} 400');
    });

    it('returns documented 404 for a missing campaign', async () => {
      const res = await handleCampaignPatch(
        {
          method: 'PATCH',
          path: '/campaigns/missing',
          body: { title: 'Updated' },
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
        'missing',
      );
      expect(res.status).toBe(404);
      assertConforms(res.body, documentedResponseSchema(op, 404), 'PATCH /campaigns/{id} 404');
    });
  });

  describe('POST /campaigns/{id}/verification', () => {
    const op = getOperation('/campaigns/{id}/verification', 'post');

    it('returns documented 200 for an existing campaign', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleVerification(
        {
          method: 'POST',
          path: '/campaigns/camp_1/verification',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
        'camp_1',
      );
      expect(res.status).toBe(200);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'POST /campaigns/{id}/verification 200');
    });

    it('returns documented 401 when unauthenticated', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleVerification(
        { method: 'POST', path: '/campaigns/camp_1/verification' },
        'camp_1',
      );
      expect(res.status).toBe(401);
      assertConforms(res.body, documentedResponseSchema(op, 401), 'POST /campaigns/{id}/verification 401');
    });

    it('returns documented 404 for a missing campaign', async () => {
      const res = await handleVerification(
        {
          method: 'POST',
          path: '/campaigns/missing/verification',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
        'missing',
      );
      expect(res.status).toBe(404);
      assertConforms(res.body, documentedResponseSchema(op, 404), 'POST /campaigns/{id}/verification 404');
    });
  });

  describe('GET /campaigns/{id}/contributions', () => {
    const op = getOperation('/campaigns/{id}/contributions', 'get');

    it('documents pagination parameters', () => {
      const names = (op.parameters ?? []).map((p) => p.name);
      expect(names).toContain('page');
      expect(names).toContain('pageSize');
    });

    it('returns documented 200 with paginated contributions', async () => {
      campaignStore.set('camp_1', makeCampaign());
      for (let i = 0; i < 3; i++) {
        contributionStore.push({
          id: `contrib_${i}`,
          campaignId: 'camp_1',
          amount: 10,
          donorId: `donor_${i}`,
          createdAt: nowIso,
        });
      }
      const res = await handleContributionsList(
        { method: 'GET', path: '/campaigns/camp_1/contributions', query: { page: '1', pageSize: '2' } },
        'camp_1',
      );
      expect(res.status).toBe(200);
      const body = res.body as { items: Contribution[]; total: number };
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(3);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'GET /campaigns/{id}/contributions 200');
    });

    it('returns documented 400 for invalid pagination', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleContributionsList(
        { method: 'GET', path: '/campaigns/camp_1/contributions', query: { pageSize: '0' } },
        'camp_1',
      );
      expect(res.status).toBe(400);
      assertConforms(res.body, documentedResponseSchema(op, 400), 'GET /campaigns/{id}/contributions 400');
    });

    it('returns documented 404 for a missing campaign', async () => {
      const res = await handleContributionsList(
        { method: 'GET', path: '/campaigns/missing/contributions' },
        'missing',
      );
      expect(res.status).toBe(404);
      assertConforms(res.body, documentedResponseSchema(op, 404), 'GET /campaigns/{id}/contributions 404');
    });
  });

  describe('GET /campaigns/{id}/donations', () => {
    const op = getOperation('/campaigns/{id}/donations', 'get');

    it('returns documented 200 with paginated donations', async () => {
      campaignStore.set('camp_1', makeCampaign());
      for (let i = 0; i < 2; i++) {
        donationStore.push({
          id: `donation_${i}`,
          campaignId: 'camp_1',
          amount: 25,
          status: 'confirmed',
          createdAt: nowIso,
        });
      }
      const res = await handleDonationsList(
        { method: 'GET', path: '/campaigns/camp_1/donations', query: { page: '1', pageSize: '10' } },
        'camp_1',
      );
      expect(res.status).toBe(200);
      const body = res.body as { items: Donation[]; total: number };
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(2);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'GET /campaigns/{id}/donations 200');
    });

    it('returns documented 400 for invalid pagination', async () => {
      campaignStore.set('camp_1', makeCampaign());
      const res = await handleDonationsList(
        { method: 'GET', path: '/campaigns/camp_1/donations', query: { page: '-1' } },
        'camp_1',
      );
      expect(res.status).toBe(400);
      assertConforms(res.body, documentedResponseSchema(op, 400), 'GET /campaigns/{id}/donations 400');
    });

    it('returns documented 404 for a missing campaign', async () => {
      const res = await handleDonationsList(
        { method: 'GET', path: '/campaigns/missing/donations' },
        'missing',
      );
      expect(res.status).toBe(404);
      assertConforms(res.body, documentedResponseSchema(op, 404), 'GET /campaigns/{id}/donations 404');
    });
  });

  describe('GET /campaigns/{id}/progress', () => {
    const op = getOperation('/campaigns/{id}/progress', 'get');

    it('returns documented 200 for an existing campaign', async () => {
      campaignStore.set('camp_1', makeCampaign({ goalAmount: 1000 }));
      contributionStore.push({
        id: 'contrib_1',
        campaignId: 'camp_1',
        amount: 250,
        donorId: 'donor_1',
        createdAt: nowIso,
      });
      const res = await handleProgress({ method: 'GET', path: '/campaigns/camp_1/progress' }, 'camp_1');
      expect(res.status).toBe(200);
      const body = res.body as { raisedAmount: number; percentComplete: number };
      expect(body.raisedAmount).toBe(250);
      expect(body.percentComplete).toBeCloseTo(25);
      assertConforms(res.body, documentedResponseSchema(op, 200), 'GET /campaigns/{id}/progress 200');
    });

    it('returns documented 404 for a missing campaign', async () => {
      const res = await handleProgress({ method: 'GET', path: '/campaigns/missing/progress' }, 'missing');
      expect(res.status).toBe(404);
      assertConforms(res.body, documentedResponseSchema(op, 404), 'GET /campaigns/{id}/progress 404');
    });
  });

  describe('GET /healthz', () => {
    const op = getOperation('/healthz', 'get');

    it('returns documented 200 with a health schema', async () => {
      const res