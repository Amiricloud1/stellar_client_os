import { z } from 'zod';

/**
 * Shared API input schemas (issue #55).
 *
 * Every API route MUST validate path, query, and body values through these
 * schemas so that unknown keys and invalid values are rejected consistently.
 *
 * Conventions:
 * - All object schemas use `.strict()` to reject unknown keys.
 * - Path/query values arrive as strings, so numeric ids are coerced.
 * - Use `parseRequest` to convert a schema result into a consistent
 *   `{ error, code: 'INVALID_INPUT', details }` 400 payload.
 *
 * Request budgets (issue #233)
 * ----------------------------
 * Oversized bodies, deeply nested lists, and excessive filters are rejected
 * *before* expensive application or database work. Budgets are expressed as
 * Zod schemas so the same limits are shared by API routes and forms:
 *
 * - `requestBudgetSchema` — the effective limits for a request:
 *   - `maxBodyBytes` (default `MAX_BODY_BYTES` = 1 MiB)
 *   - `maxListDepth` (default `MAX_LIST_DEPTH` = 5)
 *   - `maxFilterCount` (default `MAX_FILTER_COUNT` = 20)
 * - `filterBudgetSchema` — enforces a maximum number of filters.
 *
 * Use `parseRequestBudget` (or `assertRequestBudget`) to obtain the explicit
 * failure envelope instead of the generic 400:
 *   `{ error, code: 'REQUEST_TOO_LARGE' | 'REQUEST_BUDGET_EXCEEDED',
 *      reason, details }`
 * `REQUEST_TOO_LARGE` maps to HTTP 413, `REQUEST_BUDGET_EXCEEDED` to 422.
 *
 * Migration note: previously oversized payloads were either accepted or
 * surfaced as generic `INVALID_INPUT` 400s. Callers that need to distinguish
 * budget failures must switch to `parseRequestBudget`; the generic
 * `parseRequest` behavior is unchanged for backward compatibility.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Non-empty, trimmed string. */
export const nonEmptyString = z.string().trim().min(1);

/** Positive integer id, accepting numeric strings from path/query params. */
export const idSchema = z.coerce.number().int().positive();

/** Stream id (positive integer). */
export const streamIdSchema = idSchema;

/** Campaign id (positive integer). */
export const campaignIdSchema = idSchema;

/** Webhook subscription id (positive integer). */
export const subscriptionIdSchema = idSchema;

/** ISO-8601 datetime string. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true });

/** URL string. */
export const urlSchema = z.string().url();

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const paginationSchema = z
  .object({
    cursor: nonEmptyString.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_LIMIT)
      .default(DEFAULT_PAGE_LIMIT),
  })
  .strict();

export type PaginationInput = z.infer<typeof paginationSchema>;

/* -------------------------------------------------------------------------- */
/* Path params                                                                */
/* -------------------------------------------------------------------------- */

export const streamIdParamsSchema = z
  .object({
    streamId: streamIdSchema,
  })
  .strict();

export const campaignIdParamsSchema = z
  .object({
    campaignId: campaignIdSchema,
  })
  .strict();

