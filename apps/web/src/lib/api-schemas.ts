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
/* Campaign discovery batch (issue #231)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hard cap on the number of campaigns a single discovery batch may request.
 * Services and routes share this limit so batch cost stays bounded.
 */
export const MAX_DISCOVERY_BATCH_SIZE = 100;

export const DEFAULT_DISCOVERY_BATCH_SIZE = 20;

export const campaignDiscoveryBatchQuerySchema = z
  .object({
    // Explicit campaign ids to fetch. Bounded to avoid unbounded IN clauses.
    ids: z
      .union([
        z.array(idSchema),
        z
          .string()
          .trim()
          .min(1)
          .transform((value) =>
            value
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part.length > 0),
          ),
      ])
      .pipe(z.array(idSchema).min(1).max(MAX_DISCOVERY_BATCH_SIZE))
      .optional(),
    cursor: nonEmptyString.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_DISCOVERY_BATCH_SIZE)
      .default(DEFAULT_DISCOVERY_BATCH_SIZE),
  })
  .strict();

export type CampaignDiscoveryBatchInput = z.infer<
  typeof campaignDiscoveryBatchQuerySchema
>;

/* -------------------------------------------------------------------------- */
/* Campaign export jobs (issue #228)                                          */
/* -------------------------------------------------------------------------- */

export const exportFormatSchema = z.enum(['csv', 'json']);

export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const exportJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'expired',
]);

export type ExportJobStatus = z.infer<typeof exportJobStatusSchema>;

export const exportJobIdSchema = idSchema;

export const createExportJobBodySchema = z
  .object({
    campaignId: campaignIdSchema,
    format: exportFormatSchema.default('csv'),
  })
  .strict();

export type CreateExportJobInput = z.infer<typeof createExportJobBodySchema>;

export const exportJobIdParamsSchema = z
  .object({
    jobId: exportJobIdSchema,
  })
  .strict();

export const exportJobStatusQuerySchema = z
  .object({
    // Optional long-poll hint (seconds) for clients waiting on completion.
    waitSeconds: z.coerce.number().int().min(0).max(30).optional(),
  })
  .strict();

export type ExportJobStatusQuery = z.infer<typeof exportJobStatusQuerySchema>;

export const exportArtifactParamsSchema = z
  .object({
    jobId: exportJobIdSchema,
    // Opaque, unguessable artifact token bound to the job.
    artifactToken: nonEmptyString.max(256),
  })
  .strict();

export type ExportArtifactParams = z.infer<typeof exportArtifactParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Operator webhook redelivery (issue #230)                                   */
/* -------------------------------------------------------------------------- */

export const redeliverWebhookBodySchema = z
  .object({
    subscriptionId: subscriptionIdSchema,
    eventId: nonEmptyString.max(256),
    reason: nonEmptyString.max(500),
  })
  .strict();

export type RedeliverWebhookInput = z.infer<typeof redeliverWebhookBodySchema>;

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