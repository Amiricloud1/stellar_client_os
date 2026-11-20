/**
 * MetadataVerificationClient
 *
 * TypeScript utilities for verifying and working with deterministic metadata
 * serialization from the campaign-diversity contract.
 *
 * Provides client-side computation of metadata hashes and verification of
 * blockchain-stored metadata using the same canonical format.
 */

import * as crypto from 'crypto';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Metadata blob in V1 format (canonical serialization).
 *
 * All numeric fields use little-endian byte order for consistency with
 * contract serialization.
 */
export interface MetadataV1 {
  /** Campaign identifier */
  campaignId: bigint;

  /** Diversity score in basis points (0..10_000) */
  diversityScore: number;

  /** Number of distinct verified species */
  speciesCount: number;

  /** Total verified trees across all species */
  verifiedTreeCount: bigint;

  /** Unix timestamp (seconds) of last state change */
  updatedAt: bigint;

  /** Schema version indicator (always 1 for V1) */
  version: number;
}

/**
 * Result of metadata verification.
 */
export interface VerificationResult {
  /** Whether verification succeeded */
  valid: boolean;

  /** Expected hash (from contract or client-side computation) */
  expectedHash: string;

  /** Actual hash of the provided metadata */
  actualHash: string;

  /** Detailed message */
  message: string;
}

/**
 * Verification result for an update sequence.
 */
export interface SequenceVerificationResult {
  /** Whether sequence is valid */
  valid: boolean;

  /** Earlier version number */
  v1: bigint;

  /** Later version number */
  v2: bigint;