export const subscriptionIdParamsSchema = z
  .object({
    subscriptionId: subscriptionIdSchema,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Query params                                                               */
/* -------------------------------------------------------------------------- */

export const listStreamsQuerySchema = paginationSchema;

export const listCampaignsQuerySchema = paginationSchema;

export const listSubscriptionsQuerySchema = paginationSchema;

/* -------------------------------------------------------------------------- */
/* Webhook subscriptions                                                      */
/* -------------------------------------------------------------------------- */

export const webhookEventSchema = z.enum([
  'stream.created',
  'stream.updated',
  'stream.ended',
  'campaign.created',
  'campaign.updated',
  'campaign.ended',
]);

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const createWebhookSubscriptionBodySchema = z
  .object({
    url: urlSchema,
    events: z.array(webhookEventSchema).min(1),
    description: nonEmptyString.max(500).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type CreateWebhookSubscriptionInput = z.infer<
  typeof createWebhookSubscriptionBodySchema
>;

export const rotateWebhookSubscriptionBodySchema = z
  .object({
    // Optional grace period (seconds) during which the previous secret
    // remains valid after rotation.
    gracePeriodSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
  })
  .strict();

export type RotateWebhookSubscriptionInput = z.infer<
  typeof rotateWebhookSubscriptionBodySchema
>;

export const revokeWebhookSubscriptionBodySchema = z
  .object({
    reason: nonEmptyString.max(500).optional(),
  })
  .strict();

export type RevokeWebhookSubscriptionInput = z.infer<
  typeof revokeWebhookSubscriptionBodySchema
>;

/* -------------------------------------------------------------------------- */
/* Request budgets (issue #233)                                               */
/* -------------------------------------------------------------------------- */

/** Default maximum request body size in bytes (1 MiB). */
export const MAX_BODY_BYTES = 1_048_576;

/** Default maximum nesting depth for list/array values. */
export const MAX_LIST_DEPTH = 5;

/** Default maximum number of filters accepted on a request. */
export const MAX_FILTER_COUNT = 20;

/** Hard upper bounds for configurable budgets. */
export const ABSOLUTE_MAX_BODY_BYTES = 10_485_760;
export const ABSOLUTE_MAX_LIST_DEPTH = 20;
export const ABSOLUTE_MAX_FILTER_COUNT = 100;

/**
 * Effective request budget. All fields are optional on input and default to
 * the documented limits above.
 */
export const requestBudgetSchema = z
  .object({
    maxBodyBytes: z.coerce
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_MAX_BODY_BYTES)
      .default(MAX_BODY_BYTES),
    maxListDepth: z.coerce
      .number()
      .int()
      .min(1)
      .max(ABSOLUTE_MAX_LIST_DEPTH)
      .default(MAX_LIST_DEPTH),
    maxFilterCount: z.coerce
      .number()
      .int()
      .min(0)
      .max(ABSOLUTE_MAX_FILTER_COUNT)
      .default(MAX_FILTER_COUNT),
  })
  .strict();

export type RequestBudget = z.infer<typeof requestBudgetSchema>;

/** A single filter entry; shape is intentionally open for route-specific use. */
export const filterEntrySchema = z.record(z.string(), z.unknown());

/**
 * Enforces a maximum filter count. Accepts either an array of filters or an
 * object whose `filters` property is the array.
 */
export const filterBudgetSchema = z
  .union([
    z.array(filterEntrySchema),
    z.object({ filters: z.array(filterEntrySchema) }).strict(),
  ])
  .superRefine((value, ctx) => {
    const filters = Array.isArray(value) ? value : value.filters;
    if (filters.length > MAX_FILTER_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'array',
        maximum: MAX_FILTER_COUNT,
        inclusive: true,
        message: `Too many filters: ${filters.length} exceeds maximum of ${MAX_FILTER_COUNT}`,
        path: Array.isArray(value) ? [] : ['filters'],
      });
    }
  });

export type FilterBudgetInput = z.infer<typeof filterBudgetSchema>;

export const REQUEST_TOO_LARGE_CODE = 'REQUEST_TOO_LARGE' as const;
export const REQUEST_BUDGET_EXCEEDED_CODE = 'REQUEST_BUDGET_EXCEEDED' as const;

export type RequestBudgetErrorCode =
  | typeof REQUEST_TOO_LARGE_CODE
  | typeof REQUEST_BUDGET_EXCEEDED_CODE;

export type RequestBudgetReason =
  | 'body_too_large'
  | 'list_too_deep'
  | 'too_many_filters';

export interface RequestBudgetDetail {
  path: string;
  message: string;
  reason: RequestBudgetReason;
}

export interface RequestBudgetErrorResponse {
  error: string;
  code: RequestBudgetErrorCode;
  reason: RequestBudgetReason;
  details: RequestBudgetDetail[];
}

export type ParseRequestBudgetResult =
  | { success: true; budget: RequestBudget }
  | { success: false; status: 413 | 422; body: RequestBudgetErrorResponse };

/** Compute the byte length of a value when serialized as JSON. */
export function measureBodyBytes(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') {
    return new TextEncoder().encode(value).length;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    // Non-serializable values cannot be measured; treat as oversized.
    return Number.POSITIVE_INFINITY;
  }
}

/** Compute the maximum nesting depth of arrays/objects within `value`. */
export function measureListDepth(value: unknown, depth = 0): number {
  if (Array.isArray(value)) {
    let max = depth + 1;
    for (const item of value) {
      max = Math.max(max, measureListDepth(item, depth + 1));
    }
    return max;
  }
  if (value && typeof value === 'object') {
    let max = depth;
    for (const item of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, measureListDepth(item, depth + 1));
    }
    return max;
  }
  return depth;
}

