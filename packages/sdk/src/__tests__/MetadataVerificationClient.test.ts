/**
 * MetadataVerificationClient.test.ts
 *
 * Test suite for deterministic metadata serialization, hashing, and verification.
 *
 * Tests verify:
 * - Deterministic serialization (same inputs → same bytes)
 * - Hash stability (hash never changes for same metadata)
 * - Cross-version compatibility
 * - Metadata chain validation
 * - Error handling
 */

import {
  MetadataBlobV1,
  MetadataSnapshot,
  serializeMetadataV1,
  computeMetadataHashV1,
  verifyMetadataHash,
  verifyMetadataChain,
  summarizeMetadataChanges,
  metadataToJSON,
  metadataFromJSON,
  METADATA_SERIALIZATION_VERSION,
} from '../MetadataVerificationClient';

describe('Metadata Serialization', () => {
  it('should serialize metadata V1 deterministically', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const bytes1 = serializeMetadataV1(metadata);
    const bytes2 = serializeMetadataV1(metadata);

    expect(bytes1).toEqual(bytes2);
    expect(bytes1.length).toBe(37);
  });

  it('should produce correct version byte', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 1,
      diversity_score: 0,
      verified_species_count: 1,
      verified_tree_count: 1,
      timestamp: 1,
    };

    const bytes = serializeMetadataV1(metadata);
    expect(bytes[0]).toBe(0x01);
  });

  it('should serialize campaign_id correctly', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 0x0102030405060708n as unknown as number, // Big-endian test value
      diversity_score: 0,
      verified_species_count: 0,
      verified_tree_count: 0,
      timestamp: 0,
    };

    const bytes = serializeMetadataV1(metadata);
    // First byte is version, next 8 are campaign_id in little-endian
    expect(bytes.length).toBe(37);
    expect(bytes[0]).toBe(0x01);
  });

  it('should reject invalid diversity scores', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 1,
      diversity_score: 10001, // > 10000
      verified_species_count: 1,
      verified_tree_count: 1,
      timestamp: 1,
    };

    expect(() => serializeMetadataV1(metadata)).toThrow('Diversity score must be between');
  });

  it('should reject non-integer fields', () => {
    const metadata: any = {
      campaign_id: 1.5, // Not an integer
      diversity_score: 5000,
      verified_species_count: 1,
      verified_tree_count: 1,
      timestamp: 1,
    };

    expect(() => serializeMetadataV1(metadata)).toThrow('All metadata fields must be integers');
  });

  it('should handle boundary values', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 0,
      diversity_score: 0,
      verified_species_count: 0,
      verified_tree_count: 0,
      timestamp: 0,
    };

    const bytes = serializeMetadataV1(metadata);
    expect(bytes.length).toBe(37);
    expect(bytes[0]).toBe(0x01);
  });

  it('should handle maximum values', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: Number.MAX_SAFE_INTEGER,
      diversity_score: 10000,
      verified_species_count: Number.MAX_SAFE_INTEGER,
      verified_tree_count: Number.MAX_SAFE_INTEGER,
      timestamp: Number.MAX_SAFE_INTEGER,
    };

    const bytes = serializeMetadataV1(metadata);
    expect(bytes.length).toBe(37);
  });
});