  /** Reason for failure (if invalid) */
  reason?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Metadata V1 format version byte */
const METADATA_VERSION_V1 = 0x01;

/** Expected serialized length for V1 metadata (33 bytes) */
const SERIALIZED_LENGTH_V1 = 33;

/** Expected length of SHA-256 hash (32 bytes) */
const HASH_LENGTH = 32;

// ============================================================================
// Core Serialization Functions
// ============================================================================

/**
 * Serialize metadata V1 into canonical bytes.
 *
 * Byte layout (little-endian for all numeric fields):
 * - [0]: Version byte (0x01 for V1)
 * - [1..9]: campaign_id (u64, little-endian)
 * - [9..13]: diversity_score (u32, little-endian)
 * - [13..17]: species_count (u32, little-endian)
 * - [17..25]: verified_tree_count (u64, little-endian)
 * - [25..33]: updated_at (u64, little-endian)
 *
 * Total: 33 bytes
 *
 * @param metadata The V1 metadata to serialize
 * @returns 33-byte Buffer containing serialized metadata
 */
export function serializeMetadataV1(metadata: MetadataV1): Buffer {
  const buffer = Buffer.alloc(SERIALIZED_LENGTH_V1);
  let offset = 0;

  // Version byte
  buffer[offset++] = METADATA_VERSION_V1;

  // campaign_id: u64 (little-endian)
  serializeU64(buffer, offset, metadata.campaignId);
  offset += 8;

  // diversity_score: u32 (little-endian)
  serializeU32(buffer, offset, metadata.diversityScore);
  offset += 4;

  // species_count: u32 (little-endian)
  serializeU32(buffer, offset, metadata.speciesCount);
  offset += 4;

  // verified_tree_count: u64 (little-endian)
  serializeU64(buffer, offset, metadata.verifiedTreeCount);
  offset += 8;

  // updated_at: u64 (little-endian)
  serializeU64(buffer, offset, metadata.updatedAt);
  offset += 8;

  return buffer;
}

/**
 * Serialize all metadata fields for a campaign.
 *
 * Includes metadata with field count for extensibility:
 * - [0]: Version byte (0x01)
 * - [1..5]: field_count (u32, little-endian) = 6 for V1
 * - [5..]: All V1 fields
 *
 * Total: 37 bytes
 *
 * @param metadata The metadata to serialize
 * @returns Buffer containing extended serialization
 */
export function serializeAllMetadataForCampaign(metadata: MetadataV1): Buffer {
  const buffer = Buffer.alloc(37);
  let offset = 0;

  // Version byte
  buffer[offset++] = METADATA_VERSION_V1;

  // Field count (6 fields for V1)
  serializeU32(buffer, offset, 6);
  offset += 4;

  // campaign_id
  serializeU64(buffer, offset, metadata.campaignId);
  offset += 8;

  // diversity_score
  serializeU32(buffer, offset, metadata.diversityScore);
  offset += 4;

  // species_count
  serializeU32(buffer, offset, metadata.speciesCount);
  offset += 4;

  // verified_tree_count
  serializeU64(buffer, offset, metadata.verifiedTreeCount);
  offset += 8;

  // updated_at
  serializeU64(buffer, offset, metadata.updatedAt);

  return buffer;
}

/**
 * Compute SHA-256 hash of serialized metadata.
 *
 * This is the canonical content hash: same metadata always hashes to the
 * same value.
 *
 * @param metadata The metadata to hash
 * @returns 32-byte hex string of SHA-256 hash
 */
export function computeMetadataHash(metadata: MetadataV1): string {
  const serialized = serializeMetadataV1(metadata);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Compute hash from pre-serialized bytes.
 *
 * @param serialized The serialized metadata bytes
 * @returns 32-byte hex string of SHA-256 hash
 */
export function computeHashFromBytes(serialized: Buffer): string {
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// ============================================================================
// Deserialization Functions (for verification)
// ============================================================================

/**
 * Deserialize V1 metadata from canonical bytes.
 *
 * @param buffer The 33-byte serialized metadata
 * @returns Deserialized MetadataV1, or null if format is invalid
 */
export function deserializeMetadataV1(buffer: Buffer): MetadataV1 | null {
  if (!buffer || buffer.length !== SERIALIZED_LENGTH_V1) {
    return null;
  }

  const version = buffer[0];
  if (version !== METADATA_VERSION_V1) {
    return null;
  }

  try {
    const campaignId = deserializeU64(buffer, 1);
    const diversityScore = deserializeU32(buffer, 9);
    const speciesCount = deserializeU32(buffer, 13);
    const verifiedTreeCount = deserializeU64(buffer, 17);
    const updatedAt = deserializeU64(buffer, 25);

    return {
      campaignId,
      diversityScore,
      speciesCount,
      verifiedTreeCount,
      updatedAt,
      version: METADATA_VERSION_V1,
    };
  } catch {
    return null;
  }
}

/**
 * Deserialize a u64 in little-endian from a buffer at offset.
 */
function deserializeU64(buffer: Buffer, offset: number): bigint {
  if (offset + 8 > buffer.length) {
    throw new Error('Buffer too short for u64');
  }

  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(buffer[offset + i]) << BigInt(i * 8);
  }

  return value;
}

/**
 * Deserialize a u32 in little-endian from a buffer at offset.
 */
function deserializeU32(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) {
    throw new Error('Buffer too short for u32');
  }

  let value = 0;
  for (let i = 0; i < 4; i++) {
    value |= buffer[offset + i] << (i * 8);
  }

  return value;
}

// ============================================================================
// Helper Serialization Functions (little-endian)
// ============================================================================

/**
 * Write a u64 in little-endian byte order to a buffer.
 */
function serializeU64(buffer: Buffer, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buffer[offset + i] = Number((value >> BigInt(i * 8)) & 0xFFn);
  }
}

/**
 * Write a u32 in little-endian byte order to a buffer.
 */
