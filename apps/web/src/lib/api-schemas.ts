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
/* Contract deployment registry (issue #218)                                  */
/* -------------------------------------------------------------------------- */

/** Supported networks for contract deployments. */
export const deploymentNetworkSchema = z.enum([
  'mainnet',
  'testnet',
  'futurenet',
  'local',
]);

export type DeploymentNetwork = z.infer<typeof deploymentNetworkSchema>;

/** Lifecycle state of a deployment record. */
export const deploymentStatusSchema = z.enum([
  'pending',
  'active',
  'paused',
  'deprecated',
  'failed',
]);

export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/** Stellar contract address (C... strkey, 56 chars). */
export const contractAddressSchema = z
  .string()
  .trim()
  .regex(/^C[A-Z2-7]{55}$/, 'must be a valid Stellar contract address');

/** Ledger sequence number (non-negative integer). */
export const ledgerSequenceSchema = z.coerce.number().int().min(0);

/** Semantic spec version, e.g. "1.2.0". */
export const specVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/, 'must be a semantic version (MAJOR.MINOR.PATCH)');

export const deploymentRecordSchema = z
  .object({
    network: deploymentNetworkSchema,
    address: contractAddressSchema,
    ledger: ledgerSequenceSchema,
    specVersion: specVersionSchema,
    status: deploymentStatusSchema,
    failureReason: nonEmptyString.max(500).optional(),
  })
  .strict();

export type DeploymentRecordInput = z.infer<typeof deploymentRecordSchema>;

export const deploymentRecordParamsSchema = z
  .object({
    network: deploymentNetworkSchema,
    address: contractAddressSchema,
  })
  .strict();

export const listDeploymentsQuerySchema = z
  .object({
    network: deploymentNetworkSchema.optional(),
    status: deploymentStatusSchema.optional(),
  })
  .strict();

export type ListDeploymentsQuery = z.infer<typeof listDeploymentsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Canonical contract-event mappings (issue #219)                             */
/* -------------------------------------------------------------------------- */

/** Event schema version, e.g. "v1" or "v2". */
export const eventVersionSchema = z
  .string()
  .trim()
  .regex(/^v\d+$/, 'must be a version like "v1"');

export const eventMappingSchema = z
  .object({
    eventName: nonEmptyString.max(200),
    version: eventVersionSchema,
    projection: nonEmptyString.max(200),
    /** Unknown versions retain their raw payload instead of dropping it. */
    retainUnknownPayload: z.boolean().optional(),
  })
  .strict();

export type EventMappingInput = z.infer<typeof eventMappingSchema>;

export const eventMappingParamsSchema = z
  .object({
    eventName: nonEmptyString.max(200),
    version: eventVersionSchema,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Projection replay (issue #220)                                             */
/* -------------------------------------------------------------------------- */

export const replayStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export type ReplayStatus = z.infer<typeof replayStatusSchema>;

export const startReplayBodySchema = z
  .object({
    fromVersion: eventVersionSchema,
    toVersion: eventVersionSchema,
    fromLedger: ledgerSequenceSchema.optional(),
    toLedger: ledgerSequenceSchema.optional(),
    /** When true, compare replayed output against live state before cutover. */
    compareBeforeCutover: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.fromLedger === undefined ||
      value.toLedger === undefined ||
      value.fromLedger <= value.toLedger,
    { message: 'fromLedger must be <= toLedger', path: ['fromLedger'] },
  );

export type StartReplayInput = z.infer<typeof startReplayBodySchema>;

export const replayIdParamsSchema = z
  .object({
    replayId: idSchema,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Bounded event-consumer queues (issue #222)                                 */
/* -------------------------------------------------------------------------- */

export const MAX_QUEUE_CAPACITY = 100_000;
export const MAX_QUEUE_CONCURRENCY = 64;

export const queueConfigSchema = z
  .object({
    capacity: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_QUEUE_CAPACITY)
      .default(1_000),
    concurrency: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_QUEUE_CONCURRENCY)
      .default(8),
    /** Milliseconds to wait before retrying after an outage. */
    retryBackoffMs: z.coerce.number().int().min(0).max(300_000).default(1_000),
  })
  .strict();

export type QueueConfigInput = z.infer<typeof queueConfigSchema>;

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