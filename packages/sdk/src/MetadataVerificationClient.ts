/**
 * MetadataVerificationClient.ts
 *
 * TypeScript SDK utilities for verifying deterministic metadata serialization
 * and versioning in the Fundable Protocol campaign-diversity contract.
 *
 * Provides:
 * - Client-side metadata hash computation
 * - Verification of metadata snapshots against contract-emitted hashes
 * - Metadata chain validation (verify ordered version sequences)
 * - Schema definition and serialization helpers
 */

import * as crypto from 'crypto';

/**
 * Metadata serialization format version.
 * Increment when schema changes; use for routing and compatibility.
 */
export const METADATA_SERIALIZATION_VERSION = 1;

/**
 * Canonical metadata schema for campaign diversity (V1).
 *
 * All fields are immutable once recorded; new snapshots increment the version.
 * Used for deterministic serialization and verification.
 */
export interface MetadataBlobV1 {
  /**
   * Campaign identifier, stable across versions.
   */
  campaign_id: number;

  /**
   * Diversity score in basis points (0-10000).
   */
  diversity_score: number;

  /**
   * Number of distinct species with verified trees.
   */
  verified_species_count: number;

  /**
   * Total number of verified trees across all species.
   */
  verified_tree_count: number;

  /**
   * Unix timestamp (seconds) of metadata snapshot.
   */
  timestamp: number;
}

/**
 * Versioned metadata blob wrapper.
 * Allows future schema versions (V2, V3, ...) without breaking parsing.
 */
export type MetadataBlob = { V1: MetadataBlobV1 };

/**
 * Serialize metadata V1 to canonical byte representation.
 *
 * Produces deterministic, reproducible output that matches contract serialization.
 * Byte layout (37 bytes total):
 * - Byte 0: 0x01 (version marker for V1)
 * - Bytes 1-8: campaign_id (little-endian u64)
 * - Bytes 9-12: diversity_score (little-endian u32)
 * - Bytes 13-20: verified_species_count (little-endian u64)
 * - Bytes 21-28: verified_tree_count (little-endian u64)
 * - Bytes 29-36: timestamp (little-endian u64)
 *
 * @param metadata - The V1 metadata blob to serialize
 * @returns A Buffer with deterministic, version-tagged content (37 bytes)
 * @throws Error if metadata fields are invalid
 */
export function serializeMetadataV1(metadata: MetadataBlobV1): Buffer {
  if (
    !Number.isInteger(metadata.campaign_id) ||
    !Number.isInteger(metadata.diversity_score) ||
    !Number.isInteger(metadata.verified_species_count) ||
    !Number.isInteger(metadata.verified_tree_count) ||
    !Number.isInteger(metadata.timestamp)
  ) {
    throw new Error('All metadata fields must be integers');
  }

  if (metadata.diversity_score < 0 || metadata.diversity_score > 10000) {
    throw new Error('Diversity score must be between 0 and 10000 basis points');
  }

  const blob = Buffer.alloc(37);
  let offset = 0;

  // Version tag (byte 0): 0x01 for V1
  blob.writeUInt8(0x01, offset);
  offset += 1;

  // campaign_id (bytes 1-8, little-endian u64)
  blob.writeBigUInt64LE(BigInt(metadata.campaign_id), offset);
  offset += 8;

  // diversity_score (bytes 9-12, little-endian u32)
  blob.writeUInt32LE(metadata.diversity_score, offset);
  offset += 4;

  // verified_species_count (bytes 13-20, little-endian u64)
  blob.writeBigUInt64LE(BigInt(metadata.verified_species_count), offset);
  offset += 8;

  // verified_tree_count (bytes 21-28, little-endian u64)
  blob.writeBigUInt64LE(BigInt(metadata.verified_tree_count), offset);
  offset += 8;

  // timestamp (bytes 29-36, little-endian u64)
  blob.writeBigUInt64LE(BigInt(metadata.timestamp), offset);

  return blob;
}

/**
 * Compute SHA256 hash of serialized metadata V1.
 *
 * The hash is deterministic and reproducible. Clients compute the same hash
 * from the same metadata values, allowing verification without re-fetching
 * contract state.
 *
 * @param metadata - The V1 metadata blob to hash
 * @returns A 32-byte SHA256 hash as hex string
 */