function serializeU32(buffer: Buffer, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

// ============================================================================
// Verification Functions
// ============================================================================

/**
 * Verify that metadata matches an expected hash.
 *
 * @param metadata The metadata to verify
 * @param expectedHash The expected SHA-256 hash (hex string)
 * @returns VerificationResult with validity and details
 */
export function verifyMetadataHash(
  metadata: MetadataV1,
  expectedHash: string
): VerificationResult {
  const actualHash = computeMetadataHash(metadata);
  const valid = actualHash.toLowerCase() === expectedHash.toLowerCase();

  return {
    valid,
    expectedHash: expectedHash.toLowerCase(),
    actualHash: actualHash.toLowerCase(),
    message: valid
      ? 'Metadata hash verification passed'
      : 'Metadata hash verification failed: hash mismatch',
  };
}

/**
 * Verify that metadata bytes have correct structure.
 *
 * @param buffer The serialized metadata buffer
 * @returns VerificationResult with validity
 */
export function verifyMetadataBytes(buffer: Buffer): VerificationResult {
  // Check length
  if (!buffer || buffer.length !== SERIALIZED_LENGTH_V1) {
    return {
      valid: false,
      expectedHash: '',
      actualHash: '',
      message: `Invalid buffer length: expected ${SERIALIZED_LENGTH_V1}, got ${buffer?.length}`,
    };
  }

  // Check version byte
  if (buffer[0] !== METADATA_VERSION_V1) {
    return {
      valid: false,
      expectedHash: '',
      actualHash: '',
      message: `Invalid version byte: expected ${METADATA_VERSION_V1}, got ${buffer[0]}`,
    };
  }

  // Try deserialization
  const metadata = deserializeMetadataV1(buffer);
  if (!metadata) {
    return {
      valid: false,
      expectedHash: '',
      actualHash: '',
      message: 'Failed to deserialize metadata',
    };
  }

  return {
    valid: true,
    expectedHash: '',
    actualHash: computeHashFromBytes(buffer),
    message: 'Metadata bytes are valid',
  };
}

/**
 * Verify a sequence of metadata updates.
 *
 * Ensures that updates follow a valid ordering and no version numbers are
 * repeated.
 *
 * @param snapshots Array of { version, metadata } snapshots
 * @returns SequenceVerificationResult
 */
export function verifyMetadataChain(
  snapshots: Array<{ version: bigint; metadata: MetadataV1 }>
): SequenceVerificationResult[] {
  const results: SequenceVerificationResult[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];

    const valid = prev.version < curr.version;
    const result: SequenceVerificationResult = {
      valid,
      v1: prev.version,
      v2: curr.version,
    };

    if (!valid) {
      result.reason = `Version not strictly increasing: ${prev.version} -> ${curr.version}`;
    }

    results.push(result);
  }

  return results;
}

/**
 * Verify a single update transition.
 *
 * @param v1 Earlier version
 * @param v2 Later version
 * @returns SequenceVerificationResult
 */
export function verifyUpdateSequence(
  v1: bigint,
  v2: bigint
): SequenceVerificationResult {
  const valid = v1 < v2 && v1 > 0n && v2 > 0n;

  return {
    valid,
    v1,
    v2,
    reason: valid ? undefined : 'Version sequence is invalid',
  };
}

// ============================================================================
// Metadata Creation Helpers
// ============================================================================

/**
 * Create metadata from campaign state.
 *
 * Typically called when reading contract state and building metadata locally.
 *
 * @param campaignId Campaign identifier
 * @param diversityScore Diversity score (0..10_000)
 * @param speciesCount Number of verified species
 * @param verifiedTreeCount Total verified trees
 * @param updatedAt Unix timestamp (seconds)
 * @returns MetadataV1 object
 */
export function createMetadata(
  campaignId: bigint,
  diversityScore: number,
  speciesCount: number,
  verifiedTreeCount: bigint,
  updatedAt: bigint
): MetadataV1 {
  return {
    campaignId,
    diversityScore,
    speciesCount,
    verifiedTreeCount,
    updatedAt,
    version: METADATA_VERSION_V1,
  };
}

// ============================================================================
// Schema Export
// ============================================================================

/**
 * Export metadata schema information for documentation.
 */
export const MetadataSchema = {
  version: METADATA_VERSION_V1,
  serializedLength: SERIALIZED_LENGTH_V1,
  layout: {
    versionByte: { offset: 0, length: 1, type: 'u8' },
    campaignId: { offset: 1, length: 8, type: 'u64' },
    diversityScore: { offset: 9, length: 4, type: 'u32' },
    speciesCount: { offset: 13, length: 4, type: 'u32' },
    verifiedTreeCount: { offset: 17, length: 8, type: 'u64' },
    updatedAt: { offset: 25, length: 8, type: 'u64' },
  },
  byteOrder: 'little-endian',
  hashAlgorithm: 'SHA-256',
};

/**
 * Export version information.
 */
export const VersionInfo = {
  METADATA_VERSION_V1: METADATA_VERSION_V1,
  SERIALIZED_LENGTH_V1: SERIALIZED_LENGTH_V1,
  HASH_LENGTH: HASH_LENGTH,
};
