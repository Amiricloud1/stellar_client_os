/**
 * Webhook event payload schema validation for Fundable Webhook Delivery System (v1).
 * Validates versioned event envelopes and event-type-specific payload shapes.
 */

export interface WebhookEventEnvelope<T = Record<string, unknown>> {
  eventVersion: number;
  eventId: string;
  eventType: string;
  subscriptionId?: string;
  deliveredAt?: string;
  payload: T;
}

export const SUPPORTED_EVENT_TYPES = [
  "stream.status_updated",
  "milestone.funds_released",
  "campaign.milestone_reached",
  "tree_verified",
  "batch_verified",
  "campaign_completed",
] as const;

export type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWebhookEnvelope(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { valid: false, errors: ["Payload must be a non-null object"] };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.eventVersion !== "number" || obj.eventVersion !== 1) {
    errors.push("eventVersion must be 1");
  }

  if (typeof obj.eventId !== "string" || obj.eventId.trim().length === 0) {
    errors.push("eventId must be a non-empty string");
  }

  if (
    typeof obj.eventType !== "string" ||
    !SUPPORTED_EVENT_TYPES.includes(obj.eventType as SupportedEventType)
  ) {
    errors.push(
      `eventType must be one of: ${SUPPORTED_EVENT_TYPES.join(", ")}`
    );
  }

  if (
    typeof obj.payload !== "object" ||
    obj.payload === null ||
    Array.isArray(obj.payload)
  ) {
    errors.push("payload must be a non-null object");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateEventPayload(
  envelope: WebhookEventEnvelope
): ValidationResult {
  const envelopeValidation = validateWebhookEnvelope(envelope);
  if (!envelopeValidation.valid) {
    return envelopeValidation;
  }

  const errors: string[] = [];
  const payload = envelope.payload as Record<string, unknown>;

  switch (envelope.eventType) {
    case "stream.status_updated":
      if (
        typeof payload.streamId !== "string" ||
        payload.streamId.trim().length === 0
      ) {
        errors.push(
          "stream.status_updated requires streamId (non-empty string)"
        );
      }
      if (
        typeof payload.status !== "string" ||
        payload.status.trim().length === 0
      ) {
        errors.push("stream.status_updated requires status (non-empty string)");
      }
      break;

    case "milestone.funds_released":
      if (
        typeof payload.campaignId !== "string" ||
        payload.campaignId.trim().length === 0
      ) {
        errors.push(
          "milestone.funds_released requires campaignId (non-empty string)"
        );
      }
      if (
        typeof payload.percentage !== "number" ||
        payload.percentage < 0 ||
        payload.percentage > 100
      ) {
        errors.push(
          "milestone.funds_released requires percentage (number between 0 and 100)"
        );
      }
      if (
        typeof payload.releasedAmount !== "string" &&
        typeof payload.releasedAmount !== "number"
      ) {
        errors.push(
          "milestone.funds_released requires releasedAmount (string or number)"
        );
      }
      break;

    case "campaign.milestone_reached":
      if (
        typeof payload.campaignId !== "string" ||
        payload.campaignId.trim().length === 0
      ) {
        errors.push(
          "campaign.milestone_reached requires campaignId (non-empty string)"
        );
      }
      if (
        typeof payload.milestone !== "string" ||
        payload.milestone.trim().length === 0
      ) {
        errors.push(
          "campaign.milestone_reached requires milestone (non-empty string)"
        );
      }
      break;

    case "tree_verified":
      if (
        typeof payload.campaignId !== "string" ||
        payload.campaignId.trim().length === 0
      ) {
        errors.push("tree_verified requires campaignId (non-empty string)");
      }
      if (
        typeof payload.treeId !== "string" ||
        payload.treeId.trim().length === 0
      ) {
        errors.push("tree_verified requires treeId (non-empty string)");
      }
      if (
        typeof payload.verifierId !== "string" ||
        payload.verifierId.trim().length === 0
      ) {
        errors.push("tree_verified requires verifierId (non-empty string)");
      }
      break;

    case "batch_verified":
      if (
        typeof payload.campaignId !== "string" ||
        payload.campaignId.trim().length === 0
      ) {
        errors.push("batch_verified requires campaignId (non-empty string)");
      }
      if (!Array.isArray(payload.treeIds) || payload.treeIds.length === 0) {
        errors.push("batch_verified requires treeIds (non-empty array)");
      }
      if (typeof payload.treeCount !== "number" || payload.treeCount <= 0) {
        errors.push("batch_verified requires treeCount (positive number)");
      }
      break;

    case "campaign_completed":
      if (
        typeof payload.campaignId !== "string" ||
        payload.campaignId.trim().length === 0
      ) {
        errors.push(
          "campaign_completed requires campaignId (non-empty string)"
        );
      }
      if (
        typeof payload.completedAt !== "string" ||
        payload.completedAt.trim().length === 0
      ) {
        errors.push("campaign_completed requires completedAt (string)");
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