function budgetFailure(
  code: RequestBudgetErrorCode,
  reason: RequestBudgetReason,
  details: RequestBudgetDetail[],
): ParseRequestBudgetResult {
  return {
    success: false,
    status: code === REQUEST_TOO_LARGE_CODE ? 413 : 422,
    body: {
      error:
        code === REQUEST_TOO_LARGE_CODE
          ? 'Request body too large'
          : 'Request budget exceeded',
      code,
      reason,
      details,
    },
  };
}

/**
 * Validate a request against the budget limits.
 *
 * `input` may include `budget` (partial overrides), `body` (the payload to
 * measure), and `filters` (an array or `{ filters }` object). Returns an
 * explicit 413/422 envelope on failure.
 */
export function parseRequestBudget(input: {
  budget?: unknown;
  body?: unknown;
  filters?: unknown;
}): ParseRequestBudgetResult {
  const budgetResult = requestBudgetSchema.safeParse(input.budget ?? {});
  if (!budgetResult.success) {
    return budgetFailure(
      REQUEST_BUDGET_EXCEEDED_CODE,
      'body_too_large',
      budgetResult.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: issue.message,
        reason: 'body_too_large' as const,
      })),
    );
  }

  const budget = budgetResult.data;

  if (input.body !== undefined) {
    const bytes = measureBodyBytes(input.body);
    if (bytes > budget.maxBodyBytes) {
      return budgetFailure(REQUEST_TOO_LARGE_CODE, 'body_too_large', [
        {
          path: '(root)',
          message: `Request body is ${bytes} bytes, exceeding the ${budget.maxBodyBytes} byte limit`,
          reason: 'body_too_large',
        },
      ]);
    }

    const depth = measureListDepth(input.body);
    if (depth > budget.maxListDepth) {
      return budgetFailure(REQUEST_BUDGET_EXCEEDED_CODE, 'list_too_deep', [
        {
          path: '(root)',
          message: `Request nesting depth is ${depth}, exceeding the ${budget.maxListDepth} level limit`,
          reason: 'list_too_deep',
        },
      ]);
    }
  }

  if (input.filters !== undefined) {
    const filters = Array.isArray(input.filters)
      ? input.filters
      : (input.filters as { filters?: unknown }).filters;
    const count = Array.isArray(filters) ? filters.length : 0;
    if (count > budget.maxFilterCount) {
      return budgetFailure(REQUEST_BUDGET_EXCEEDED_CODE, 'too_many_filters', [
        {
          path: 'filters',
          message: `Request has ${count} filters, exceeding the ${budget.maxFilterCount} filter limit`,
          reason: 'too_many_filters',
        },
      ]);
    }
  }

  return { success: true, budget };
}

/**
 * Convenience wrapper that throws a `Response` with the 413/422 JSON payload
 * on failure. Intended for use inside route handlers.
 */
export function assertRequestBudget(input: {
  budget?: unknown;
  body?: unknown;
  filters?: unknown;
}): RequestBudget {
  const result = parseRequestBudget(input);
  if (!result.success) {
    throw new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return result.budget;
}

/* -------------------------------------------------------------------------- */
/* Parse helper                                                               */
/* -------------------------------------------------------------------------- */

export const INVALID_INPUT_CODE = 'INVALID_INPUT' as const;

export interface InvalidInputDetail {
  path: string;
  message: string;
  code: string;
}

export interface InvalidInputResponse {
  error: string;
  code: typeof INVALID_INPUT_CODE;
  details: InvalidInputDetail[];
}

export type ParseRequestResult<T> =
  | { success: true; data: T }
  | { success: false; status: 400; body: InvalidInputResponse };

/**
 * Validate `value` against `schema`.
 *
 * On success returns `{ success: true, data }`.
 * On failure returns a consistent 400 payload:
 * `{ success: false, status: 400, body: { error, code: 'INVALID_INPUT', details } }`.
 */
export function parseRequest<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): ParseRequestResult<z.infer<S>> {
  const result = schema.safeParse(value);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const details: InvalidInputDetail[] = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
    code: issue.code,
  }));

  return {
    success: false,
    status: 400,
    body: {
      error: 'Invalid request input',
      code: INVALID_INPUT_CODE,
      details,
    },
  };
}

/**
 * Convenience wrapper that throws a `Response` with the 400 JSON payload on
 * failure. Intended for use inside route handlers.
 */
export function parseRequestOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): z.infer<S> {
  const result = parseRequest(schema, value);
  if (!result.success) {
    throw new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return result.data;
}