export function computeMetadataHashV1(metadata: MetadataBlobV1): string {
  const serialized = serializeMetadataV1(metadata);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Serialize a metadata blob (any version) to canonical bytes.
 *
 * Dispatches to the appropriate version-specific serializer based on the blob type.
 *
 * @param blob - The versioned metadata blob
 * @returns Serialized bytes
 */
export function serializeMetadataBlob(blob: MetadataBlob): Buffer {
  if ('V1' in blob) {
    return serializeMetadataV1(blob.V1);
  }
  throw new Error('Unknown metadata blob version');
}

/**
 * Compute hash of a metadata blob (any version).
 *
 * @param blob - The versioned metadata blob
 * @returns 32-byte SHA256 hash as hex string
 */
export function computeMetadataBlobHash(blob: MetadataBlob): string {
  if ('V1' in blob) {
    return computeMetadataHashV1(blob.V1);
  }
  throw new Error('Unknown metadata blob version');
}

/**
 * Verify that a candidate hash matches the expected hash for given metadata.
 *
 * Used to validate metadata snapshots retrieved from external sources.
 *
 * @param metadata - The V1 metadata blob to verify
 * @param expectedHash - The expected SHA256 hash (as hex string)
 * @returns true if hashes match, false otherwise
 */
export function verifyMetadataHash(
  metadata: MetadataBlobV1,
  expectedHash: string
): boolean {
  const computedHash = computeMetadataHashV1(metadata);
  return computedHash === expectedHash;
}

/**
 * Metadata snapshot with versioning information.
 * Used for tracking historical snapshots and verifying chains.
 */
export interface MetadataSnapshot {
  /**
   * Campaign identifier.
   */
  campaign_id: number;

  /**
   * Version number of this snapshot.
   */
  version: number;

  /**
   * Canonical SHA256 hash of serialized metadata.
   */
  hash: string;

  /**
   * Serialized metadata blob (version-specific).
   */
  metadata: MetadataBlobV1;

  /**
   * Unix timestamp of snapshot.
   */
  timestamp: number;
}

/**
 * Verify that a sequence of metadata snapshots forms a valid chain.
 *
 * Checks that:
 * - All versions are strictly increasing
 * - All hashes match their metadata
 * - Campaign IDs remain constant
 * - Timestamps are non-decreasing (monotonic)
 *
 * @param snapshots - Ordered array of metadata snapshots (oldest to newest)
 * @returns true if chain is valid, throws Error if invalid
 */
export function verifyMetadataChain(snapshots: MetadataSnapshot[]): boolean {
  if (snapshots.length === 0) {
    throw new Error('Cannot verify empty metadata chain');
  }

  let previousVersion = 0;
  let previousTimestamp = 0;
  const campaignId = snapshots[0].campaign_id;

  for (const snapshot of snapshots) {
    // Campaign ID must remain constant
    if (snapshot.campaign_id !== campaignId) {
      throw new Error(
        `Campaign ID mismatch in chain: expected ${campaignId}, got ${snapshot.campaign_id}`
      );
    }

    // Versions must be strictly increasing
    if (snapshot.version <= previousVersion) {
      throw new Error(
        `Version not strictly increasing: ${previousVersion} → ${snapshot.version}`
      );
    }

    // Timestamps must be non-decreasing (monotonic)
    if (snapshot.timestamp < previousTimestamp) {
      throw new Error(
        `Timestamp went backwards: ${previousTimestamp} → ${snapshot.timestamp}`
      );
    }

    // Hash must match metadata
    if (!verifyMetadataHash(snapshot.metadata, snapshot.hash)) {
      throw new Error(
        `Metadata hash mismatch at version ${snapshot.version}: computed ${computeMetadataHashV1(snapshot.metadata)}, got ${snapshot.hash}`
      );
    }

    previousVersion = snapshot.version;
    previousTimestamp = snapshot.timestamp;
  }

  return true;
}

/**
 * Generate a summary of metadata changes across a chain of snapshots.
 *
 * Useful for auditing and understanding which fields changed and when.
 *
 * @param snapshots - Ordered array of metadata snapshots
 * @returns Array of change summaries with before/after values
 */
export interface MetadataChangeSummary {
  from_version: number;
  to_version: number;
  timestamp: number;
  field_changes: {
    diversity_score?: { from: number; to: number };
    verified_species_count?: { from: number; to: number };
    verified_tree_count?: { from: number; to: number };
  };
}

export function summarizeMetadataChanges(snapshots: MetadataSnapshot[]): MetadataChangeSummary[] {
  if (snapshots.length < 2) {
    return [];
  }

  const changes: MetadataChangeSummary[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].metadata;
    const curr = snapshots[i].metadata;

    const field_changes: MetadataChangeSummary['field_changes'] = {};

    if (prev.diversity_score !== curr.diversity_score) {
      field_changes.diversity_score = {
        from: prev.diversity_score,
        to: curr.diversity_score,
      };
    }

    if (prev.verified_species_count !== curr.verified_species_count) {
      field_changes.verified_species_count = {
        from: prev.verified_species_count,
        to: curr.verified_species_count,
      };
    }

    if (prev.verified_tree_count !== curr.verified_tree_count) {
      field_changes.verified_tree_count = {
        from: prev.verified_tree_count,
        to: curr.verified_tree_count,
      };
    }

    // Only add to summary if there were actual changes
    if (Object.keys(field_changes).length > 0) {
      changes.push({
        from_version: snapshots[i - 1].version,
        to_version: snapshots[i].version,
        timestamp: snapshots[i].timestamp,
        field_changes,
      });
    }
  }

  return changes;
}

