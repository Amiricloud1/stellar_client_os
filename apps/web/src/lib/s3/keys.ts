import { randomUUID } from "node:crypto";
import { MAX_KEY_LENGTH, type AllowedContentType } from "./presigner";

/**
 * Safe, namespaced object key schema for milestone proof photos.
 *
 *   evidence/{campaignId}/{milestoneId}/{uuid}.{ext}
 *
 * - `campaignId` and `milestoneId` are server-side identifiers (on-chain
 *   campaign / stream id and milestone index). They are sanitized to
 *   `[a-zA-Z0-9_-]` so they can never contain path separators or `..`.
 * - `{uuid}` is a freshly generated UUID; user-supplied file names never
 *   reach the S3 key, so directory traversal is impossible.
 * - `{ext}` is derived from a validated MIME type in the allowlist.
 *
 * Ownership binding: the prefix `evidence/{campaignId}/{milestoneId}/`
 * binds every object to a specific campaign + milestone. Presign handlers
 * MUST authorize the caller against that campaign before issuing a URL, and
 * MUST reject any caller-supplied key that does not match the expected
 * prefix (see {@link assertEvidenceKeyPrefix}).
 */
export const EVIDENCE_PREFIX = "evidence";

const EXTENSIONS: Record<AllowedContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

export function extensionForContentType(contentType: AllowedContentType): string {
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

/**
 * Build the expected key prefix for a campaign + milestone.
 * Used both when generating keys and when validating caller-supplied keys.
 */
export function evidenceKeyPrefix(campaignId: string, milestoneId: string): string {
  const campaign = sanitizeId(campaignId, "campaignId");
  const milestone = sanitizeId(milestoneId, "milestoneId");
  return `${EVIDENCE_PREFIX}/${campaign}/${milestone}/`;
}

/**
 * Build a safe, namespaced object key for a milestone proof photo.
 *
 * The key is derived entirely from server-side input (campaign/milestone ids
 * and a generated UUID) plus a validated content type, so user-supplied file
 * names never reach the S3 key and cannot traverse directories.
 *
 * @param campaignId on-chain campaign / stream id (numeric string)
 * @param milestoneId milestone index within the campaign
 * @param contentType validated MIME type used to derive the file extension
 */
export function buildEvidenceKey(
  campaignId: string,
  milestoneId: string,
  contentType: AllowedContentType,
): string {
  const ext = extensionForContentType(contentType);
  const prefix = evidenceKeyPrefix(campaignId, milestoneId);
  const key = `${prefix}${randomUUID()}.${ext}`;

  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Generated evidence key exceeds max length (${MAX_KEY_LENGTH})`);
  }
  return key;
}

/**
 * Assert that a caller-supplied key is a well-formed evidence key bound to
 * the expected campaign + milestone. Throws on any mismatch so presign
 * handlers can fail closed.
 *
 * Rejects:
 * - keys that do not start with `evidence/{campaignId}/{milestoneId}/`
 * - keys containing `..` or backslashes (traversal attempts)
 * - keys whose basename is not `{uuid}.{ext}` with an allowlisted extension
 * - keys exceeding {@link MAX_KEY_LENGTH}
 */
export function assertEvidenceKeyPrefix(
  key: string,
  campaignId: string,
  milestoneId: string,
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
    throw new Error("Evidence key does not match expected campaign/milestone prefix");
  }

  const basename = key.slice(expectedPrefix.length);
  // Basename must be a single segment: `{uuid}.{ext}`.
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