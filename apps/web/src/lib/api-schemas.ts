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
/* Sponsor portfolio (issue #238)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reconciliation status of a portfolio line item, comparing committed,
 * matched, and settled value against authoritative records.
 *
 * - `reconciled`: committed, matched, and settled values agree.
 * - `pending`: authoritative records not yet available; retry later.
 * - `mismatch`: values disagree with authoritative records; needs review.
 * - `unavailable`: authoritative source could not be reached.
 */
export const reconciliationStatusSchema = z.enum([
  'reconciled',
  'pending',
  'mismatch',
  'unavailable',
]);

export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>;

/** Source reference pointing at an authoritative record. */
export const sourceReferenceSchema = z
  .object({
    source: nonEmptyString.max(100),
    reference: nonEmptyString.max(200),
    url: urlSchema.optional(),
  })
  .strict();

export type SourceReference = z.infer<typeof sourceReferenceSchema>;

/**
 * Query params for `GET /api/sponsors/:sponsorId/portfolio`.
 *
 * `campaignIds` filters to specific supported campaigns; `status` filters by
 * reconciliation status. Both are optional and additive.
 */
export const sponsorPortfolioQuerySchema = z
  .object({
    cursor: nonEmptyString.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_LIMIT)
      .default(DEFAULT_PAGE_LIMIT),
    campaignIds: z
      .union([
        z.array(campaignIdSchema),
        z
          .string()
          .trim()
          .min(1)
          .transform((value) =>
            value
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part.length > 0),
          )
          .pipe(z.array(campaignIdSchema).min(1)),
      ])
      .optional(),
    status: reconciliationStatusSchema.optional(),
  })
  .strict();

export type SponsorPortfolioQueryInput = z.infer<
  typeof sponsorPortfolioQuerySchema
>;

/* -------------------------------------------------------------------------- */
/* Transaction confirmation timeline (issue #239)                             */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle states of a transaction, ordered from wallet approval through
 * settlement. Clients render these as a timeline and use them to recover
 * after a reload.
 *
 * - `awaiting_approval`: wallet approval requested, not yet granted.
 * - `approved`: wallet approved; not yet submitted.
 * - `submitted`: submitted to the network; awaiting ledger confirmation.
 * - `confirmed`: included in a ledger.
 * - `settled`: final settlement recorded.
 * - `failed`: terminal failure (approval rejected, submission error, etc.).
 */
export const transactionLifecycleStateSchema = z.enum([
  'awaiting_approval',
  'approved',
  'submitted',
  'confirmed',
  'settled',
  'failed',
]);

export type TransactionLifecycleState = z.infer<
  typeof transactionLifecycleStateSchema
>;

/** A single timeline entry for a transaction lifecycle transition. */
export const transactionTimelineEventSchema = z
  .object({
    state: transactionLifecycleStateSchema,
    at: isoDateTimeSchema,
    ledger: z.coerce.number().int().nonnegative().optional(),
    txHash: nonEmptyString.max(200).optional(),
    error: nonEmptyString.max(500).optional(),
  })
  .strict();

export type TransactionTimelineEvent = z.infer<
  typeof transactionTimelineEventSchema
>;

/** Path params for transaction timeline endpoints. */
export const transactionIdParamsSchema = z
  .object({
    transactionId: nonEmptyString.max(200),
  })
  .strict();

export type TransactionIdParams = z.infer<typeof transactionIdParamsSchema>;

/**
 * Query params for `GET /api/transactions/:transactionId/timeline`.
 *
 * `includeEvents` defaults to true; set to `false` to fetch only the current
 * state (useful for lightweight polling after a reload).
 */
export const transactionTimelineQuerySchema = z
  .object({
    includeEvents: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default('true'),
  })
  .strict();

export type TransactionTimelineQueryInput = z.infer<
  typeof transactionTimelineQuerySchema
>;

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