/**
 * Serialize metadata to canonical JSON format for transmission.
 *
 * Useful for storing metadata in databases or JSON logs while maintaining
 * reproducibility.
 *
 * @param metadata - The metadata blob
 * @returns JSON string with deterministic field ordering
 */
export function metadataToJSON(metadata: MetadataBlobV1): string {
  // Use sorted keys to ensure deterministic JSON
  const obj = {
    campaign_id: metadata.campaign_id,
    diversity_score: metadata.diversity_score,
    timestamp: metadata.timestamp,
    verified_species_count: metadata.verified_species_count,
    verified_tree_count: metadata.verified_tree_count,
  };
  return JSON.stringify(obj);
}

/**
 * Parse metadata from JSON format.
 *
 * @param json - JSON string containing metadata
 * @returns Parsed MetadataBlobV1
 * @throws Error if JSON is invalid or missing required fields
 */
export function metadataFromJSON(json: string): MetadataBlobV1 {
  const obj = JSON.parse(json);

  if (
    typeof obj.campaign_id !== 'number' ||
    typeof obj.diversity_score !== 'number' ||
    typeof obj.verified_species_count !== 'number' ||
    typeof obj.verified_tree_count !== 'number' ||
    typeof obj.timestamp !== 'number'
  ) {
    throw new Error('Invalid metadata JSON: missing or wrong type for required fields');
  }

  return {
    campaign_id: obj.campaign_id,
    diversity_score: obj.diversity_score,
    verified_species_count: obj.verified_species_count,
    verified_tree_count: obj.verified_tree_count,
    timestamp: obj.timestamp,
  };
}

/**
 * Get human-readable description of metadata versioning semantics.
 *
 * Useful for documentation and client libraries.
 */
export const METADATA_VERSIONING_SEMANTICS = {
  description: 'Campaign diversity metadata versioning and serialization',
  version: METADATA_SERIALIZATION_VERSION,
  fields: {
    campaign_id: 'Campaign identifier, stable across versions',
    diversity_score: 'Diversity score in basis points (0-10000)',
    verified_species_count: 'Number of distinct species with verified trees',
    verified_tree_count: 'Total number of verified trees across all species',
    timestamp: 'Unix timestamp (seconds) of metadata snapshot',
  },
  when_version_increments: [
    'On score recalculation (rescore_campaign)',
    'On batch tree verification (verified tree count changes)',
    'On batch tree rejection (verified tree count changes)',
    'On campaign seal',
  ],
  byte_layout: {
    total_size: 37,
    byte_0: '0x01 (version marker for V1)',
    bytes_1_8: 'campaign_id (little-endian u64)',
    bytes_9_12: 'diversity_score (little-endian u32)',
    bytes_13_20: 'verified_species_count (little-endian u64)',
    bytes_21_28: 'verified_tree_count (little-endian u64)',
    bytes_29_36: 'timestamp (little-endian u64)',
  },
};
