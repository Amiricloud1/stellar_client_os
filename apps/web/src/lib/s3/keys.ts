import { randomUUID } from "node:crypto";
import { MAX_KEY_LENGTH, type AllowedContentType } from "./presigner";

/**
 * Safe, namespaced object key schema for milestone proof photos.
 *
 * Published evidence:
 *   evidence/{campaignId}/{milestoneId}/{uuid}.{ext}
 *
 * Quarantined (pre-scan) evidence:
 *   quarantine/evidence/{campaignId}/{milestoneId}/{uuid}.{ext}
 *
 * - `campaignId` and `milestoneId` are server-side identifiers (on-chain
 *   campaign / stream id and milestone index). They are sanitized to
 *   `[a-zA-Z0-9_-]` so they can never contain path separators or `..`.
 * - `{uuid}` is a freshly generated UUID; user-supplied file names never
 *   reach the S3 key, so directory traversal is impossible.
 * - `{ext}` is derived from a validated MIME type in the allowlist.
 *
 * Ownership binding: the prefix binds every object to a specific campaign +
 * milestone. Presign handlers MUST upload into quarantine first and MUST NOT
 * promote an object to the published prefix until scanning succeeds.
 */
export const EVIDENCE_PREFIX = "evidence";
export const QUARANTINE_PREFIX = "quarantine/evidence";

const EXTENSIONS: Record<AllowedContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

export function extensionForContentType(
  contentType: AllowedContentType
): string {
  const ext = EXTENSIONS[contentType];
  if (!ext) {
    throw new Error(`Unsupported content type: ${String(contentType)}`);
  }
  return ext;
}

/**
 * Sanitize a server-side identifier so it is safe to embed in an S3 key.
 * Strips anything outside `[a-zA-Z0-9_-]` and rejects empty results.
 */
function sanitizeId(value: string, label: string): string {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (normalized.length === 0) {
    throw new Error(`Invalid ${label} for evidence key`);
  }
  return normalized;
}

function assertValidBasename(basename: string): void {
  if (basename.length === 0 || basename.includes("/")) {
    throw new Error("Evidence key has an invalid object name");
  }

  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) {
    throw new Error("Evidence key is missing a valid extension");
  }
  const ext = basename.slice(dot + 1).toLowerCase();
  const allowedExts = new Set(Object.values(EXTENSIONS));
  if (!allowedExts.has(ext)) {
    throw new Error(`Evidence key has a disallowed extension: ${ext}`);
  }
}

/**
 * Build the expected published key prefix for a campaign + milestone.
 * Used both when generating keys and when validating caller-supplied keys.
 */
export function evidenceKeyPrefix(
  campaignId: string,
  milestoneId: string
): string {
  const campaign = sanitizeId(campaignId, "campaignId");
  const milestone = sanitizeId(milestoneId, "milestoneId");
  return `${EVIDENCE_PREFIX}/${campaign}/${milestone}/`;
}

/**
 * Build the expected quarantine key prefix for a campaign + milestone.
 * Uploaded evidence lands here until security scanning completes cleanly.
 */
export function quarantineEvidenceKeyPrefix(
  campaignId: string,
  milestoneId: string
): string {
  const campaign = sanitizeId(campaignId, "campaignId");
  const milestone = sanitizeId(milestoneId, "milestoneId");
  return `${QUARANTINE_PREFIX}/${campaign}/${milestone}/`;
}

/**
 * Build a safe, namespaced published object key for a milestone proof photo.
 *
 * @param campaignId on-chain campaign / stream id
 * @param milestoneId milestone index within the campaign
 * @param contentType validated MIME type used to derive the file extension
 */
export function buildEvidenceKey(
  campaignId: string,
  milestoneId: string,
  contentType: AllowedContentType
): string {
  const ext = extensionForContentType(contentType);
  const prefix = evidenceKeyPrefix(campaignId, milestoneId);
  const key = `${prefix}${randomUUID()}.${ext}`;

  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `Generated evidence key exceeds max length (${MAX_KEY_LENGTH})`
    );
  }
  return key;
}

/**
 * Build a safe, namespaced quarantine object key for an unscanned upload.
 *
 * @param campaignId on-chain campaign / stream id
 * @param milestoneId milestone index within the campaign
 * @param contentType validated MIME type used to derive the file extension
 */
export function buildQuarantineEvidenceKey(
  campaignId: string,
  milestoneId: string,
  contentType: AllowedContentType
): string {
  const ext = extensionForContentType(contentType);
  const prefix = quarantineEvidenceKeyPrefix(campaignId, milestoneId);
  const key = `${prefix}${randomUUID()}.${ext}`;

  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `Generated quarantine key exceeds max length (${MAX_KEY_LENGTH})`
    );
  }
  return key;
}

/**
 * Returns true when an S3 object key or URL points into the private quarantine
 * namespace. Quarantined objects must never be published directly.
 */
export function isQuarantineEvidenceKey(keyOrUrl: string): boolean {
  if (typeof keyOrUrl !== "string" || keyOrUrl.trim().length === 0) {
    return false;
  }
  const trimmed = keyOrUrl.trim();
  if (trimmed.startsWith(`${QUARANTINE_PREFIX}/`)) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/^\/+/, "");
    return pathname.startsWith(`${QUARANTINE_PREFIX}/`);
  } catch {
    return false;
  }
}

/**
 * Assert that a caller-supplied key is a well-formed published evidence key
 * bound to the expected campaign + milestone. Throws on any mismatch so
 * handlers can fail closed.
 */
export function assertEvidenceKeyPrefix(
  key: string,
  campaignId: string,
  milestoneId: string
): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Evidence key is required");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Evidence key exceeds max length (${MAX_KEY_LENGTH})`);
  }
  if (key.includes("..") || key.includes("\\")) {
    throw new Error("Evidence key contains illegal path segments");
  }

  const expectedPrefix = evidenceKeyPrefix(campaignId, milestoneId);
  if (!key.startsWith(expectedPrefix)) {
    throw new Error(
      "Evidence key does not match expected campaign/milestone prefix"
    );
  }

  const basename = key.slice(expectedPrefix.length);
  assertValidBasename(basename);
}

/**
 * Assert that a key is a well-formed quarantine evidence key bound to the
 * expected campaign + milestone.
 */
export function assertQuarantineEvidenceKeyPrefix(
  key: string,
  campaignId: string,
  milestoneId: string
): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Quarantine evidence key is required");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Evidence key exceeds max length (${MAX_KEY_LENGTH})`);
  }
  if (key.includes("..") || key.includes("\\")) {
    throw new Error("Evidence key contains illegal path segments");
  }

  const expectedPrefix = quarantineEvidenceKeyPrefix(campaignId, milestoneId);
  if (!key.startsWith(expectedPrefix)) {
    throw new Error(
      "Quarantine key does not match expected campaign/milestone prefix"
    );
  }

  const basename = key.slice(expectedPrefix.length);
  assertValidBasename(basename);
}

/**
 * Derive the published object key corresponding to a verified clean quarantine
 * key, preserving the exact campaign, milestone, UUID, and extension.
 */
export function promoteQuarantineKeyToPublished(
  quarantineKey: string,
  campaignId: string,
  milestoneId: string
): string {
  assertQuarantineEvidenceKeyPrefix(quarantineKey, campaignId, milestoneId);
  const quarantinePrefix = quarantineEvidenceKeyPrefix(campaignId, milestoneId);
  const basename = quarantineKey.slice(quarantinePrefix.length);
  return `${evidenceKeyPrefix(campaignId, milestoneId)}${basename}`;
}