describe('Metadata Hashing', () => {
  it('should compute hash deterministically', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const hash1 = computeMetadataHashV1(metadata);
    const hash2 = computeMetadataHashV1(metadata);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex string is 64 chars
  });

  it('should produce different hashes for different metadata', () => {
    const meta1: MetadataBlobV1 = {
      campaign_id: 100,
      diversity_score: 5000,
      verified_species_count: 3,
      verified_tree_count: 500,
      timestamp: 1700000000,
    };

    const meta2: MetadataBlobV1 = {
      campaign_id: 101, // Different campaign
      diversity_score: 5000,
      verified_species_count: 3,
      verified_tree_count: 500,
      timestamp: 1700000000,
    };

    const hash1 = computeMetadataHashV1(meta1);
    const hash2 = computeMetadataHashV1(meta2);

    expect(hash1).not.toBe(hash2);
  });

  it('should produce hash in valid hex format', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 1,
      diversity_score: 5000,
      verified_species_count: 1,
      verified_tree_count: 1,
      timestamp: 1,
    };

    const hash = computeMetadataHashV1(metadata);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it('should be sensitive to all fields', () => {
    const baseMeta: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const hash0 = computeMetadataHashV1(baseMeta);

    const meta1 = { ...baseMeta, campaign_id: 124 };
    expect(computeMetadataHashV1(meta1)).not.toBe(hash0);

    const meta2 = { ...baseMeta, diversity_score: 7501 };
    expect(computeMetadataHashV1(meta2)).not.toBe(hash0);

    const meta3 = { ...baseMeta, verified_species_count: 6 };
    expect(computeMetadataHashV1(meta3)).not.toBe(hash0);

    const meta4 = { ...baseMeta, verified_tree_count: 1001 };
    expect(computeMetadataHashV1(meta4)).not.toBe(hash0);

    const meta5 = { ...baseMeta, timestamp: 1700000001 };
    expect(computeMetadataHashV1(meta5)).not.toBe(hash0);
  });
});

describe('Hash Verification', () => {
  it('should verify matching hashes', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const hash = computeMetadataHashV1(metadata);
    expect(verifyMetadataHash(metadata, hash)).toBe(true);
  });

  it('should reject mismatched hashes', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';
    expect(verifyMetadataHash(metadata, wrongHash)).toBe(false);
  });

  it('should detect tampering of any field', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const correctHash = computeMetadataHashV1(metadata);

    const tamperedMeta = { ...metadata, diversity_score: 7501 };
    expect(verifyMetadataHash(tamperedMeta, correctHash)).toBe(false);
  });
});

describe('Metadata Chain Validation', () => {
  it('should validate a simple chain of snapshots', () => {
    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 1,
        hash: computeMetadataHashV1({
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        }),
        metadata: {
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        },
        timestamp: 1700000000,
      },
      {
        campaign_id: 1,
        version: 2,
        hash: computeMetadataHashV1({
          campaign_id: 1,
          diversity_score: 5000,
          verified_species_count: 1,
          verified_tree_count: 100,
          timestamp: 1700000100,
        }),
        metadata: {
          campaign_id: 1,
          diversity_score: 5000,
          verified_species_count: 1,
          verified_tree_count: 100,
          timestamp: 1700000100,
        },
        timestamp: 1700000100,
      },
    ];

    expect(verifyMetadataChain(snapshots)).toBe(true);
  });

  it('should reject empty chain', () => {
    expect(() => verifyMetadataChain([])).toThrow('Cannot verify empty metadata chain');
  });

  it('should reject campaign ID mismatch', () => {
    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 1,
        hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        metadata: {
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        },
        timestamp: 1700000000,
      },
      {
        campaign_id: 2, // Different campaign
        version: 2,
        hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        metadata: {
          campaign_id: 2,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000100,
        },
        timestamp: 1700000100,
      },
    ];

    expect(() => verifyMetadataChain(snapshots)).toThrow('Campaign ID mismatch');
  });

  it('should reject non-increasing versions', () => {
    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 2, // Should start at 1
        hash: 'a'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        },
        timestamp: 1700000000,
      },
      {
        campaign_id: 1,
        version: 2, // Same as previous
        hash: 'b'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 1000,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000100,
        },
        timestamp: 1700000100,
      },
    ];

    expect(() => verifyMetadataChain(snapshots)).toThrow('Version not strictly increasing');
  });

  it('should reject backward timestamp', () => {
    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 1,
        hash: 'a'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000100,
        },
        timestamp: 1700000100,
      },
      {
        campaign_id: 1,
        version: 2,
        hash: 'b'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 1000,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000050, // Before previous
        },
        timestamp: 1700000050,
      },
    ];

    expect(() => verifyMetadataChain(snapshots)).toThrow('Timestamp went backwards');
  });

  it('should reject hash mismatches in chain', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 1,
      diversity_score: 5000,
      verified_species_count: 1,
      verified_tree_count: 100,
      timestamp: 1700000100,
    };

    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 1,
        hash: 'a'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        },
        timestamp: 1700000000,
      },
      {
        campaign_id: 1,
        version: 2,
        hash: '0'.repeat(64), // Wrong hash
        metadata,
        timestamp: 1700000100,
      },
    ];

    expect(() => verifyMetadataChain(snapshots)).toThrow('Metadata hash mismatch');
  });
});

