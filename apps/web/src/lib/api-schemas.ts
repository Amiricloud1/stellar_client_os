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

/** Donation id (positive integer). */
export const donationIdSchema = idSchema;

export const donationIdParamsSchema = z
  .object({
    donationId: donationIdSchema,
  })
  .strict();

/** Reviewer comment id (positive integer). */
export const commentIdSchema = idSchema;

export const commentIdParamsSchema = z
  .object({
    commentId: commentIdSchema,
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
/* Donations (issue #176)                                                     */
/* -------------------------------------------------------------------------- */

/** Lowercase or uppercase 64-character hex digest (sha256). */
export const termsSnapshotHashSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex string');

/**
 * A contribution MUST be bound to the exact terms the donor saw before
 * signing. `termsSnapshotHash` is the content hash of those terms and
 * `termsVersion` identifies the published version they came from.
 */
export const createDonationBodySchema = z
  .object({
    streamId: streamIdSchema,
    amount: z.coerce.number().positive(),
    termsSnapshotHash: termsSnapshotHashSchema,
    termsVersion: nonEmptyString.max(100),
  })
  .strict();

export type CreateDonationInput = z.infer<typeof createDonationBodySchema>;

/* -------------------------------------------------------------------------- */
/* Reviewer comments (issue #178)                                             */
/* -------------------------------------------------------------------------- */

export const commentResolutionStatusSchema = z.enum([
  'open',
  'resolved',
  'dismissed',
]);

export type CommentResolutionStatus = z.infer<
  typeof commentResolutionStatusSchema
>;

export const COMMENT_BODY_MAX_LENGTH = 5_000;

/**
 * A reviewer comment is anchored to a specific evidence version so that
 * attribution and discussion remain reproducible.
 */
export const createReviewerCommentBodySchema = z
  .object({
    evidenceId: nonEmptyString.max(200),
    evidenceVersion: z.coerce.number().int().positive(),
    body: nonEmptyString.max(COMMENT_BODY_MAX_LENGTH),
  })
  .strict();

export type CreateReviewerCommentInput = z.infer<
  typeof createReviewerCommentBodySchema
>;

export const resolveReviewerCommentBodySchema = z
  .object({
    resolutionStatus: commentResolutionStatusSchema,
    resolutionNote: nonEmptyString.max(COMMENT_BODY_MAX_LENGTH).optional(),
  })
  .strict();

export type ResolveReviewerCommentInput = z.infer<
  typeof resolveReviewerCommentBodySchema
>;

/* -------------------------------------------------------------------------- */
/* Pre-launch readiness checklist (issue #179)                                */
/* -------------------------------------------------------------------------- */

export const readinessNetworkSchema = z.enum(['mainnet', 'testnet', 'futurenet']);

export const readinessAssetSchema = z
  .object({
    code: nonEmptyString.max(12),
    issuer: nonEmptyString.max(100).optional(),
  })
  .strict();

export const readinessMilestoneSchema = z
  .object({
    title: nonEmptyString.max(200),
    targetDate: isoDateTimeSchema,
    amount: z.coerce.number().positive(),
  })
  .strict();

export const readinessPayoutTermsSchema = z
  .object({
    currency: nonEmptyString.max(12),
    schedule: nonEmptyString.max(200),
    termsSnapshotHash: termsSnapshotHashSchema,
  })
  .strict();

/**
 * Request body for validating a campaign before deployment. All sections are
 * required so that missing metadata, network, assets, milestones, or payout
 * terms surface as explicit validation errors.
 */
export const readinessChecklistBodySchema = z
  .object({
    metadata: z
      .object({
        title: nonEmptyString.max(200),
        description: nonEmptyString.max(5_000),
      })
      .strict(),
    network: readinessNetworkSchema,
    assets: z.array(readinessAssetSchema).min(1),
    milestones: z.array(readinessMilestoneSchema).min(1),
    payoutTerms: readinessPayoutTermsSchema,
  })
  .strict();

export type ReadinessChecklistInput = z.infer<
  typeof readinessChecklistBodySchema
>;

export const readinessChecklistItemStatusSchema = z.enum([
  'pass',
  'fail',
  'warning',
]);

export const readinessChecklistItemSchema = z
  .object({
    id: nonEmptyString,
    status: readinessChecklistItemStatusSchema,
    message: nonEmptyString,
  })
  .strict();

export const readinessChecklistResponseSchema = z
  .object({
    ready: z.boolean(),
    items: z.array(readinessChecklistItemSchema),
  })
  .strict();

export type ReadinessChecklistResponse = z.infer<
  typeof readinessChecklistResponseSchema
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