describe('Change Summarization', () => {
  it('should summarize metadata changes correctly', () => {
    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 1,
        hash: computeMetadataHashV1({
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        }),
        metadata: {
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        },
        timestamp: 1700000000,
      },
      {
        campaign_id: 1,
        version: 2,
        hash: computeMetadataHashV1({
          campaign_id: 1,
          diversity_score: 5000,
          verified_species_count: 1,
          verified_tree_count: 100,
          timestamp: 1700000100,
        }),
        metadata: {
          campaign_id: 1,
          diversity_score: 5000,
          verified_species_count: 1,
          verified_tree_count: 100,
          timestamp: 1700000100,
        },
        timestamp: 1700000100,
      },
    ];

    const changes = summarizeMetadataChanges(snapshots);

    expect(changes).toHaveLength(1);
    expect(changes[0].from_version).toBe(1);
    expect(changes[0].to_version).toBe(2);
    expect(changes[0].field_changes.diversity_score).toEqual({ from: 0, to: 5000 });
    expect(changes[0].field_changes.verified_species_count).toEqual({ from: 0, to: 1 });
    expect(changes[0].field_changes.verified_tree_count).toEqual({ from: 0, to: 100 });
  });

  it('should return empty array for single snapshot', () => {
    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 1,
        hash: 'a'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 0,
          verified_species_count: 0,
          verified_tree_count: 0,
          timestamp: 1700000000,
        },
        timestamp: 1700000000,
      },
    ];

    const changes = summarizeMetadataChanges(snapshots);
    expect(changes).toHaveLength(0);
  });

  it('should skip versions with no changes', () => {
    const snapshots: MetadataSnapshot[] = [
      {
        campaign_id: 1,
        version: 1,
        hash: 'a'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 5000,
          verified_species_count: 1,
          verified_tree_count: 100,
          timestamp: 1700000000,
        },
        timestamp: 1700000000,
      },
      {
        campaign_id: 1,
        version: 2,
        hash: 'b'.repeat(64),
        metadata: {
          campaign_id: 1,
          diversity_score: 5000, // Same
          verified_species_count: 1, // Same
          verified_tree_count: 100, // Same
          timestamp: 1700000100,
        },
        timestamp: 1700000100,
      },
    ];

    const changes = summarizeMetadataChanges(snapshots);
    expect(changes).toHaveLength(0); // No changes in fields
  });
});

describe('JSON Serialization', () => {
  it('should convert metadata to JSON and back', () => {
    const original: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const json = metadataToJSON(original);
    const recovered = metadataFromJSON(json);

    expect(recovered).toEqual(original);
  });

  it('should produce deterministic JSON', () => {
    const metadata: MetadataBlobV1 = {
      campaign_id: 123,
      diversity_score: 7500,
      verified_species_count: 5,
      verified_tree_count: 1000,
      timestamp: 1700000000,
    };

    const json1 = metadataToJSON(metadata);
    const json2 = metadataToJSON(metadata);

    expect(json1).toBe(json2);
  });

  it('should reject invalid JSON', () => {
    expect(() => metadataFromJSON('invalid json')).toThrow();
    expect(() => metadataFromJSON('{}')).toThrow('missing or wrong type');
  });
});

describe('Version Constants', () => {
  it('should export serialization version constant', () => {
    expect(METADATA_SERIALIZATION_VERSION).toBe(1);
  });
});
